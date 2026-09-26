import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('bounded history previews preserve original attachments when editing and regenerating', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-history-attachments-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const environment = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map((name) => [name, process.env[name]]));
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  process.env.PI_OFFLINE = '1';
  let service;
  try {
    const [{ AgentService, HISTORY_ATTACHMENT_BUDGET }, { SessionManager }] = await Promise.all([
      import('../packages/agent/src/index.ts'), import('@earendil-works/pi-coding-agent'),
    ]);
    const saved = SessionManager.create(workspace);
    const data = 'a'.repeat(6 * 1024 * 1024);
    const user = saved.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Review these' }, ...[0, 1].map(() => ({ type: 'image', mimeType: 'image/png', data }))], timestamp: Date.now() });
    saved.appendMessage({
      role: 'assistant', content: [{ type: 'text', text: 'Review complete' }], api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now(),
    });
    service = new AgentService();
    const events = [];
    service.onEvent(({ event }) => events.push(event));
    await service.init({ cwd: workspace, sessionPath: saved.getSessionFile() });
    const previews = [service.getSnapshot(), service.getHistoryPage(0, 20), events.find((event) => event.type === 'ready')];
    for (const preview of previews) {
      const message = preview.messages.find((entry) => entry.role === 'user');
      assert.equal(message.attachmentsOmitted, 1);
      assert.ok(message.attachments.reduce((total, attachment) => total + attachment.data.length, 0) <= HISTORY_ATTACHMENT_BUDGET);
      assert.equal(message.attachmentReferences[0].index, 1);
      assert.equal(message.attachmentReferences[0].size, data.length);
    }
    assert.equal(service.getMessageAttachment(saved.getSessionFile(), user, 1).data, data);
    assert.throws(() => service.getMessageAttachment('other-session', user, 1), /会话已切换/);
    assert.throws(() => service.getMessageAttachment(saved.getSessionFile(), user, -1), /索引/);
    assert.throws(() => service.getMessageAttachment(saved.getSessionFile(), 'missing', 0), /未找到/);
    const manager = service.active.runtime.session.sessionManager;
    const originalBranch = manager.getBranch.bind(manager);
    manager.getBranch = () => [{ id: 'oversize', type: 'message', message: { role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'a'.repeat(20 * 1024 * 1024 + 1) }] } }];
    assert.throws(() => service.getMessageAttachment(saved.getSessionFile(), 'oversize', 0), /20 MiB/);
    manager.getBranch = originalBranch;
    let received;
    service.active.prompt = async (text, _behavior, attachments) => { received = { text, attachments }; };
    await service.editUserMessage(user, 'Review again');
    assert.equal(received.text, 'Review again');
    assert.equal(received.attachments.length, 2);
    assert.ok(received.attachments.every((attachment) => attachment.data === data));
    await service.editUserMessage(user, 'Without images', []);
    assert.deepEqual(received.attachments, [], 'an explicit empty list still removes the attachments');

    await service.newSession();
    const empty = service.getSnapshot();
    await service.renameSession(empty.sessionPath, 'Private conversation');
    if (process.platform !== 'win32') assert.equal(statSync(empty.sessionPath).mode & 0o777, 0o600);
  } finally {
    await service?.dispose().catch(() => {});
    rmSync(root, { recursive: true, force: true });
    for (const [name, value] of environment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
