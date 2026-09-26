import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('cached long sessions retain their total and history reads cannot race a branch transition', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-history-restore-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const environment = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map((name) => [name, process.env[name]]));
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  process.env.PI_OFFLINE = '1';
  let service;
  let release;
  try {
    const [{ AgentService }, { SessionManager }] = await Promise.all([
      import('../packages/agent/src/index.ts'), import('@earendil-works/pi-coding-agent'),
    ]);
    const saved = SessionManager.create(workspace);
    for (let i = 0; i < 405; i += 1) saved.appendMessage({ role: 'user', content: `message ${i}`, timestamp: Date.now() });
    saved.appendMessage({
      role: 'assistant', content: [{ type: 'text', text: 'Done' }], api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now(),
    });
    service = new AgentService();
    const events = [];
    service.onEvent(({ event }) => events.push(event));
    await service.init({ cwd: workspace, sessionPath: saved.getSessionFile() });
    assert.equal(service.getSnapshot().messages.length, 400);
    const navigating = service.newSession();
    assert.throws(() => service.getHistoryPage(0, 10), /切换/);
    await navigating;
    await service.switchSession(saved.getSessionFile());
    const restored = events.findLast((event) => event.type === 'ready');
    assert.equal(restored.messages.length, 400);
    assert.equal(restored.historyTotal, 406, 'cached ready events must still advertise older pages');
    assert.equal(service.getHistoryPage(0, 10).messages[0].text, 'message 0');

    const session = service.active.runtime.session;
    const navigate = session.navigateTree.bind(session);
    const gate = new Promise((done) => { release = done; });
    session.navigateTree = async (...args) => { await gate; return navigate(...args); };
    const switching = service.switchSessionBranch(service.getSessionTree()[0].id);
    await new Promise((done) => setImmediate(done));
    assert.throws(() => service.getHistoryPage(0, 10), /切换/, 'no page from an intermediate branch may precede its ready event');
    release();
    await switching;
    assert.doesNotThrow(() => service.getHistoryPage(0, 10));
  } finally {
    release?.();
    await service?.dispose().catch(() => {});
    rmSync(root, { recursive: true, force: true });
    for (const [name, value] of environment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
