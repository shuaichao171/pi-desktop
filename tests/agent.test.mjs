import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('peekSession reads a session from disk with the exact content window ready would send', async () => {
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

    const persisted = SessionManager.create(workspace);
    persistConversation(persisted, 'Peek question', 'Peek answer');
    persistConversation(persisted, 'Second question', 'Second answer');

    // The peek happens before any init/load: it must work cold, straight from disk.
    const peek = await service.peekSession(workspace, persisted.getSessionFile());
    assert.ok(peek, 'the disk peek succeeds for a session the host has never loaded');
    assert.equal(peek.historyTotal, 4, 'two user/assistant turns are counted');
    assert.deepEqual(peek.messages.map(({ role, text }) => ({ role, text })), [
      { role: 'user', text: 'Peek question' },
      { role: 'assistant', text: 'Peek answer' },
      { role: 'user', text: 'Second question' },
      { role: 'assistant', text: 'Second answer' },
    ], 'the peek window carries the full branch conversation');
    assert.deepEqual(peek.fileChanges, []);

    await service.init({ cwd: workspace });
    await service.switchSession(persisted.getSessionFile());
    const snapshot = service.getSnapshot();
    assert.deepEqual(snapshot.messages, peek.messages, 'the loaded conversation equals the peek window object-for-object — a matching ready fingerprint-confirms the painted peek');
    assert.equal(snapshot.historyTotal, peek.historyTotal);

    assert.equal(await service.peekSession(workspace, join(tempRoot, 'outside.jsonl')), null, 'a session outside the workspace is refused');
    assert.equal(await service.peekSession(workspace, persisted.getSessionFile() + '.missing'), null, 'a missing session file yields null, not an error');
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

test('returning to a loaded session re-publishes its file changes on the warm ready', async () => {
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
		// Session A carries one persisted file-change record; the service must
		// re-publish it on the warm ready when the user navigates back.
		const managerA = SessionManager.create(workspace);
		managerA.appendMessage({ role: 'user', content: 'change something', timestamp: Date.now() });
		managerA.appendCustomEntry('pi-desktop:file-changes-v1', { files: [{
			path: 'notes/todo.txt',
			before: { exists: false, fingerprint: 'missing', text: '' },
			after: { exists: true, fingerprint: createHash('sha256').update('hello').digest('hex'), text: 'hello' },
		}] });

		service = new AgentService();
		const events = [];
		service.onEvent((envelope) => events.push(envelope));
		const lastReady = () => events.findLast(({ event }) => event.type === 'ready')?.event;

		await service.init({ cwd: workspace });
		const pathA = service.getSnapshot().sessionPath;
		assert.ok(pathA, 'init loads the fabricated session');
		// The snapshot itself must carry the restored change view (state sync fix):
		// warm re-activations rebuild their ready from this snapshot.
		assert.equal(service.getSnapshot().fileChanges.length, 1);
		assert.equal(lastReady().fileChanges.length, 1);

		await service.newSession();
		assert.notEqual(service.getSnapshot().sessionPath, pathA);
		assert.equal(lastReady().fileChanges.length, 0);

		await service.switchSession(pathA);
		const warm = lastReady();
		assert.equal(warm.resumeKind, 'warm', 'returning to a kept-warm session takes the warm path');
		assert.equal(warm.fileChanges.length, 1, 'the warm ready must re-publish the session file changes');
		assert.ok(warm.fileChangeTurns && warm.fileChangeTurns.length > 0, 'the warm ready must re-publish per-turn change groups');
	} finally {
		process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (service) await service.dispose?.();
		const resolvedTemp = resolve(tempRoot);
		if (!resolvedTemp.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('Refusing to remove a test directory outside the temporary folder');
		rmSync(resolvedTemp, { recursive: true, force: true });
	}
});
