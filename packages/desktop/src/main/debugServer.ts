/**
 * Loopback-only HTTP debug endpoint for Pi Desktop (AI debugging aid).
 *
 * Binds 127.0.0.1 exclusively — never reachable from the network — and rejects
 * requests whose Host header is not a loopback name, which also blocks
 * DNS-rebinding. CORS headers are deliberately absent: pages in a browser must
 * not read this API; the intended client is curl/fetch from a local shell.
 * Exposes app status, cloud-sync state, the request-level cloud log and manual
 * cloud-sync triggers so an assistant can diagnose the running app remotely.
 * Bearer-token authentication is on by default and may be disabled in settings
 * (see debugApiIpc).
 */

import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { UiDebugApiConfig } from '@pidesktop/shared';
import { clearCloudRequests, recentCloudRequests } from './cloudSync/requestLog.ts';
import type { CloudSyncService } from './cloudSync/cloudSyncService.ts';

export interface DebugServer {
	readonly port: number;
	stop(): Promise<void>;
}

export interface DebugServerDeps {
	appVersion(): string;
	cloudSync(): CloudSyncService | null;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
	});
	response.end(JSON.stringify(value, null, 2));
}

async function runCloudAction(response: ServerResponse, action: () => Promise<unknown>): Promise<void> {
	try {
		sendJson(response, 200, { ok: true, result: await action() });
	} catch (error) {
		sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
	}
}

function isLoopbackHost(host: string | undefined, port: number): boolean {
	if (!host) return false;
	const normalized = host.trim().toLowerCase();
	return normalized === '127.0.0.1' || normalized === 'localhost'
		|| normalized === `127.0.0.1:${port}` || normalized === `localhost:${port}`;
}

function hasBearerToken(request: IncomingMessage, token: string): boolean {
	const received = Buffer.from(request.headers.authorization ?? '');
	const expected = Buffer.from(`Bearer ${token}`);
	return received.length === expected.length && timingSafeEqual(received, expected);
}

export async function createDebugServer(config: UiDebugApiConfig, deps: DebugServerDeps): Promise<DebugServer> {
	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? '/', 'http://127.0.0.1');
		const method = (request.method ?? 'GET').toUpperCase();
		if (!isLoopbackHost(request.headers.host, config.port)) {
			sendJson(response, 403, { ok: false, error: '拒绝访问：Host 头不是本机回环地址 / forbidden: non-loopback Host header' });
			return;
		}
		if (config.authEnabled && config.token && !hasBearerToken(request, config.token)) {
			sendJson(response, 401, { ok: false, error: '鉴权失败：需要 Authorization: Bearer <token> / unauthorized' });
			return;
		}
		if (method === 'GET' && url.pathname === '/') {
			sendJson(response, 200, {
				service: 'pi-desktop-debug',
				endpoints: [
					'GET /status',
					'GET /cloud-sync/state',
					'GET /cloud-sync/requests',
					'DELETE /cloud-sync/requests',
					'POST /cloud-sync/upload',
					'POST /cloud-sync/inspect',
					'POST /cloud-sync/test-connection',
				],
			});
			return;
		}
		if (method === 'GET' && url.pathname === '/status') {
			sendJson(response, 200, {
				appVersion: deps.appVersion(),
				platform: process.platform,
				arch: process.arch,
				electron: process.versions.electron ?? null,
				node: process.versions.node,
				uptimeMs: Math.round(process.uptime() * 1000),
				pid: process.pid,
			});
			return;
		}
		if (url.pathname.startsWith('/cloud-sync/') || url.pathname.startsWith('/cloud-sync')) {
			const cloudSync = deps.cloudSync();
			if (!cloudSync) {
				sendJson(response, 503, { ok: false, error: '云同步服务尚未就绪 / cloud sync not ready' });
				return;
			}
			if (method === 'GET' && url.pathname === '/cloud-sync/state') return sendJson(response, 200, await cloudSync.getState());
			if (method === 'GET' && url.pathname === '/cloud-sync/requests') {
				const requests = recentCloudRequests();
				return sendJson(response, 200, { count: requests.length, requests });
			}
			if (method === 'DELETE' && url.pathname === '/cloud-sync/requests') {
				clearCloudRequests();
				response.writeHead(204).end();
				return;
			}
			if (method === 'POST' && url.pathname === '/cloud-sync/upload') return runCloudAction(response, () => cloudSync.upload('manual'));
			if (method === 'POST' && url.pathname === '/cloud-sync/inspect') return runCloudAction(response, () => cloudSync.inspect());
			if (method === 'POST' && url.pathname === '/cloud-sync/test-connection') {
				return runCloudAction(response, async () => {
					const state = await cloudSync.getState();
					if (!state.config) throw new Error('尚未保存云同步配置 / no saved cloud-sync config');
					return cloudSync.testConnection(state.config);
				});
			}
		}
		sendJson(response, 404, { ok: false, error: `未知接口 / unknown endpoint: ${method} ${url.pathname}` });
	}

	const server: Server = createServer((request, response) => {
		void handle(request, response).catch((error: unknown) => {
			try { sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }); }
			catch { /* response already committed */ }
		});
	});
	await new Promise<void>((resolve, reject) => {
		const fail = (error: Error): void => reject(error);
		server.once('error', fail);
		server.listen(config.port, '127.0.0.1', () => {
			server.off('error', fail);
			resolve();
		});
	});
	return {
		port: config.port,
		stop: () => new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
			server.closeAllConnections?.();
		}),
	};
}
