import type { ChildProcess } from 'node:child_process';
import { AsyncResource } from 'node:async_hooks';
import { killProcessTree } from '../shellInterrupt.ts';
import { withSystemProxy } from './agentProxy.ts';
import { withClaudeCodeExecutable } from './claudeExecutable.ts';
import { resolveCommand, spawnResolved, withAgentSearchPath } from './command.ts';
import { AcpRequestError, type JsonRpcError, type JsonRpcMessage } from './protocol.ts';

const MAX_LINE_BYTES = 32 * 1024 * 1024;
const STDERR_TAIL_CHARS = 4000;

export interface AcpConnectionOptions {
	command: string;
	args: string[];
	cwd: string;
	env?: Record<string, string>;
	/** Resolved system proxy to pass as HTTP(S)_PROXY. */
	proxy?: string | null;
	/** Notifications from the agent (e.g. `session/update`). */
	onNotification(method: string, params: unknown): void;
	/** Requests from the agent; the resolved value is the JSON-RPC result. */
	onRequest(method: string, params: unknown, signal: AbortSignal): Promise<unknown>;
	/** The agent process ended (crash, exit, or close()). */
	onExit?(detail: { code: number | null; signal: string | null; stderr: string; expected: boolean }): void;
}

interface Pending {
	method: string;
	resolve(value: unknown): void;
	reject(error: Error): void;
	cleanup(): void;
}

/**
 * One ACP agent process: newline-delimited JSON-RPC 2.0 over stdio. The whole
 * process tree is killed on close so shells and MCP servers the agent started
 * do not outlive it.
 */
export class AcpConnection {
	private readonly child: ChildProcess;
	private readonly options: AcpConnectionOptions;
	private readonly pending = new Map<number, Pending>();
	private readonly incoming = new Map<number | string, AbortController>();
	private nextId = 0;
	private buffer = '';
	private stderrTail = '';
	private closed = false;
	private closing = false;
	private exited: Promise<void>;

	private constructor(child: ChildProcess, options: AcpConnectionOptions) {
		this.child = child;
		this.options = options;
		let markExited!: () => void;
		this.exited = new Promise((resolve) => { markExited = resolve; });
		child.stdout!.setEncoding('utf8');
		child.stdout!.on('data', (chunk: string) => this.onStdout(chunk));
		child.stderr!.setEncoding('utf8');
		child.stderr!.on('data', (chunk: string) => {
			this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
		});
		child.stdin!.on('error', () => { /* surfaced through exit */ });
		const finish = (code: number | null, signal: string | null, spawnError?: Error) => {
			if (this.closed) return;
			this.closed = true;
			const stderr = this.stderrTail.trim();
			const reason = spawnError
				? `Agent 启动失败：${spawnError.message}`
				: `Agent 进程已退出（${code ?? signal ?? '未知'}）${stderr ? `：${stderr.split('\n').slice(-3).join(' ')}` : ''}`;
			for (const [, pending] of this.pending) pending.reject(new Error(reason));
			this.pending.clear();
			for (const controller of this.incoming.values()) controller.abort();
			this.incoming.clear();
			this.options.onExit?.({ code, signal, stderr, expected: this.closing });
			markExited();
		};
		child.once('error', (error) => finish(null, null, error));
		child.once('exit', (code, signal) => finish(code, signal));
	}

	/** Resolve and start the agent; throws when the executable cannot be found. */
	static start(options: AcpConnectionOptions): AcpConnection {
		const base = withAgentSearchPath({ ...process.env, ...options.env });
		const env = withSystemProxy(base, options.proxy);
		const resolved = resolveCommand(options.command, env);
		if (!resolved) throw new Error(`找不到 Agent 命令：${options.command}`);
		const child = spawnResolved(resolved, options.args, {
			cwd: options.cwd,
			env: withClaudeCodeExecutable(resolved, env),
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
			// POSIX: own process group so close() can signal the whole tree.
			detached: process.platform !== 'win32',
		});
		return new AcpConnection(child, options);
	}

	get alive(): boolean { return !this.closed; }
	get pid(): number | undefined { return this.child.pid; }

	request<T>(method: string, params: unknown, { signal, onResult }: { signal?: AbortSignal; onResult?(value: T): void } = {}): Promise<T> {
		if (this.closed) return Promise.reject(new Error('Agent 进程已退出'));
		if (signal?.aborted) return Promise.reject(new Error('请求已取消'));
		const id = ++this.nextId;
		// A steer acknowledgement must be recorded before reading later updates in the same stdout chunk.
		const commit = onResult && AsyncResource.bind(onResult);
		return new Promise<T>((resolve, reject) => {
			const abort = () => {
				if (!this.pending.delete(id)) return;
				reject(new Error('请求已取消'));
			};
			signal?.addEventListener('abort', abort, { once: true });
			this.pending.set(id, {
				method,
				resolve: (value) => {
					try { commit?.(value as T); }
					catch (error) { reject(error); return; }
					resolve(value as T);
				},
				reject,
				cleanup: () => signal?.removeEventListener('abort', abort),
			});
			this.write({ jsonrpc: '2.0', id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		if (this.closed) return;
		this.write({ jsonrpc: '2.0', method, params });
	}

	/** Kill the agent and every process it started. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closing = true;
		for (const controller of this.incoming.values()) controller.abort();
		try { this.child.stdin?.end(); } catch { /* already closed */ }
		const pid = this.child.pid;
		if (pid) killProcessTree(pid);
		else this.child.kill();
		await Promise.race([this.exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
	}

	private write(message: JsonRpcMessage): void {
		try { this.child.stdin!.write(`${JSON.stringify(message)}\n`); } catch { /* exit handler reports */ }
	}

	private onStdout(chunk: string): void {
		this.buffer += chunk;
		if (this.buffer.length > MAX_LINE_BYTES) {
			this.buffer = '';
			void this.close();
			return;
		}
		let index: number;
		while ((index = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, index).trim();
			this.buffer = this.buffer.slice(index + 1);
			if (!line) continue;
			let message: JsonRpcMessage;
			try { message = JSON.parse(line) as JsonRpcMessage; } catch { continue; /* agents may log non-JSON lines */ }
			this.dispatch(message);
		}
	}

	private dispatch(message: JsonRpcMessage): void {
		if (!message || typeof message !== 'object') return;
		const record = message as Record<string, unknown>;
		const hasId = typeof record.id === 'number' || typeof record.id === 'string';
		if (typeof record.method === 'string') {
			if (!hasId) {
				if (record.method === '$/cancel_request') {
					const requestId = (record.params as { requestId?: unknown } | null)?.requestId;
					if (typeof requestId === 'string' || typeof requestId === 'number') this.incoming.get(requestId)?.abort();
					return;
				}
				try { this.options.onNotification(record.method, record.params); } catch { /* listener errors stay local */ }
				return;
			}
			const id = record.id as number | string;
			const controller = new AbortController();
			this.incoming.set(id, controller);
			void this.options.onRequest(record.method, record.params, controller.signal).then(
				(result) => this.write({ jsonrpc: '2.0', id, result: result ?? null }),
				(error: unknown) => this.write({ jsonrpc: '2.0', id, error: toRpcError(error) }),
			).finally(() => { if (this.incoming.get(id) === controller) this.incoming.delete(id); });
			return;
		}
		if (!hasId || typeof record.id !== 'number') return;
		const pending = this.pending.get(record.id);
		if (!pending) return;
		this.pending.delete(record.id);
		pending.cleanup();
		if (record.error) pending.reject(new AcpRequestError(record.error as JsonRpcError));
		else pending.resolve(record.result);
	}
}

function toRpcError(error: unknown): JsonRpcError {
	if (error instanceof AcpRequestError) return { code: error.code, message: error.message };
	const message = error instanceof Error ? error.message : String(error);
	return { code: /not found|unknown method/i.test(message) ? -32601 : -32603, message };
}

export class MethodNotFoundError extends AcpRequestError {
	constructor(method: string) { super({ code: -32601, message: `Method not found: ${method}` }); }
}
