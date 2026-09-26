import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const assistant = (content) => ({
  role: 'assistant', content, api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4',
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
    cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } },
  stopReason: 'stop', timestamp: Date.now(),
});

test('session stats, system rows, tree branches and export work through the service', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-capabilities-'));
  const workspace = join(tempRoot, 'workspace');
  mkdirSync(workspace);
  const environment = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map((name) => [name, process.env[name]]));
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, 'agent');
  process.env.PI_OFFLINE = '1';
  let service;
  try {
    const [{ AgentService }, { SessionManager }] = await Promise.all([
      import('../packages/agent/src/index.ts'), import('@earendil-works/pi-coding-agent'),
    ]);
    const saved = SessionManager.create(workspace);
    saved.appendMessage({ role: 'user', content: 'Inspect the project', timestamp: Date.now() });
    saved.appendMessage(assistant([{ type: 'text', text: 'First reply' }]));
    const summary = saved.appendMessage(assistant([{ type: 'text', text: 'Second reply that gets compacted away' }]));
    saved.appendCompaction('Early work covered the project layout.', summary.id, 1234);
    saved.appendCustomMessageEntry('desktop-notice', 'Extension notice text', true);
    saved.appendCustomMessageEntry('desktop-hidden', 'Never displayed', false);
    saved.appendMessage({ role: 'user', content: 'Continue after compaction', timestamp: Date.now() });
    saved.appendMessage(assistant([{ type: 'text', text: 'Post-compaction reply' }]));

    service = new AgentService();
    const events = [];
    service.onEvent((envelope) => events.push(envelope.event));
    await service.init({ cwd: workspace, sessionPath: saved.getSessionFile() });
    const snapshot = service.getSnapshot();

    await test('compaction and visible custom entries appear as system rows', () => {
      const systemRows = snapshot.messages.filter((message) => message.role === 'system');
      assert.equal(systemRows.length, 2);
      assert.equal(systemRows[0].systemKind, 'compaction');
      assert.ok(systemRows[0].text.includes('project layout'));
      assert.equal(systemRows[1].systemKind, 'custom');
      assert.equal(systemRows[1].text, 'Extension notice text');
      // Hidden custom entries never reach the transcript.
      assert.ok(!snapshot.messages.some((message) => message.text === 'Never displayed'));
    });

    await test('stats aggregate the persisted branch and usage', () => {
      const stats = service.getSessionStats();
      assert.equal(stats.sessionId, saved.getSessionId());
      assert.ok(stats.userMessages >= 2);
      assert.ok(stats.assistantMessages >= 3);
      assert.ok(stats.totalMessages >= stats.userMessages + stats.assistantMessages);
      assert.ok(stats.tokens.total > 0);
      assert.ok(stats.cost > 0);
    });

    await test('the tree marks the visible branch and switches leaves', async () => {
      const tree = service.getSessionTree();
      assert.ok(tree.length >= 1);
      assert.equal(tree[0].kind, 'user');
      const activeNodes = [];
      const walk = (nodes) => { for (const node of nodes) { if (node.active) activeNodes.push(node); walk(node.children); } };
      walk(tree);
      assert.ok(activeNodes.length >= 4, 'the whole visible branch is marked active');
      const fullCount = service.getSnapshot().messages.length;
      const originalLeaf = saved.getLeafId();
      const firstUser = tree[0];
      await service.switchSessionBranch(firstUser.id);
      const switched = service.getSnapshot();
      assert.ok(switched.messages.length < fullCount, 'navigating to the first entry truncates the branch');
      assert.ok(!switched.messages.some((message) => message.text === 'Post-compaction reply'));
      await service.switchSessionBranch(originalLeaf);
      assert.ok(service.getSnapshot().messages.length >= fullCount, 'returning to the original leaf restores the branch');
    });

    await test('exports write readable HTML and JSONL files', async () => {
      const htmlPath = join(tempRoot, 'export.html');
      const html = await service.exportSession(htmlPath, 'html');
      assert.equal(html, htmlPath);
      assert.ok(existsSync(htmlPath));
      // Pi embeds the transcript as escaped data inside a standalone viewer; assert structure, not literal text.
      const htmlBody = readFileSync(htmlPath, 'utf8');
      assert.ok(htmlBody.startsWith('<!DOCTYPE html>'));
      assert.ok(htmlBody.includes('Session Export'));
      const jsonlPath = join(tempRoot, 'export.jsonl');
      const jsonl = await service.exportSession(jsonlPath, 'jsonl');
      assert.equal(jsonl, jsonlPath);
      const lines = readFileSync(jsonlPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(lines[0].type, 'session');
      assert.ok(lines.some((line) => line.type === 'message'));
      await assert.rejects(() => service.exportSession('', 'html'), /导出路径无效/);
    });
  } finally {
    await service?.dispose().catch(() => {});
    rmSync(tempRoot, { recursive: true, force: true });
    for (const [name, value] of environment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
