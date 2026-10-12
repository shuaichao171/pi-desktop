import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';

function persistConversation(manager, prompt, reply) {
  manager.appendMessage({ role: 'user', content: prompt, timestamp: Date.now() });
  manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: reply }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  });
}

test('Pi SDK runtime initializes, replaces a session, and publishes a current snapshot', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-test-'));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, 'agent');
  const workspace = join(tempRoot, 'workspace');
  mkdirSync(workspace);

  let service;
  try {
    const [{ AgentService }, { SessionManager }] = await Promise.all([
      import('../packages/agent/src/index.ts'),
      import('@earendil-works/pi-coding-agent'),
    ]);
    service = new AgentService();
    const events = [];
    service.onEvent((envelope) => events.push(envelope));
    const assertReadyKind = (snapshot, kind) => {
      const ready = events.findLast(({ event }) => event.type === 'ready')?.event;
      assert.equal(ready?.sessionId, snapshot.sessionId, 'the ready event belongs to the newly selected session');
      assert.equal(ready.resumeKind ?? 'cold', kind);
    };

    await service.init({ cwd: workspace });
    const first = service.getSnapshot();
    assertReadyKind(first, 'cold');
    assert.equal(first.status, 'idle');
    assert.equal(first.cwd, workspace);
    assert.ok(first.sessionId);
    assert.ok(first.sessionPath);
    assert.deepEqual(first.messages, []);
    assert.deepEqual(await service.listSessions(), []);
    await assert.rejects(service.prompt('', undefined, [{ kind: 'image', name: 'empty.png', mimeType: 'image/png', data: '' }]),
      /图片附件格式无效/);
    assert.equal(service.getSnapshot().status, 'idle', 'invalid image must be rejected before Pi starts a run');

    await service.newSession();
    const second = service.getSnapshot();
    assertReadyKind(second, 'cold');
    assert.equal(second.status, 'idle');
    assert.notEqual(second.sessionId, first.sessionId);
    assert.ok(second.sequence > first.sequence);
    assert.ok(events.some(({ event }) => event.type === 'ready' && event.sessionId === second.sessionId));

    const persisted = SessionManager.create(workspace);
    persistConversation(persisted, 'Restore me', 'Restored reply');
    persisted.appendMessage({
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'interrupted-tool', name: 'bash', arguments: { command: 'sleep 10' } }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse',
      timestamp: Date.now(),
    });

    await service.switchSession(persisted.getSessionFile());
    const restored = service.getSnapshot();
    assertReadyKind(restored, 'cold');
    assert.equal(restored.sessionId, persisted.getSessionId());
    assert.deepEqual(restored.messages.map(({ text }) => text), ['Restore me', 'Restored reply']);
    assert.equal(restored.activities.find(({ id }) => id === 'interrupted-tool')?.status, 'interrupted',
      'a historical tool call with no result should not be reported as a failure');
    assert.equal((await service.listSessions()).length, 1);

    const other = SessionManager.create(workspace);
    persistConversation(other, 'Another session', 'Another reply');
    await service.switchSession(other.getSessionFile());
    const switched = service.getSnapshot();
    assert.equal(switched.sessionId, other.getSessionId());
    assert.deepEqual(switched.messages.map(({ text }) => text), ['Another session', 'Another reply']);
    assert.equal((await service.listSessions()).length, 2);
    await assert.rejects(service.switchSession(join(tempRoot, 'outside.jsonl')), /不属于当前工作区/);

    const otherWorkspace = join(tempRoot, 'other-workspace');
    mkdirSync(otherWorkspace);
    await service.switchWorkspace(otherWorkspace);
    assert.equal(service.getSnapshot().cwd, otherWorkspace);
    assertReadyKind(service.getSnapshot(), 'cold');
    await service.switchWorkspace(workspace);
    assert.equal(service.getSnapshot().sessionId, other.getSessionId(), 'switching projects resumes its live Pi runtime');
    assertReadyKind(service.getSnapshot(), 'warm');

    await service.init({ cwd: workspace, sessionPath: persisted.getSessionFile() });
    assert.equal(service.getSnapshot().sessionId, persisted.getSessionId(), 'init opens the requested Pi session');
    assertReadyKind(service.getSnapshot(), 'warm');
    await service.init({ cwd: workspace, fresh: true });
    assert.notEqual(service.getSnapshot().sessionId, persisted.getSessionId(), 'fresh init creates a new Pi session');
    assertReadyKind(service.getSnapshot(), 'cold');
    await assert.rejects(service.init({ cwd: workspace, sessionPath: join(tempRoot, 'outside.jsonl') }), /不属于指定工作区/);
    await assert.rejects(service.init({ cwd: workspace, sessionPath: persisted.getSessionFile(), fresh: true }), /不能同时指定/);
  } finally {
    await service?.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    const resolvedTemp = realpathSync.native(tempRoot);
    const resolvedParent = realpathSync.native(tmpdir());
    if (!resolvedTemp.startsWith(resolvedParent + sep)) {
      throw new Error('Refusing to remove a test directory outside the temporary folder');
    }
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
});

test('session navigation queues latest-wins instead of rejecting while a slow switch loads (zcode fast switching)', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-queue-'));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, 'agent');
  const workspace = join(tempRoot, 'workspace');
  mkdirSync(workspace);

  let service;
  try {
    const [{ AgentService }, { SessionManager }] = await Promise.all([
      import('../packages/agent/src/index.ts'),
      import('@earendil-works/pi-coding-agent'),
    ]);
    service = new AgentService();
    await service.init({ cwd: workspace });

    const first = SessionManager.create(workspace);
    persistConversation(first, 'First conversation', 'First reply');
    const second = SessionManager.create(workspace);
    persistConversation(second, 'Second conversation', 'Second reply');

    // Gate the cold context load so the first navigation holds the transition slot.
    const originalOpenContext = service.openContext.bind(service);
    let release;
    let entered;
    const gate = new Promise((done) => { release = done; });
    const started = new Promise((done) => { entered = done; });
    service.openContext = async (...args) => { entered(); await gate; return originalOpenContext(...args); };

    const switching = service.switchSession(first.getSessionFile());
    await started;

    // A newer navigation queues behind the slow one instead of being rejected…
    const queued = service.switchSession(second.getSessionFile());
    // …and an even newer click supersedes the queued one with an explicit error.
    const newest = service.switchSession(first.getSessionFile());
    await assert.rejects(queued, /已有更新的切换请求/);
    // Non-navigation transitions keep the strict busy rejection.
    await assert.rejects(service.init({ cwd: workspace, fresh: true }), /会话正在切换/);

    release();
    await switching;
    assert.equal(service.getSnapshot().sessionPath, first.getSessionFile(), 'the slow navigation finishes and activates its target');
    await newest;
    assert.equal(service.getSnapshot().sessionPath, first.getSessionFile(), 'the queued newest navigation converges on the same target');
    assert.equal((await service.listSessions()).length, 2, 'both conversations stay listed');

    // Warm activation remains instant and wins over any stale state.
    const before = service.getSnapshot().sequence;
    await service.switchSession(second.getSessionFile());
    assert.equal(service.getSnapshot().sessionPath, second.getSessionFile());
    assert.ok(service.getSnapshot().sequence > before, 'warm activation publishes fresh events');

    service.openContext = originalOpenContext;
  } finally {
    await service?.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    const resolvedTemp = realpathSync.native(tempRoot);
    const resolvedParent = realpathSync.native(tmpdir());
    if (!resolvedTemp.startsWith(resolvedParent + sep)) {
      throw new Error('Refusing to remove a test directory outside the temporary folder');
    }
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
});
