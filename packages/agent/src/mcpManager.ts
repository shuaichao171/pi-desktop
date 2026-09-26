import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpScope, UiMcpSaveRequest, UiMcpServer, UiMcpServerConfig, UiMcpSnapshot, UiMcpTarget, UiMcpTool } from '../../shared/src/mcpFeatures';

const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_TOOL_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
type ConfigFile = { version: 1; servers: UiMcpServerConfig[] };
type Connection = { client: Client; transport: Transport; config: UiMcpServerConfig; tools: UiMcpTool[]; definitions: Tool[]; active: boolean; controller: AbortController; close?: Promise<void> };
type Owner = { cwd: string; sessionId: string; pi: ExtensionAPI; trusted: boolean; connections: Map<string, Connection>; states: Map<string, Pick<UiMcpServer, 'status' | 'error' | 'tools'>>; registered: Set<string>; operations: Map<string, Promise<unknown>>; generations: Map<string, number> };
class McpLocalError extends Error {}
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/u.test(value); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function refs(value: unknown, header = false): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (!object(value) || Object.keys(value).length > 50) throw new McpLocalError('MCP 凭据引用无效');
	for (const [key, reference] of Object.entries(value)) if (!(header ? /^[!#$%&'*+.^_`|~\w-]+$/u : /^[A-Za-z_][A-Za-z0-9_]*$/u).test(key) || !text(reference, 200) || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(reference)) throw new McpLocalError('MCP 凭据必须引用有效的环境变量名称');
	return { ...value } as Record<string, string>;
}
export function validateMcpConfig(value: unknown): UiMcpServerConfig {
	if (!object(value) || !text(value.id, 100) || !/^[A-Za-z0-9_-]+$/u.test(value.id) || !text(value.name, 80) || typeof value.enabled !== 'boolean'
		|| value.transport !== 'stdio' && value.transport !== 'http' || typeof value.requestTimeoutMs !== 'number' || !Number.isInteger(value.requestTimeoutMs) || value.requestTimeoutMs < 1000 || value.requestTimeoutMs > 120_000) throw new McpLocalError('MCP 服务器配置无效；超时范围为 1–120 秒');
	const config: UiMcpServerConfig = { id: value.id, name: value.name.trim(), enabled: value.enabled, transport: value.transport, requestTimeoutMs: value.requestTimeoutMs };
	if (value.transport === 'stdio') {
		if (!text(value.command, 32768) || value.args !== undefined && (!Array.isArray(value.args) || value.args.length > 100 || value.args.some((arg) => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0')))) throw new McpLocalError('MCP 启动命令或参数无效');
		config.command = value.command; config.args = (value.args ?? []) as string[]; config.environment = refs(value.environment);
	} else {
		if (!text(value.url, 4096)) throw new McpLocalError('MCP HTTP 地址无效');
		const url = new URL(value.url);
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new McpLocalError('MCP 地址仅支持不含内嵌凭据的 HTTP/HTTPS');
		config.url = url.href; config.headers = refs(value.headers, true);
	}
	return config;
}
function key(scope: McpScope, id: string): string { return `${scope}:${id}`; }
export function mcpToolName(scope: McpScope, id: string, name: string): string {
	return `mcp_${createHash('sha256').update(`${scope}:${id}`).digest('hex').slice(0, 10)}_${name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 29)}_${createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
}
function safeError(error: unknown): string {
	// Transport errors can contain headers/URLs or subprocess stderr. Keep only
	// known local validation messages and protocol codes in persisted UI state.
	const value = error instanceof Error ? error.message : String(error);
	if (error instanceof McpLocalError) return value.slice(0, 500);
	const code = object(error) && typeof error.code === 'number' ? ` (${error.code})` : '';
	return `MCP 连接或调用失败${code}，请检查地址、程序、凭据引用和服务器状态`;
}
async function atomicWrite(path: string, value: ConfigFile): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.${randomUUID()}.tmp`;
	try { const file = await open(temp, 'wx', 0o600); try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); } finally { await file.close(); } await rename(temp, path); }
	finally { await rm(temp, { force: true }); }
}

export class McpManager {
	private readonly agentDir: string;
	private readonly owners = new Map<string, Owner>();
	private configQueue: Promise<void> = Promise.resolve();
	private disposed = false;
	constructor(agentDir: string) { this.agentDir = agentDir; }

	extension(cwd: string, sessionId: string): ExtensionFactory {
		return async (pi) => {
			if (this.disposed) throw new McpLocalError('MCP 管理器已经关闭');
			await this.disposeOwner(sessionId);
			const owner: Owner = { cwd, sessionId, pi, trusted: false, connections: new Map(), states: new Map(), registered: new Set(), operations: new Map(), generations: new Map() };
			this.owners.set(sessionId, owner);
			pi.on('session_start', (_event, context) => { owner.trusted = context.isProjectTrusted(); });
			pi.on('session_shutdown', async () => { if (this.owners.get(sessionId) === owner) await this.disposeOwner(sessionId); });
		};
	}
	private owner(id: string): Owner {
		const owner = this.owners.get(id);
		if (this.disposed || !owner) throw new McpLocalError('此会话已经关闭，请重新打开后管理 MCP');
		return owner;
	}
	private target(request: UiMcpTarget | UiMcpSaveRequest): Owner {
		if (!request || typeof request !== 'object' || !text(request.sessionId, 300) || typeof request.cwd !== 'string' || !isAbsolute(request.cwd)
			|| request.scope !== 'user' && request.scope !== 'project') throw new McpLocalError('MCP 请求身份无效');
		const owner = this.owner(request.sessionId);
		if (resolve(owner.cwd) !== resolve(request.cwd)) throw new McpLocalError('此会话不属于请求的工作区');
		if (request.scope === 'project' && !owner.trusted) throw new McpLocalError('项目尚未受信任，无法管理或连接项目 MCP');
		return owner;
	}
	private configPath(owner: Owner, scope: McpScope): string { return scope === 'user' ? join(this.agentDir, 'mcp-servers.json') : join(owner.cwd, '.pi', 'mcp-servers.json'); }
	private async configs(owner: Owner, scope: McpScope): Promise<UiMcpServerConfig[]> {
		if (scope === 'project' && !owner.trusted) return [];
		const path = this.configPath(owner, scope);
		let raw: string;
		try { const details = await lstat(path); if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_CONFIG_BYTES) throw new McpLocalError('MCP 配置文件类型或大小无效'); raw = await readFile(path, 'utf8'); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
		let value: unknown;
		try { value = JSON.parse(raw); } catch { throw new McpLocalError('MCP 配置文件损坏，原文件已保留'); }
		if (!object(value) || value.version !== 1 || !Array.isArray(value.servers) || value.servers.length > 50) throw new McpLocalError('MCP 配置版本或服务器数量无效');
		const servers = value.servers.map(validateMcpConfig);
		if (new Set(servers.map((server) => server.id)).size !== servers.length) throw new McpLocalError('MCP 配置服务器编号重复');
		return servers;
	}
	async snapshot(sessionId: string): Promise<UiMcpSnapshot> {
		const owner = this.owner(sessionId), servers: UiMcpServer[] = [];
		for (const scope of ['user', 'project'] as const) for (const config of await this.configs(owner, scope)) {
			const state = owner.states.get(key(scope, config.id));
			servers.push({ ...config, scope, status: state?.status ?? 'disconnected', tools: state?.tools ?? [], ...(state?.error ? { error: state.error } : {}) });
		}
		return { cwd: owner.cwd, sessionId, projectTrusted: owner.trusted, servers };
	}
	private enqueue<T>(action: () => Promise<T>): Promise<T> {
		const result = this.configQueue.then(action); this.configQueue = result.then(() => undefined, () => undefined); return result;
	}
	async save(request: UiMcpSaveRequest): Promise<UiMcpSnapshot> {
		const owner = this.target(request), config = validateMcpConfig(request.config);
		await this.enqueue(async () => {
			const list = await this.configs(owner, request.scope), index = list.findIndex((server) => server.id === config.id);
			if (index < 0) list.push(config); else list[index] = config;
			if (list.length > 50) throw new McpLocalError('MCP 每个作用域最多保存 50 个服务器');
			const payload: ConfigFile = { version: 1, servers: list };
			if (Buffer.byteLength(JSON.stringify(payload)) > MAX_CONFIG_BYTES) throw new McpLocalError('MCP 配置超过 512 KiB');
			await atomicWrite(this.configPath(owner, request.scope), payload);
			// A configuration change invalidates old credentials/tool schemas in all
			// affected sessions. Reconnection always requires another explicit click.
			for (const other of this.owners.values()) if (request.scope === 'user' || resolve(other.cwd) === resolve(owner.cwd)) await this.disconnectOwner(other, key(request.scope, config.id));
		});
		return this.snapshot(owner.sessionId);
	}
	async remove(request: UiMcpTarget): Promise<UiMcpSnapshot> {
		const owner = this.target(request);
		await this.enqueue(async () => {
			const list = await this.configs(owner, request.scope);
			await atomicWrite(this.configPath(owner, request.scope), { version: 1, servers: list.filter((config) => config.id !== request.id) });
			for (const other of this.owners.values()) if (request.scope === 'user' || resolve(other.cwd) === resolve(owner.cwd)) await this.disconnectOwner(other, key(request.scope, request.id));
		});
		return this.snapshot(owner.sessionId);
	}
	private resolvedReferences(values?: Record<string, string>): Record<string, string> {
		const resolved: Record<string, string> = {};
		for (const [name, reference] of Object.entries(values ?? {})) {
			const value = process.env[reference];
			if (value === undefined) throw new McpLocalError(`凭据引用 ${reference} 对应的环境变量不存在`);
			if (value.length > 32768 || value.includes('\0')) throw new McpLocalError(`凭据引用 ${reference} 的值无效`);
			resolved[name] = value;
		}
		return resolved;
	}
	private async createConnection(owner: Owner, scope: McpScope, config: UiMcpServerConfig, created: (connection: Connection) => void): Promise<Connection> {
		const controller = new AbortController();
		const transport: Transport = config.transport === 'stdio'
			? new StdioClientTransport({ command: config.command!, args: config.args, env: this.resolvedReferences(config.environment), cwd: owner.cwd, stderr: 'pipe', maxBufferSize: MAX_RESULT_BYTES })
			: new StreamableHTTPClientTransport(new URL(config.url!), { requestInit: { headers: this.resolvedReferences(config.headers), redirect: 'error' },
				reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } });
		if (transport instanceof StdioClientTransport) transport.stderr?.on('data', () => {});
		const client = new Client({ name: 'pi-desktop', version: '1.0.0' }, { capabilities: {} });
		const connection: Connection = { client, transport, config, tools: [], definitions: [], active: false, controller };
		created(connection);
		const timer = setTimeout(() => { controller.abort(); void this.closeConnection(connection); }, config.requestTimeoutMs);
		try {
			await client.connect(transport, { signal: controller.signal, timeout: config.requestTimeoutMs });
			let cursor: string | undefined;
			const cursors = new Set<string>();
			do {
				const result = await client.listTools(cursor ? { cursor } : undefined, { signal: controller.signal, timeout: config.requestTimeoutMs });
				for (const tool of result.tools) {
					if (!text(tool.name, 256) || !object(tool.inputSchema) || tool.inputSchema.type !== 'object' || Buffer.byteLength(JSON.stringify(tool)) > MAX_TOOL_BYTES || connection.definitions.length >= 256) throw new McpLocalError('MCP 工具清单超过限制或格式无效');
					if (connection.definitions.some((known) => known.name === tool.name)) throw new McpLocalError('工具名称在服务器清单中重复');
					connection.definitions.push(tool);
					connection.tools.push({ name: tool.name, registeredName: mcpToolName(scope, config.id, tool.name), description: (tool.description ?? '').slice(0, 10_000) });
				}
				cursor = result.nextCursor;
				if (cursor && cursors.has(cursor)) throw new McpLocalError('MCP 工具分页游标循环');
				if (cursor) cursors.add(cursor);
			} while (cursor);
			if (controller.signal.aborted) throw new McpLocalError('MCP 连接已取消或超时');
			return connection;
		} catch (error) { await this.closeConnection(connection); throw new McpLocalError(safeError(error)); }
		finally { clearTimeout(timer); }
	}
	private async closeConnection(connection: Connection): Promise<void> {
		if (connection.close) return connection.close;
		connection.active = false; connection.controller.abort();
		connection.close = (async () => {
			// taskkill targets only the PID owned by this live transport. Killing the
			// tree before closing the parent avoids orphaned Windows subprocesses.
			const pid = connection.transport instanceof StdioClientTransport ? connection.transport.pid : null;
			if (process.platform === 'win32' && pid) await new Promise<void>((done) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => done()));
			await connection.client.close().catch(() => {});
			await connection.transport.close().catch(() => {});
		})();
		return connection.close;
	}
	private removeActiveTools(owner: Owner, tools: UiMcpTool[]): void {
		const removed = new Set(tools.map((tool) => tool.registeredName));
		try { owner.pi.setActiveTools(owner.pi.getActiveTools().filter((name) => !removed.has(name))); } catch { /* SDK may already be disposing this runtime. */ }
	}
	private async disconnectOwner(owner: Owner, serverKey: string): Promise<void> {
		owner.generations.set(serverKey, (owner.generations.get(serverKey) ?? 0) + 1);
		const connection = owner.connections.get(serverKey);
		owner.connections.delete(serverKey);
		owner.states.set(serverKey, { status: 'disconnected', tools: [] });
		if (connection) { this.removeActiveTools(owner, connection.tools); await this.closeConnection(connection); }
	}
	async connect(request: UiMcpTarget): Promise<UiMcpSnapshot> {
		const owner = this.target(request), serverKey = key(request.scope, request.id);
		const previous = owner.operations.get(serverKey);
		if (previous) { await previous; return this.snapshot(owner.sessionId); }
		const operation = (async () => {
			const closing = this.disconnectOwner(owner, serverKey), generation = owner.generations.get(serverKey);
			await closing;
			const config = (await this.configs(owner, request.scope)).find((server) => server.id === request.id);
			if (owner.generations.get(serverKey) !== generation || this.owners.get(owner.sessionId) !== owner) return;
			if (!config || !config.enabled) throw new McpLocalError('服务器不存在或已禁用');
			owner.states.set(serverKey, { status: 'connecting', tools: [] });
			let connection: Connection | undefined;
			try {
				connection = await this.createConnection(owner, request.scope, config, (pending) => { owner.connections.set(serverKey, pending); });
				if (this.owners.get(owner.sessionId) !== owner || owner.generations.get(serverKey) !== generation || owner.states.get(serverKey)?.status !== 'connecting') throw new McpLocalError('MCP 连接已取消');
				const currentConfig = (await this.configs(owner, request.scope)).find((server) => server.id === request.id);
				if (!currentConfig?.enabled || JSON.stringify(currentConfig) !== JSON.stringify(config)) throw new McpLocalError('MCP 配置已改变，请重新连接');
				const known = new Set(owner.pi.getAllTools().map((tool) => tool.name));
				for (const tool of connection.tools) if (known.has(tool.registeredName) && !owner.registered.has(tool.registeredName)) throw new McpLocalError(`工具名称冲突：${tool.registeredName}`);
				const captured = connection;
				connection.active = true; owner.connections.set(serverKey, connection);
				for (const [index, tool] of connection.tools.entries()) {
					const definition = connection.definitions[index]!;
					owner.pi.registerTool({ name: tool.registeredName, label: `${config.name}: ${tool.name}`, description: tool.description || `MCP tool ${tool.name}`,
						promptSnippet: `${config.name}: ${tool.name}`, parameters: definition.inputSchema as ToolDefinition['parameters'],
						execute: async (_id, args, signal, _update, context) => {
							if (request.scope === 'project' && !context.isProjectTrusted()) throw new McpLocalError('项目尚未受信任，MCP 工具已停用');
							return this.call(owner, serverKey, captured, tool.name, args, signal);
						} });
					owner.registered.add(tool.registeredName);
				}
				owner.pi.setActiveTools([...new Set([...owner.pi.getActiveTools(), ...connection.tools.map((tool) => tool.registeredName)])]);
				connection.client.onclose = () => {
					if (owner.connections.get(serverKey) !== captured) return;
					captured.active = false; this.removeActiveTools(owner, captured.tools); owner.connections.delete(serverKey);
					owner.states.set(serverKey, { status: 'error', tools: [], error: 'MCP 服务器连接已关闭，请手动重新连接' });
				};
				owner.states.set(serverKey, { status: 'connected', tools: connection.tools });
			} catch (error) {
				if (connection) { this.removeActiveTools(owner, connection.tools); await this.closeConnection(connection); }
				if (owner.generations.get(serverKey) !== generation || this.owners.get(owner.sessionId) !== owner) return;
				owner.connections.delete(serverKey); owner.states.set(serverKey, { status: 'error', tools: [], error: safeError(error) });
				throw new McpLocalError(safeError(error));
			}
		})();
		owner.operations.set(serverKey, operation);
		try { await operation; } finally { if (owner.operations.get(serverKey) === operation) owner.operations.delete(serverKey); }
		return this.snapshot(owner.sessionId);
	}
	private async call(owner: Owner, serverKey: string, connection: Connection, name: string, args: unknown, signal?: AbortSignal) {
		if (this.owners.get(owner.sessionId) !== owner || owner.connections.get(serverKey) !== connection || !connection.active) throw new McpLocalError('连接已断开，MCP 工具不可用');
		if (!object(args) || Buffer.byteLength(JSON.stringify(args)) > MAX_RESULT_BYTES) throw new McpLocalError('MCP 工具参数超过 2 MiB 或不是对象');
		const combined = AbortSignal.any([connection.controller.signal, ...(signal ? [signal] : [])]);
		try {
			const result = await connection.client.callTool({ name, arguments: args }, undefined, { signal: combined, timeout: connection.config.requestTimeoutMs });
			if (!connection.active || combined.aborted) throw new McpLocalError('MCP 调用已取消');
			if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) throw new McpLocalError('MCP 工具结果超过 2 MiB');
			const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
			if (!Array.isArray(result.content)) throw new McpLocalError('MCP 工具结果格式无效');
			for (const item of result.content) {
				if (item.type === 'text' && typeof item.text === 'string') content.push({ type: 'text', text: item.text });
				else if (item.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string') content.push({ type: 'image', data: item.data, mimeType: item.mimeType });
				else content.push({ type: 'text', text: JSON.stringify(item) });
			}
			if (result.isError) throw new McpLocalError('MCP 服务器报告工具执行失败');
			return { content: content.length ? content : [{ type: 'text' as const, text: 'MCP tool completed.' }], details: { serverId: connection.config.id, tool: name } };
		} catch (error) { owner.states.set(serverKey, { status: connection.active ? 'connected' : 'error', tools: connection.tools, error: safeError(error) }); throw new McpLocalError(safeError(error)); }
	}
	async disconnect(request: UiMcpTarget): Promise<UiMcpSnapshot> {
		const owner = this.target(request); await this.disconnectOwner(owner, key(request.scope, request.id)); return this.snapshot(owner.sessionId);
	}
	async test(request: UiMcpTarget): Promise<{ tools: UiMcpTool[]; elapsedMs: number }> {
		const owner = this.target(request), config = (await this.configs(owner, request.scope)).find((server) => server.id === request.id);
		if (!config || !config.enabled) throw new McpLocalError('服务器不存在或已禁用');
		const started = Date.now(), testKey = `test:${request.id}:${randomUUID()}`;
		const operation = (async () => {
			const connection = await this.createConnection(owner, request.scope, config, (pending) => {
				if (this.owners.get(owner.sessionId) !== owner) throw new McpLocalError('此会话已经关闭');
				owner.connections.set(testKey, pending);
			});
			try { return { tools: connection.tools, elapsedMs: Date.now() - started }; }
			finally { owner.connections.delete(testKey); await this.closeConnection(connection); }
		})();
		owner.operations.set(testKey, operation);
		try { return await operation; } finally { owner.operations.delete(testKey); }
	}
	async disposeOwner(sessionId: string): Promise<void> {
		const owner = this.owners.get(sessionId); if (!owner) return;
		this.owners.delete(sessionId);
		for (const serverKey of new Set([...owner.states.keys(), ...owner.connections.keys()])) await this.disconnectOwner(owner, serverKey);
		await Promise.allSettled([...owner.operations.values()]);
	}
	async dispose(): Promise<void> {
		this.disposed = true;
		await Promise.all([...this.owners.keys()].map((id) => this.disposeOwner(id))); await this.configQueue;
	}
}
