import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// 回归：前台新建的对话在第一条消息落盘后必须发出 sessions-changed。
// 主进程的会话列表缓存只靠该事件失效；漏发时侧栏一直拿到新建瞬间（文件尚未
// 写盘）的旧快照，切到别的对话后新对话就从侧栏消失。

const tick = () => new Promise(resolve => setImmediate(resolve));
const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', api: 'anthropic-messages',
  provider: 'anthropic', model: 'fixture', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

test('a foreground new conversation announces its first persisted turn to the session listing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-new-session-listing-'));
  const cwd = join(root, 'project'); await mkdir(cwd);
  const saved = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map(key => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent'); process.env.PI_OFFLINE = '1';
  const { AgentService } = await import('../packages/agent/src/index.ts');
  const service = new AgentService(async () => ({ trusted: true, remember: false }));
  t.after(async () => { await service.dispose(); for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value; await rm(root, { recursive: true, force: true }); });
  await service.init({ cwd });

  await service.newSession();
  const path = service.getSnapshot().sessionPath;
  assert.equal(existsSync(path), false, 'Pi has not written the new transcript yet');
  assert.ok(!(await service.listSessions(cwd)).some(row => row.path === path), 'the listing taken at creation misses the new conversation');

  // Each record carries what a listing rebuilt at that moment would contain.
  const changes = [];
  const pending = [];
  service.onEvent(({ event }) => {
    if (event.type !== 'sessions-changed' || event.cwd !== cwd) return;
    const change = { status: service.getSnapshot().status, listed: false };
    changes.push(change);
    pending.push(service.listSessions(cwd).then(rows => { change.listed = rows.some(row => row.path === path); }));
  });

  const session = service.active.runtime.session;
  const user = { role: 'user', content: '新对话的第一条消息', timestamp: Date.now() };
  const reply = assistant('回复');
  await session._handleAgentEvent({ type: 'agent_start' });
  await session._handleAgentEvent({ type: 'message_start', message: user });
  await session._handleAgentEvent({ type: 'message_end', message: user });
  await Promise.all(pending);
  assert.ok(changes.some(change => change.status === 'busy' && change.listed), 'accepted input invalidates the listing while the turn runs');

  await session._handleAgentEvent({ type: 'message_start', message: reply });
  await session._handleAgentEvent({ type: 'message_end', message: reply });
  await session._handleAgentEvent({ type: 'agent_end', messages: [user, reply] });
  await session._emitAgentSettled(); await tick();
  await Promise.all(pending);

  assert.equal(service.getSnapshot().sessionPath, path, 'the conversation stayed in the foreground');
  assert.equal(existsSync(path), true);
  const settled = changes.at(-1);
  assert.equal(settled.status, 'idle', 'the settled turn invalidates the listing again');
  assert.equal(settled.listed, true, 'a listing rebuilt after the turn contains the new conversation');
});
