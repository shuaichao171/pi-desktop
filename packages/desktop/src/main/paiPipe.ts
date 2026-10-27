import { createServer, type Socket } from 'node:net';
import { createHash } from 'node:crypto';

/**
 * pai 命令与运行中的主程序之间的本地交接通道。
 *
 * `pai.exe` 先尝试直连命名管道（快路径，主程序已在运行时避免再拉起一个
 * Electron 进程）；连接失败才回退到 spawn `Pi Desktop.exe --pai ...`，
 * 由二次实例机制把请求交给持有单实例锁的主实例。
 */

/** 单条请求的最大长度：cwd + sessionPath 的 JSON 行远小于此值。 */
const MAX_REQUEST_BYTES = 8192;
/** 客户端连上之后发送请求行的时限。 */
const REQUEST_TIMEOUT_MS = 5_000;

export interface PaiPipeRequest {
	cwd: string;
	sessionPath?: string;
}

export interface PaiPipeResponse {
	ok: boolean;
	error?: string;
}

/** 管道名由用户名哈希派生：同一台机器上不同用户的实例互不干扰。 */
export function paiPipeName(username: string): string {
	const hash = createHash('sha256').update(username, 'utf8').digest('hex').slice(0, 16);
	return `pi-desktop-pai-${hash}`;
}

function isRequest(value: unknown): value is PaiPipeRequest {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const request = value as Record<string, unknown>;
	if (typeof request.cwd !== 'string' || !request.cwd || request.cwd.length > 4096 || request.cwd.includes('\0')) return false;
	if (request.sessionPath === undefined || request.sessionPath === null) return true;
	return typeof request.sessionPath === 'string' && request.sessionPath.length > 0 && request.sessionPath.length <= 4096 && !request.sessionPath.includes('\0');
}

/** 解析并校验客户端发来的一行 JSON；非法输入返回 null（连接被拒绝）。 */
export function parsePaiPipeRequest(line: string): PaiPipeRequest | null {
	let value: unknown;
	try { value = JSON.parse(line); }
	catch { return null; }
	if (!isRequest(value)) return null;
	return value.sessionPath === null ? { cwd: value.cwd } : { cwd: value.cwd, ...(value.sessionPath !== undefined ? { sessionPath: value.sessionPath } : {}) };
}

function encodeResponse(response: PaiPipeResponse): string {
	const error = response.error === undefined ? '' : `"error":${JSON.stringify(response.error.slice(0, 300))},`;
	return `{"ok":${response.ok ? 'true' : 'false'},${error}}\n`;
}

/** 端口被占用时的重试间隔：新旧实例交叠（更新/重启）只持续片刻。 */
const RETRY_LISTEN_MS = 10_000;

/**
 * 启动管道服务。每个连接只处理一条请求：读一行 JSON、交给 handler、
 * 回一行结果后断开。handler 抛出的错误作为失败响应返回，服务保持监听。
 *
 * listen 失败（典型为更新/重启交叠期的 EADDRINUSE）按固定间隔重试，
 * 直到本实例拿到管道名；否则管道会一直失效，pai 只能退回冷启动。
 */
export function startPaiPipeServer(options: { pipeName: string; handle(request: PaiPipeRequest): Promise<void> }): { stop(): void } {
	const server = createServer((socket: Socket) => {
		let buffer = '';
		let settled = false;
		const finish = (response: PaiPipeResponse): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				socket.end(encodeResponse(response));
			} catch { /* 客户端已断开 */ }
		};
		const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), REQUEST_TIMEOUT_MS);
		socket.setEncoding('utf8');
		socket.on('data', (chunk: string) => {
			if (settled) return;
			buffer += chunk;
			const newline = buffer.indexOf('\n');
			if (newline === -1) {
				if (buffer.length > MAX_REQUEST_BYTES) finish({ ok: false, error: 'request too large' });
				return;
			}
			const request = parsePaiPipeRequest(buffer.slice(0, newline));
			if (!request) {
				finish({ ok: false, error: 'invalid request' });
				return;
			}
			void options.handle(request)
				.then(() => finish({ ok: true }))
				.catch((error: unknown) => finish({ ok: false, error: error instanceof Error ? error.message : String(error) }));
		});
		socket.on('error', () => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				socket.destroy();
			}
		});
	});
	let stopped = false;
	let retry: NodeJS.Timeout | null = null;
	const listen = (): void => {
		if (stopped) return;
		server.listen(`\\\\.\\pipe\\${options.pipeName}`);
	};
	server.on('error', (error) => {
		// 端口被占用（例如另一个主实例）只会让 pai 走回退路径，不致命。
		console.error('pai pipe server failed:', error);
		if (!stopped) retry = setTimeout(listen, RETRY_LISTEN_MS);
	});
	listen();
	return {
		stop: () => {
			stopped = true;
			if (retry) clearTimeout(retry);
			server.close();
		},
	};
}
