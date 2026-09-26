import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

test('real pinned SDK keeps duplicate-text images and rejects consumed targets without rebuilding input handlers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sdk-transaction-')); const cwd = join(root, 'workspace'); mkdirSync(cwd);
  const saved = { dir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent'); process.env.PI_OFFLINE = '1';
  let service, session;
  try {
    const { AgentService } = await import('../packages/agent/src/index.ts'); service = new AgentService(); await service.init({ cwd });
    session = service.active.runtime.session;
    session.agent.streamFunction = () => { throw new Error('Queue test must not call a provider'); };
    Object.defineProperties(session, { isStreaming: { configurable: true, get: () => true }, isIdle: { configurable: true, get: () => false } });
    const request = data => ({ id: randomUUID(), sessionId: session.sessionId, text: 'same text', behavior: 'followUp', attachments: [{ kind: 'image', name: 'same.png', mimeType: 'image/png', data }] });
    const first = request('YQ=='), second = request('Yg==');
    assert.equal((await service.submitInput(first)).state, 'accepted'); await service.submitInput(second);
    await service.submitInput(first); assert.equal(service.getInputQueue().items.length, 2, 'lost receipt retry is not re-enqueued');
    assert.equal(session.agent.peekQueuedMessages().length, 1, 'real SDK exposes only the next item');
    const mutate = patch => service.mutateInputQueue({ requestId: randomUUID(), expectedVersion: service.getInputQueue().version, ...patch });
    mutate({ action: 'beginEdit', id: second.id });
    assert.equal(service.getInputQueue().items[1].state, 'editing');
    assert.deepEqual(session.agent.followUpQueue.messages.map(message => message.content[1].data), ['YQ=='], 'held inputs leave the real SDK consumption queue');
    mutate({ action: 'cancelEdit', id: second.id });
    assert.deepEqual(session.agent.followUpQueue.messages.map(message => message.content[1].data), ['YQ==', 'Yg==']);
    mutate({ action: 'beginEdit', id: second.id });
    mutate({ action: 'edit', id: second.id, text: 'edited second' });
    assert.deepEqual(session.agent.followUpQueue.messages.map(message => message.content[1].data), ['YQ==', 'Yg==']);
    mutate({ action: 'remove', id: first.id });
    assert.equal(session.agent.peekQueuedMessages()[0].content[1].data, 'Yg==');
    mutate({ action: 'pause' }); assert.equal(session.agent.hasQueuedMessages(), false); assert.deepEqual(session.agent.followUpQueue.drain(), []);
    mutate({ action: 'resume' }); const [delivered] = session.agent.followUpQueue.drain();
    assert.throws(() => mutate({ action: 'edit', id: second.id, text: 'too late' }), /已经消费/);
    await session._handleAgentEvent({ type: 'message_start', message: delivered });
    assert.equal((await service.submitInput(second)).state, 'consumed'); assert.equal(service.getInputQueue().items.length, 0);
  } finally {
    if (session) { delete session.isStreaming; delete session.isIdle; }
    await service?.dispose();
    if (saved.dir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.dir;
    if (saved.offline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = saved.offline;
    rmSync(root, { recursive: true, force: true });
  }
});

test('queue scopes reject stale reads and writes after navigation and preserve held edits in cached sessions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sdk-queue-scope-')); const cwd = join(root, 'workspace'); mkdirSync(cwd);
  const saved = { dir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent'); process.env.PI_OFFLINE = '1';
  let service, session;
  try {
    const { AgentService } = await import('../packages/agent/src/index.ts'); service = new AgentService(); await service.init({ cwd });
    session = service.active.runtime.session;
    session.agent.streamFunction = () => { throw new Error('Queue scope test must not call a provider'); };
    Object.defineProperties(session, { isStreaming: { configurable: true, get: () => true }, isIdle: { configurable: true, get: () => false } });
    const request = { id: randomUUID(), sessionId: session.sessionId, text: 'Keep my held edit', behavior: 'followUp' };
    await service.submitInput(request);
    const original = service.getInputQueue(), scope = original.scope;
    assert.deepEqual(service.getInputQueue(scope), original);
    const held = service.mutateInputQueue({ scope, requestId: randomUUID(), expectedVersion: original.version, action: 'beginEdit', id: request.id });
    assert.equal(held.items[0].state, 'editing'); assert.deepEqual(held.scope, scope);
    for (const invalid of [{ ...scope, cwd: join(root, 'other') }, { ...scope, sessionPath: `${scope.sessionPath}-copy` }, { ...scope, sessionId: 'other-id' }]) {
      assert.throws(() => service.getInputQueue(invalid), /所属会话已变化/);
      assert.throws(() => service.mutateInputQueue({ scope: invalid, requestId: randomUUID(), expectedVersion: held.version, action: 'pause' }), /所属会话已变化/);
    }
    await service.newSession();
    const current = service.getInputQueue();
    assert.notDeepEqual(current.scope, scope);
    assert.throws(() => service.getInputQueue(scope), /所属会话已变化/);
    assert.throws(() => service.mutateInputQueue({ scope, requestId: randomUUID(), expectedVersion: current.version, action: 'pause' }), /所属会话已变化/, 'even a matching new queue version cannot authorize an old-scope mutation');
    assert.deepEqual(service.getInputQueue(), current);
    await service.switchSession(scope.sessionPath);
    const returned = service.getInputQueue(scope);
    assert.equal(returned.items[0].state, 'editing'); assert.equal(returned.items[0].text, request.text);
    assert.equal(session.agent.followUpQueue.messages.length, 0);
    service.mutateInputQueue({ scope, requestId: randomUUID(), expectedVersion: returned.version, action: 'cancelEdit', id: request.id });
    assert.equal(session.agent.followUpQueue.messages[0].content[0].text, request.text);
  } finally {
    if (session) { delete session.isStreaming; delete session.isIdle; }
    await service?.dispose();
    if (saved.dir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.dir;
    if (saved.offline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = saved.offline;
    rmSync(root, { recursive: true, force: true });
  }
});
