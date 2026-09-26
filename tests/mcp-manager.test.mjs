import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { McpManager, mcpToolName } from '../packages/agent/src/mcpManager.ts';

const fixturePath = fileURLToPath(new URL('./fixtures/mcp/stdio-server.mjs', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-mcp-')), cwd = join(root, 'workspace'), agentDir = join(root, 'agent');
  await mkdir(cwd); await mkdir(agentDir);
  const manager = new McpManager(agentDir), value = { root, cwd, agentDir, manager };
  t.after(async () => { await value.beforeCleanup?.(); await manager.dispose(); await rm(root, { recursive: true, force: true }); });
  return value;
}
async function owner(manager, cwd, sessionId, trusted = true) {
  const handlers = new Map(), tools = new Map(); let active = ['read', 'bash'];
  const pi = { on: (event, callback) => handlers.set(event, callback), registerTool: definition => tools.set(definition.name, definition),
    getAllTools: () => [...tools.values()], getActiveTools: () => active, setActiveTools: values => { active = values; } };
  await manager.extension(cwd, sessionId)(pi); await handlers.get('session_start')({}, { isProjectTrusted: () => trusted });
  return { pi, tools, active: () => active, invoke: (name, args, signal) => tools.get(name).execute('call', args, signal, undefined, { isProjectTrusted: () => trusted }) };
}
function config(id, args = []) { return { id, name: `Server ${id}`, enabled: true, transport: 'stdio', command: process.execPath, args: [fixturePath, ...args], requestTimeoutMs: 1500 }; }
function target(f, id, scope = 'user', sessionId = 'session-one') { return { cwd: f.cwd, sessionId, scope, id }; }
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('stdio tools register into a specific session, calls execute, disable/disconnect prevent calls and owned processes exit', async t => {
  const f = await fixture(t), first = await owner(f.manager, f.cwd, 'session-one'), second = await owner(f.manager, f.cwd, 'session-two');
  const pidPath = join(f.root, 'pid.json'), server = config('echo', ['tree', pidPath]);
  await f.manager.save({ ...target(f, 'echo'), config: server });
  assert.equal(first.tools.size, 0); assert.equal((await f.manager.snapshot('session-one')).servers[0].status, 'disconnected');
  const connected = await f.manager.connect(target(f, 'echo')), tool = connected.servers[0].tools[0].registeredName;
  assert.ok(first.active().includes(tool)); assert.equal(second.tools.size, 0);
  assert.match((await first.invoke(tool, { text: 'hello' })).content[0].text, /echo:hello/);
  const { pid, child } = JSON.parse(await readFile(pidPath, 'utf8')); assert.ok(alive(pid)); assert.ok(alive(child));
  await f.manager.disconnect(target(f, 'echo'));
  assert.ok(!first.active().includes(tool)); await assert.rejects(first.invoke(tool, { text: 'later' }), /断开/);
  assert.equal(alive(pid), false); assert.equal(alive(child), false);
  await f.manager.connect(target(f, 'echo'));
  await f.manager.save({ ...target(f, 'echo'), config: { ...server, enabled: false } });
  await assert.rejects(first.invoke(tool, { text: 'disabled' }), /断开/);
  await assert.rejects(f.manager.connect(target(f, 'echo')), /禁用/);
});

test('manual tests do not register tools; trust, workspace ownership, name collision and timeout failures are isolated', async t => {
  const f = await fixture(t), first = await owner(f.manager, f.cwd, 'session-one', false);
  await assert.rejects(f.manager.save({ ...target(f, 'untrusted', 'project'), config: config('untrusted') }), /尚未受信任/);
  await f.manager.save({ ...target(f, 'test'), config: config('test') });
  const result = await f.manager.test(target(f, 'test')); assert.equal(result.tools.length, 1); assert.equal(first.tools.size, 0);
  await assert.rejects(f.manager.connect({ ...target(f, 'test'), cwd: f.root }), /不属于/);
  const conflict = mcpToolName('user', 'test', 'echo.test'); first.tools.set(conflict, { name: conflict });
  await assert.rejects(f.manager.connect(target(f, 'test')), /冲突/); assert.deepEqual(first.active(), ['read', 'bash']);
  await f.manager.save({ ...target(f, 'hang'), config: config('hang', ['hang']) });
  const started = Date.now(); await assert.rejects(f.manager.connect(target(f, 'hang')), /MCP/);
  assert.ok(Date.now() - started < 7000); assert.equal((await f.manager.snapshot('session-one')).servers.find(server => server.id === 'hang').status, 'error');
  assert.deepEqual(first.active(), ['read', 'bash']);
});

test('HTTP transport discovers and invokes real tools with credential references and cancellation', async t => {
  const f = await fixture(t), first = await owner(f.manager, f.cwd, 'session-one');
  let authorized = false;
  const http = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    authorized ||= request.headers.authorization === 'Bearer fixture-value';
    if (!('id' in rpc)) { response.writeHead(202).end(); return; }
    let result;
    if (rpc.method === 'initialize') result = { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'http-fixture', version: '1' } };
    else if (rpc.method === 'tools/list') result = { tools: [{ name: 'sum', description: 'Sum', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } }] };
    else result = { content: [{ type: 'text', text: String(rpc.params.arguments.a + rpc.params.arguments.b) }] };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await f.manager.dispose(); await new Promise(resolve => http.close(resolve)); delete process.env.PI_MCP_FIXTURE_AUTH; });
  process.env.PI_MCP_FIXTURE_AUTH = 'Bearer fixture-value';
  const server = { id: 'http', name: 'HTTP fixture', enabled: true, transport: 'http', url: `http://127.0.0.1:${http.address().port}/mcp`, headers: { Authorization: 'PI_MCP_FIXTURE_AUTH' }, requestTimeoutMs: 1500 };
  await f.manager.save({ ...target(f, 'http'), config: server });
  const snapshot = await f.manager.connect(target(f, 'http')), tool = snapshot.servers[0].tools[0].registeredName;
  assert.equal((await first.invoke(tool, { a: 7, b: 4 })).content[0].text, '11'); assert.equal(authorized, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /fixture-value/); assert.doesNotMatch(await readFile(join(f.agentDir, 'mcp-servers.json'), 'utf8'), /fixture-value/);
  const signal = AbortSignal.abort(); await assert.rejects(first.invoke(tool, { a: 1, b: 2 }, signal), /MCP/);
});

test('disconnect cancels a pending handshake and disposal closes a connected session', async t => {
  const f = await fixture(t); await owner(f.manager, f.cwd, 'session-one');
  const pidPath = join(f.root, 'hang-pid.json');
  await f.manager.save({ ...target(f, 'hang'), config: { ...config('hang', ['hang', pidPath]), requestTimeoutMs: 10_000 } });
  const connecting = f.manager.connect(target(f, 'hang'));
  let pid;
  for (let attempt = 0; attempt < 50; attempt++) { try { pid = JSON.parse(await readFile(pidPath, 'utf8')).pid; break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
  assert.ok(pid);
  const started = Date.now(); await f.manager.disconnect(target(f, 'hang')); await connecting;
  assert.ok(Date.now() - started < 3000); assert.equal(alive(pid), false); assert.equal((await f.manager.snapshot('session-one')).servers[0].status, 'disconnected');
  await f.manager.save({ ...target(f, 'echo'), config: config('echo', ['normal', pidPath]) });
  await f.manager.connect(target(f, 'echo')); pid = JSON.parse(await readFile(pidPath, 'utf8')).pid;
  await f.manager.disposeOwner('session-one'); assert.equal(alive(pid), false); await assert.rejects(f.manager.snapshot('session-one'), /关闭/);
});

test('the real Pi SDK session exposes and executes the MCP adapter and workspace switches cannot inherit it', async t => {
  const f = await fixture(t), previousDirectory = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.agentDir;
  const { AgentService } = await import('../packages/agent/src/index.ts');
  const service = new AgentService();
  f.beforeCleanup = async () => { await service.dispose(); if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDirectory; };
  await service.init({ cwd: f.cwd });
  const initial = await service.getMcpSnapshot(), request = { cwd: f.cwd, sessionId: initial.sessionId, scope: 'user', id: 'sdk-echo' };
  await service.saveMcpServer({ ...request, config: config('sdk-echo') });
  const connected = await service.connectMcpServer(request), toolName = connected.servers[0].tools[0].registeredName;
  const session = service.active.runtime.session;
  assert.ok(session.getActiveToolNames().includes(toolName));
  const tool = session.agent.state.tools.find(value => value.name === toolName);
  assert.ok(tool, 'the MCP tool must be installed in Pi agent state, not just UI metadata');
  assert.match((await tool.execute('sdk-call', { text: 'through-pi' })).content[0].text, /echo:through-pi/);
  const secondCwd = join(f.root, 'second-project'); await mkdir(secondCwd); await service.switchWorkspace(secondCwd);
  assert.ok(!service.active.runtime.session.getActiveToolNames().includes(toolName));
  await assert.rejects(async () => service.connectMcpServer(request), /所属会话已改变/);
  assert.equal((await service.getMcpSnapshot()).servers[0].status, 'disconnected');
});
