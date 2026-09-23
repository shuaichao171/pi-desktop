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
      import('../packages/agent/node_modules/@earendil-works/pi-coding-agent/dist/index.js'),
    ]);
    service = new AgentService();
    const events = [];
    service.onEvent((envelope) => events.push(envelope));

    await service.init({ cwd: workspace });
    const first = service.getSnapshot();
    assert.equal(first.status, 'idle');
    assert.equal(first.cwd, workspace);
    assert.ok(first.sessionId);
    assert.ok(first.sessionPath);
    assert.deepEqual(first.messages, []);
    assert.deepEqual(await service.listSessions(), []);

    await service.newSession();
    const second = service.getSnapshot();
    assert.equal(second.status, 'idle');
    assert.notEqual(second.sessionId, first.sessionId);
    assert.ok(second.sequence > first.sequence);
    assert.ok(events.some(({ event }) => event.type === 'ready' && event.sessionId === second.sessionId));

    const persisted = SessionManager.create(workspace);
    persistConversation(persisted, 'Restore me', 'Restored reply');

    await service.switchSession(persisted.getSessionFile());
    const restored = service.getSnapshot();
    assert.equal(restored.sessionId, persisted.getSessionId());
    assert.deepEqual(restored.messages.map(({ text }) => text), ['Restore me', 'Restored reply']);
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
    await service.switchWorkspace(workspace);
    assert.equal(service.getSnapshot().sessionId, other.getSessionId(), 'switching projects resumes its live Pi runtime');
  } finally {
    await service?.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    const resolvedTemp = resolve(tempRoot);
    const resolvedParent = realpathSync(tmpdir());
    if (!resolvedTemp.startsWith(resolvedParent + sep)) {
      throw new Error('Refusing to remove a test directory outside the temporary folder');
    }
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
});
