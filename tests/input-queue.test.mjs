import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AttachmentStore } from '../packages/agent/src/attachmentStore.ts';
import { DurableInputQueue } from '../packages/agent/src/inputQueue.ts';

class Queue {
  messages = []; enqueue(message) { this.messages.push(message); } peek() { return this.messages.slice(0, 1); }
  drain() { const batch = this.peek(); this.messages = this.messages.slice(batch.length); return batch; }
  clear() { this.messages = []; } hasItems() { return this.messages.length > 0; }
}
const textAttachmentMarker = '\n\n<!-- pi-desktop:attachments-v1 -->\n';
function setup(root) {
  const session = { isIdle: false, agent: { steeringQueue: new Queue(), followUpQueue: new Queue() }, _steeringMessages: [], _followUpMessages: [], _emitQueueUpdate() {}, async _runAgentPrompt() { throw new Error('Not an inference test'); } };
  let current; const storage = new AttachmentStore(join(root, 'attachments'));
  const scope = { cwd: root, sessionPath: join(root, 'session.jsonl') };
  const queue = new DurableInputQueue(session, scope, join(root, 'queue'), storage, { currentInput: () => current, preview: message => ({ text: message.content[0].text.split(textAttachmentMarker, 1)[0], attachments: current?.attachments.map(({ kind, name, mimeType }) => ({ kind, name, mimeType })) ?? message.content.slice(1).map(part => ({ kind: 'image', name: 'image.png', mimeType: part.mimeType })) }), changed() {}, resume() {}, error() {} });
  const submitContent = (text, attachments = [], behavior = 'followUp', id = randomUUID()) => {
    current = { id, sessionId: 'session', text, behavior, attachments };
    const files = attachments.filter(item => item.kind === 'text');
    const preparedText = text + (files.length ? textAttachmentMarker + files.map(file => `<attached-file name="${encodeURIComponent(file.name)}" mime="${encodeURIComponent(file.mimeType)}" length="${file.text.length}">\n${file.text}\n</attached-file>\n`).join('') : '');
    const request = structuredClone(current), previous = queue.begin(request, preparedText);
    if (!previous) { session.agent[behavior === 'steer' ? 'steeringQueue' : 'followUpQueue'].enqueue({ role: 'user', content: [{ type: 'text', text: preparedText }, ...attachments.filter(item => item.kind === 'image').map(({ mimeType, data }) => ({ type: 'image', mimeType, data }))], timestamp: 42 }); queue.acknowledge(id); }
    current = undefined; return request;
  };
  const submit = (text, data, id = randomUUID()) => submitContent(text, [{ kind: 'image', name: 'same.png', mimeType: 'image/png', data }], 'followUp', id);
  const mutate = patch => queue.mutate({ requestId: randomUUID(), expectedVersion: queue.snapshot().version, ...patch });
  return { queue, session, submit, submitContent, mutate, storage, scope };
}

test('stable IDs preserve all image payloads across edit, remove, order and consumption', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-input-queue-'));
  try {
    const { queue, session, submit, mutate } = setup(root);
    const first = submit('same', 'YQ=='), second = submit('same', 'Yg==');
    assert.equal(session.agent.followUpQueue.peek().length, 1);
    mutate({ id: second.id, action: 'edit', text: 'second edited' });
    assert.deepEqual(session.agent.followUpQueue.messages.map(item => item.content[1].data), ['YQ==', 'Yg==']);
    assert.deepEqual(session.agent.followUpQueue.messages.map(item => item.content[0].text), ['same', 'second edited']);
    mutate({ id: second.id, action: 'move', beforeId: first.id });
    assert.deepEqual(queue.snapshot().items.map(item => item.id), [second.id, first.id]);
    assert.deepEqual(session.agent.followUpQueue.messages.map(item => item.content[1].data), ['Yg==', 'YQ==']);
    const [delivered] = session.agent.followUpQueue.drain();
    assert.throws(() => mutate({ id: second.id, action: 'edit', text: 'too late' }), /已经消费/);
    queue.consumed(delivered);
    assert.equal(queue.receipt(second.id).state, 'consumed');
    mutate({ id: first.id, action: 'remove' });
    assert.equal(session.agent.followUpQueue.messages.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed durable commit changes no SDK item; repeated mutation and lost acceptance reply apply once', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-input-atomic-'));
  try {
    const { queue, session, submit } = setup(root);
    const first = submit('first', 'YQ=='), second = submit('second', 'Yg==');
    const before = [...session.agent.followUpQueue.messages]; const version = queue.snapshot().version;
    const save = queue.save; queue.save = () => { throw new Error('Injected disk failure'); };
    assert.throws(() => queue.mutate({ requestId: randomUUID(), expectedVersion: version, id: first.id, action: 'remove' }), /Injected/);
    assert.deepEqual(session.agent.followUpQueue.messages, before); assert.equal(queue.snapshot().version, version);
    queue.save = save;
    const request = { requestId: randomUUID(), expectedVersion: version, id: first.id, action: 'edit', text: 'updated' };
    const result = queue.mutate(request); assert.deepEqual(queue.mutate(request), result);
    assert.equal(queue.snapshot().version, result.version);
    assert.equal(queue.begin(second).state, 'accepted');
    assert.equal(session.agent.followUpQueue.messages.length, 2);
    assert.throws(() => queue.begin({ ...second, text: 'not the same request' }), /内容已改变/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pause gates actual follow-up consumption; restart requires confirmation and retains image identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-input-recovery-'));
  try {
    const first = setup(root); const submitted = first.submit('pending', 'YQ==');
    first.mutate({ action: 'pause' });
    assert.deepEqual(first.session.agent.followUpQueue.drain(), []);
    assert.equal(first.session.agent.followUpQueue.hasItems(), false);
    first.session.agent.steeringQueue.enqueue({ role: 'user', content: [{ type: 'text', text: 'steer now' }], timestamp: 43 });
    assert.equal(first.session.agent.steeringQueue.drain().length, 1, 'steering remains independent');
    first.queue.dispose();
    const restarted = setup(root);
    assert.equal(restarted.queue.snapshot().paused, true);
    assert.ok(restarted.queue.snapshot().items.every(item => item.state === 'recovered'));
    assert.equal(restarted.session.agent.followUpQueue.messages.length, 0);
    restarted.mutate({ action: 'confirm', id: submitted.id });
    assert.deepEqual(restarted.session.agent.followUpQueue.drain(), []);
    restarted.mutate({ action: 'resume' });
    const [message] = restarted.session.agent.followUpQueue.drain();
    assert.equal(message.content[1].data, 'YQ=='); restarted.queue.consumed(message);
    assert.equal(restarted.session.agent.followUpQueue.drain().length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a known preflight rejection can retry the same ID while consumed or explicitly removed inputs never replay', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-input-retry-'));
  try {
    const { queue, session, submit, mutate } = setup(root);
    const request = { id: randomUUID(), sessionId: 'session', text: 'retry', behavior: 'followUp', attachments: [{ kind: 'image', name: 'same.png', mimeType: 'image/png', data: 'YQ==' }] };
    queue.begin(request); queue.fail(request.id, new Error('Preflight rejected'));
    assert.equal(queue.receipt(request.id).state, 'failed'); assert.equal(queue.begin(request), undefined);
    queue.consumed({}, request.id); queue.fail(request.id, new Error('Too late'));
    assert.equal(queue.begin(request).state, 'consumed');
    const removed = submit('remove me', 'Yg=='); mutate({ action: 'remove', id: removed.id });
    assert.equal(queue.begin(removed).state, 'failed'); assert.equal(session.agent.followUpQueue.messages.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('beginEdit holds the same visible input while other queued instructions can be consumed', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-input-edit-hold-'));
  try {
    const { queue, session, submit, mutate } = setup(root);
    const first = submit('first', 'YQ=='), editing = submit('keep my original', 'Yg=='), last = submit('last', 'Yw==');
    const before = queue.snapshot(), original = structuredClone(session.agent.followUpQueue.messages[1]);
    const held = mutate({ action: 'beginEdit', id: editing.id });
    assert.deepEqual(held.items.map(item => item.id), [first.id, editing.id, last.id]);
    assert.deepEqual(held.items[1], { ...before.items[1], state: 'editing', version: before.items[1].version + 1 });
    assert.deepEqual(session.agent.followUpQueue.messages.map(item => item.content[0].text), ['first', 'last']);
    for (const text of ['first', 'last']) {
      const [message] = session.agent.followUpQueue.drain();
      assert.equal(message.content[0].text, text);
      queue.consumed(message);
    }
    assert.deepEqual(session.agent.followUpQueue.drain(), [], 'the SDK cannot consume an input held for editing');
    assert.deepEqual(queue.snapshot().items.map(item => [item.id, item.state]), [[editing.id, 'editing']]);
    mutate({ action: 'cancelEdit', id: editing.id });
    const [restored] = session.agent.followUpQueue.drain();
    assert.deepEqual(restored, original, 'cancel restores all original text and image payloads after neighbors are consumed');
    queue.consumed(restored);
    assert.equal(queue.receipt(editing.id).state, 'consumed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cancel and save restore a held input at its original position within its delivery type', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-input-edit-position-'));
  try {
    const { queue, session, submit, submitContent, mutate } = setup(root);
    const first = submit('first', 'YQ=='), editing = submit('middle', 'Yg=='), last = submit('last', 'Yw==');
    const steering = submitContent('steering', [], 'steer');
    const original = structuredClone(session.agent.followUpQueue.messages[1]);
    mutate({ action: 'beginEdit', id: editing.id });
    mutate({ action: 'cancelEdit', id: editing.id });
    assert.deepEqual(session.agent.followUpQueue.messages[1], original);
    assert.deepEqual(queue.snapshot().items.map(item => item.id), [steering.id, first.id, editing.id, last.id]);
    mutate({ action: 'beginEdit', id: editing.id });
    mutate({ action: 'edit', id: editing.id, text: 'middle updated' });
    assert.deepEqual(session.agent.followUpQueue.messages.map(item => item.content[0].text), ['first', 'middle updated', 'last']);
    assert.deepEqual(session.agent.followUpQueue.messages.map(item => item.content[1].data), ['YQ==', 'Yg==', 'Yw==']);
    assert.deepEqual(queue.snapshot().items.map(item => [item.id, item.state]), [steering, first, editing, last].map(item => [item.id, 'accepted']));
    assert.deepEqual(session.agent.steeringQueue.messages.map(item => item.content[0].text), ['steering']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const attachment of [
  { kind: 'image', name: 'only-image.png', mimeType: 'image/png', data: 'aW1hZ2U=' },
  { kind: 'text', name: 'only-text.txt', mimeType: 'text/plain', text: 'Keep this exact attachment body.\nIncluding the second line.' },
]) {
  test(`saving an edited ${attachment.kind} attachment input allows an empty instruction without losing its payload`, () => {
    const root = mkdtempSync(join(tmpdir(), `pi-input-empty-${attachment.kind}-`));
    try {
      const { queue, session, submitContent, mutate } = setup(root);
      const submitted = submitContent('remove this instruction', [attachment]);
      const before = structuredClone(session.agent.followUpQueue.messages[0]);
      const preview = queue.snapshot().items[0].attachments;
      mutate({ action: 'beginEdit', id: submitted.id });
      mutate({ action: 'edit', id: submitted.id, text: '' });
      const item = queue.snapshot().items[0], message = session.agent.followUpQueue.messages[0];
      assert.equal(item.id, submitted.id); assert.equal(item.state, 'accepted'); assert.equal(item.text, '');
      assert.deepEqual(item.attachments, preview);
      assert.deepEqual(message, { ...before, content: [{ type: 'text', text: before.content[0].text.slice('remove this instruction'.length) }, ...before.content.slice(1)] });
      const [delivered] = session.agent.followUpQueue.drain(); queue.consumed(delivered);
      assert.equal(queue.receipt(submitted.id).state, 'consumed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('empty edits without attachments are rejected without releasing the edit hold', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-input-empty-text-'));
  try {
    const { queue, session, submitContent, mutate } = setup(root);
    const submitted = submitContent('original instruction');
    mutate({ action: 'beginEdit', id: submitted.id });
    const held = queue.snapshot();
    for (const text of ['', ' \n\t ']) {
      assert.throws(() => mutate({ action: 'edit', id: submitted.id, text }));
      assert.deepEqual(queue.snapshot(), held);
      assert.deepEqual(session.agent.followUpQueue.messages, []);
    }
    mutate({ action: 'cancelEdit', id: submitted.id });
    assert.equal(session.agent.followUpQueue.messages[0].content[0].text, 'original instruction');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('begin, save and cancel editing are atomic on disk failure and idempotent after a lost reply', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-input-edit-atomic-'));
  try {
    const { queue, session, submit, mutate } = setup(root);
    const first = submit('first', 'YQ=='), editing = submit('original', 'Yg=='), last = submit('last', 'Yw==');
    const runAtomic = patch => {
      const before = queue.snapshot(), messages = [...session.agent.followUpQueue.messages];
      const request = { requestId: randomUUID(), expectedVersion: before.version, ...patch };
      const save = queue.save; queue.save = () => { throw new Error('Injected editing persistence failure'); };
      try { assert.throws(() => queue.mutate(request), /Injected editing persistence failure/); }
      finally { queue.save = save; }
      assert.deepEqual(queue.snapshot(), before, 'failed persistence preserves the queue version and editing state');
      assert.deepEqual(session.agent.followUpQueue.messages, messages, 'failed persistence never changes SDK delivery');
      const saved = queue.mutate(request), committed = [...session.agent.followUpQueue.messages];
      assert.deepEqual(queue.mutate(request), saved, 'retrying the same request returns the committed state');
      assert.deepEqual(session.agent.followUpQueue.messages, committed, 'a repeated request cannot restore a duplicate');
      assert.equal(queue.snapshot().version, before.version + 1);
    };
    runAtomic({ action: 'beginEdit', id: editing.id });
    runAtomic({ action: 'edit', id: editing.id, text: 'saved once' });
    mutate({ action: 'beginEdit', id: editing.id });
    runAtomic({ action: 'cancelEdit', id: editing.id });
    assert.deepEqual(queue.snapshot().items.map(item => item.id), [first.id, editing.id, last.id]);
    assert.deepEqual(session.agent.followUpQueue.messages.map(item => item.content[0].text), ['first', 'saved once', 'last']);
    assert.deepEqual(session.agent.followUpQueue.messages.map(item => item.content[1].data), ['YQ==', 'Yg==', 'Yw==']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('only one input can be held for editing and removing it never restores it later', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-input-edit-exclusive-'));
  try {
    const { queue, session, submit, submitContent, mutate } = setup(root);
    const editing = submit('remove while editing', 'YQ=='), other = submitContent('other type', [], 'steer');
    mutate({ action: 'beginEdit', id: editing.id });
    const held = queue.snapshot(), steering = [...session.agent.steeringQueue.messages];
    assert.throws(() => mutate({ action: 'beginEdit', id: other.id }));
    assert.deepEqual(queue.snapshot(), held);
    assert.deepEqual(session.agent.steeringQueue.messages, steering);
    mutate({ action: 'remove', id: editing.id });
    assert.deepEqual(queue.snapshot().items.map(item => item.id), [other.id]);
    assert.deepEqual(session.agent.followUpQueue.messages, []);
    assert.throws(() => mutate({ action: 'cancelEdit', id: editing.id }));
    mutate({ action: 'beginEdit', id: other.id });
    assert.equal(queue.snapshot().items[0].state, 'editing', 'removing the previous edit releases the hold');
    mutate({ action: 'cancelEdit', id: other.id });
    assert.equal(session.agent.steeringQueue.messages.length, 1);
    assert.equal(session.agent.followUpQueue.messages.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('restarting with an edit hold requires recovery confirmation and restores the original complete message', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-input-edit-recovery-'));
  try {
    const first = setup(root);
    const submitted = first.submitContent('original before edit', [
      { kind: 'image', name: 'original.png', mimeType: 'image/png', data: 'b3JpZ2luYWw=' },
      { kind: 'text', name: 'original.txt', mimeType: 'text/plain', text: 'Persist the attached context.' },
    ]);
    const original = structuredClone(first.session.agent.followUpQueue.messages[0]);
    const preview = first.queue.snapshot().items[0].attachments;
    first.mutate({ action: 'beginEdit', id: submitted.id });
    first.queue.dispose();
    const restarted = setup(root), recovered = restarted.queue.snapshot().items[0];
    assert.equal(recovered.id, submitted.id); assert.equal(recovered.state, 'recovered');
    assert.equal(recovered.text, submitted.text); assert.deepEqual(recovered.attachments, preview);
    assert.deepEqual(restarted.session.agent.followUpQueue.drain(), []);
    restarted.mutate({ action: 'confirm', id: submitted.id });
    const [message] = restarted.session.agent.followUpQueue.drain();
    assert.deepEqual(message, original);
    restarted.queue.consumed(message);
    assert.equal(restarted.queue.receipt(submitted.id).state, 'consumed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('confirming recovered inputs in reverse order keeps accepted display order equal to SDK delivery order', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-input-recovery-order-'));
  try {
    const first = setup(root), submitted = [];
    for (const behavior of ['steer', 'followUp']) for (const text of ['first', 'second', 'third']) submitted.push(first.submitContent(`${behavior} ${text}`, [], behavior));
    first.queue.dispose();
    const restarted = setup(root);
    for (const behavior of ['steer', 'followUp']) restarted.submitContent(`${behavior} newest`, [], behavior);
    for (const item of submitted.toReversed()) {
      restarted.mutate({ action: 'confirm', id: item.id });
      for (const behavior of ['steer', 'followUp']) {
        const accepted = restarted.queue.snapshot().items.filter(row => row.behavior === behavior && row.state === 'accepted').map(row => row.text);
        const sdk = restarted.session.agent[behavior === 'steer' ? 'steeringQueue' : 'followUpQueue'];
        assert.deepEqual(sdk.messages.map(message => message.content[0].text), accepted, 'every partial recovery must agree with the actual SDK order');
      }
    }
    for (const behavior of ['steer', 'followUp']) {
      const sdk = restarted.session.agent[behavior === 'steer' ? 'steeringQueue' : 'followUpQueue'];
      const expected = ['first', 'second', 'third', 'newest'].map(text => `${behavior} ${text}`), delivered = [];
      assert.deepEqual(restarted.queue.snapshot().items.filter(item => item.behavior === behavior).map(item => item.text), expected);
      while (sdk.hasItems()) { const [message] = sdk.drain(); delivered.push(message.content[0].text); restarted.queue.consumed(message); }
      assert.deepEqual(delivered, expected);
    }
    assert.deepEqual(restarted.queue.snapshot().items, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
