import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('real AgentService gates an MCP-only project and registers/disposes its session-owned extension', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-mcp-agent-')), cwd = join(root, 'workspace'), agent = join(root, 'agent');
  await Promise.all([mkdir(join(cwd, '.pi'), { recursive: true }), mkdir(agent)]);
  const prior = { dir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
  process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_OFFLINE = '1';
  const config = { id: 'echo', name: 'Echo', enabled: true, transport: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp/stdio-server.mjs', import.meta.url))], requestTimeoutMs: 1500 };
  await writeFile(join(cwd, '.pi', 'mcp-servers.json'), JSON.stringify({ version: 1, servers: [config] }));
  const { AgentService } = await import('../packages/agent/src/index.ts');
  let prompts = 0;
  const service = new AgentService(async () => { prompts++; return { trusted: true, remember: false }; });
  t.after(async () => { await service.dispose(); if (prior.dir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior.dir; if (prior.offline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = prior.offline; await rm(root, { recursive: true, force: true }); });
  await service.init({ cwd }); assert.equal(prompts, 1, 'an MCP-only project must still trigger a trust decision');
  const initial = await service.getMcpSnapshot(); assert.equal(initial.projectTrusted, true); assert.equal(initial.servers[0].status, 'disconnected');
  const target = { cwd, sessionId: initial.sessionId, scope: 'project', id: 'echo' };
  assert.throws(() => service.connectMcpServer({ ...target, sessionId: 'stale' }), /会话已改变/);
  const connected = await service.connectMcpServer(target); assert.equal(connected.servers[0].status, 'connected'); assert.equal(connected.servers[0].tools.length, 1);
  await service.active.newSession();
  const replaced = await service.getMcpSnapshot(); assert.notEqual(replaced.sessionId, initial.sessionId); assert.equal(replaced.servers[0].status, 'disconnected');
  await assert.rejects(service.mcp.snapshot(initial.sessionId), /关闭/);
  await service.dispose(); assert.equal(service.mcp.owners.size, 0);
});
