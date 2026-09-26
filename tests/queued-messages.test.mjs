import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';

const settle = () => new Promise((done) => setImmediate(done));

test('SDK queues project accepted instructions, duplicates, attachments and session restoration without a model call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-desktop-queue-'));
  const workspace = join(root, 'workspace');
  const otherWorkspace = join(root, 'other');
  mkdirSync(workspace);
  mkdirSync(otherWorkspace);
  const environment = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map((name) => [name, process.env[name]]));
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  process.env.PI_OFFLINE = '1';
  let service;
  let session;
  try {
    const { AgentService } = await import('../packages/agent/src/index.ts');
    service = new AgentService();
    const events = [];
    service.onEvent(({ event }) => events.push(event));
    assert.deepEqual(service.getSnapshot().queuedMessages, []);
    await service.init({ cwd: workspace });
    const context = service.active;
    session = context.runtime.session;
    session.agent.streamFunction = () => { throw new Error('Queue verification must never request a model'); };

    await session.followUp('same instruction');
    const firstId = service.getSnapshot().queuedMessages[0].id;
    await session.followUp('same instruction');
    await session.steer('Use the existing component');
    let snapshot = service.getSnapshot();
    assert.equal(snapshot.queuedCount, 3);
    assert.deepEqual(snapshot.queuedMessages.map(({ text, behavior }) => [text, behavior]), [
      ['Use the existing component', 'steer'], ['same instruction', 'followUp'], ['same instruction', 'followUp'],
    ]);
    const secondId = snapshot.queuedMessages[2].id;
    assert.equal(snapshot.queuedMessages[1].id, firstId);
    assert.notEqual(firstId, secondId);

    const [firstDelivered] = session.agent.followUpQueue.drain();
    await session._handleAgentEvent({ type: 'message_start', message: firstDelivered });
    snapshot = service.getSnapshot();
    assert.deepEqual(snapshot.queuedMessages.map(({ id }) => id), [snapshot.queuedMessages[0].id, secondId], 'consumption removes the first duplicate, preserving the later entry');
    assert.equal(snapshot.queuedCount, 2);
    session.clearQueue();
    assert.deepEqual(service.getSnapshot().queuedMessages, []);
    assert.equal(events.at(-1).count, 0);
    assert.deepEqual(events.at(-1).items, []);

    // Force only the public busy-state getters so the real SDK prompt path
    // accepts follow-ups and runs input preprocessing without requesting a model.
    Object.defineProperties(session, {
      isStreaming: { configurable: true, get: () => true },
      isIdle: { configurable: true, get: () => false },
    });
    const attachments = [
      { kind: 'image', name: 'design.png', mimeType: 'image/png', data: 'aGVsbG8=' },
      { kind: 'text', name: 'notes.md', mimeType: 'text/markdown', text: '# Context\nDo not send this large body in queue events.' },
      { kind: 'text', name: 'src', mimeType: 'text/x-pi-directory-reference', text: 'Project directory: src/', source: { kind: 'directory', workspace, path: 'src' } },
    ];
    await service.prompt('First pending instruction', 'followUp');
    await settle();
    await service.prompt('Review the attached design', 'followUp', attachments);
    await settle();
    snapshot = service.getSnapshot();
    const tail = snapshot.queuedMessages[1];
    assert.equal(tail.text, 'Review the attached design');
    assert.deepEqual(tail.attachments, attachments.map(({ kind, name, mimeType }) => ({ kind, name, mimeType })));
    assert.equal(session.agent.peekQueuedMessages().length, 1, 'the SDK preview is only one entry, so it cannot stand in for the complete queue');
    assert.equal(JSON.stringify(events.filter(({ type }) => type === 'queue')).includes('aGVsbG8='), false);
    assert.equal(JSON.stringify(events.filter(({ type }) => type === 'queue')).includes('Do not send this large body'), false);

    const countBeforeInvalidPrompt = snapshot.queuedCount;
    await assert.rejects(service.prompt('Rejected attachment', 'followUp', [{ kind: 'image', name: 'bad.png', mimeType: 'image/png', data: '' }]), /图片附件/);
    assert.equal(service.getSnapshot().queuedCount, countBeforeInvalidPrompt, 'validation failure never creates a displayed queue entry');
    snapshot.queuedMessages[1].text = 'changed by consumer';
    snapshot.queuedMessages[1].attachments[0].name = 'changed.png';
    assert.equal(service.getSnapshot().queuedMessages[1].text, 'Review the attached design');
    assert.equal(service.getSnapshot().queuedMessages[1].attachments[0].name, 'design.png');
    delete session.isStreaming;
    delete session.isIdle;
    await service.abort();
    assert.equal(service.getSnapshot().queuedCount, 2, 'Pi abort preserves accepted pending instructions');
    assert.equal(context.canEvict, false, 'an idle context with queued instructions must not be evicted');

    const pending = service.getSnapshot().queuedMessages;
    await service.switchWorkspace(otherWorkspace);
    assert.deepEqual(service.getSnapshot().queuedMessages, []);
    await service.switchWorkspace(workspace);
    assert.deepEqual(service.getSnapshot().queuedMessages, pending, 'reactivation preserves IDs, order and attachment labels');
    assert.deepEqual(events.findLast(({ type }) => type === 'queue').items, pending);

    session.clearQueue();
    await session.steer('Extension image', [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }]);
    await settle();
    assert.deepEqual(service.getSnapshot().queuedMessages[0].attachments, [{ kind: 'image', name: '图片 1', mimeType: 'image/png' }], 'public next-turn preview supplies image summaries for extension messages');
    session.clearQueue();
    await session.followUp('', [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }]);
    await settle();
    const imageOnly = session.agent.peekQueuedMessages()[0];
    const imageOnlyId = service.getSnapshot().queuedMessages[0].id;
    session.agent.followUpQueue.drain(); // Exercise the actual low-level reservation boundary.
    await session._handleAgentEvent({ type: 'message_start', message: imageOnly });
    assert.deepEqual(session.getFollowUpMessages(), [], 'the adapter synchronizes the SDK display mirror for image-only delivery');
    assert.deepEqual(service.getSnapshot().queuedMessages, [], 'a real delivery event removes the confirmed image-only instruction');
    await session.followUp('', [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }]);
    await settle();
    assert.equal(service.getSnapshot().queuedCount, 1, 'later empty instructions are not confused with the stale SDK mirror');
    assert.notEqual(service.getSnapshot().queuedMessages[0].id, imageOnlyId);
    session.clearQueue();
    await service.newSession();
    assert.deepEqual(service.getSnapshot().queuedMessages, []);
  } finally {
    if (session) {
      delete session.isStreaming;
      delete session.isIdle;
      session.clearQueue();
    }
    await service?.dispose();
    for (const [name, value] of environment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    const target = resolve(root);
    if (!target.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('Unsafe temporary path');
    rmSync(target, { recursive: true, force: true });
  }
});
