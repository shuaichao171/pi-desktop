/**
 * Minimal WebDAV client for provider-config cloud sync (PUT/GET/PROPFIND/MKCOL).
 * Hand-rolled with global fetch so the desktop adds no new dependencies.
 */

import { recordCloudRequest } from './requestLog.ts';

const REQUEST_TIMEOUT_MS = 30_000;

export interface WebdavTarget {
	url: string;
	username: string;
	password: string;
	remotePath: string;
}

/** Returns the directory URL and the backup-file URL for a target. */
export function webdavUrls(target: WebdavTarget): { dirUrl: string; fileUrl: string } {
	const base = new URL(target.url);
	const baseSegments = base.pathname.split('/').filter(Boolean).map(encodeSegment);
	const fileSegments = webdavFileSegments(target.remotePath);
	const dirPath = ['', ...baseSegments, ...fileSegments.slice(0, -1)].join('/');
	const filePath = ['', ...baseSegments, ...fileSegments].join('/');
	const origin = base.origin;
	return { dirUrl: `${origin}${dirPath}`, fileUrl: `${origin}${filePath}` };
}

/**
 * Jianguoyun (and several other servers) reject files placed directly in the
 * WebDAV mount root, so a bare file name is stored inside a default
 * subdirectory instead.
 */
function webdavFileSegments(remotePath: string): string[] {
	const segments = remotePath.split('/').filter(Boolean).map(encodeSegment);
	return segments.length === 1 ? ['pi-desktop', ...segments] : segments;
}

function encodeSegment(segment: string): string {
	// Server addresses are often pasted with percent-encoded characters; decode
	// first so already-encoded paths are not double-encoded.
	return segment.split('/').map((part) => {
		try { return encodeURIComponent(decodeURIComponent(part)); } catch { return encodeURIComponent(part); }
	}).join('/');
}

function basicAuth(target: WebdavTarget): string {
	return `Basic ${Buffer.from(`${target.username}:${target.password}`, 'utf8').toString('base64')}`;
}

async function webdavRequest(method: string, url: string, target: WebdavTarget, body?: Uint8Array | string, headers: Record<string, string> = {}): Promise<Response> {
	const started = Date.now();
	try {
		const response = await fetch(url, {
			method,
			headers: { authorization: basicAuth(target), ...headers },
			body,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			redirect: 'manual',
		});
		recordCloudRequest({ time: new Date().toISOString(), kind: 'webdav', method, url, status: response.status, ms: Date.now() - started, error: null });
		return response;
	} catch (error) {
		recordCloudRequest({ time: new Date().toISOString(), kind: 'webdav', method, url, status: null, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
		throw error;
	}
}

function describeNetworkError(error: unknown, url: string): string {
	if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return `连接超时：${hostOf(url)}`;
	return `无法连接到 ${hostOf(url)}，请检查网络或服务地址`;
}

function hostOf(url: string): string {
	try { return new URL(url).host; } catch { return url; }
}

export interface CloudConnectionTest {
	ok: boolean;
	message: string;
	/** Present when the remote backup object exists. */
	lastModified: string | null;
	size: number | null;
}

/** PROPFIND the directory, then the backup file itself (cc-switch style probe). */
export async function testWebdavConnection(target: WebdavTarget): Promise<CloudConnectionTest> {
	const { dirUrl, fileUrl } = webdavUrls(target);
	let directoryReachable = false;
	try {
		const response = await webdavRequest('PROPFIND', dirUrl, target, undefined, { depth: '0' });
		if (response.status === 207 || response.status === 200) directoryReachable = true;
		else if (response.status === 401 || response.status === 403) return { ok: false, message: '认证失败：用户名或密码不正确，或无访问权限', lastModified: null, size: null };
		else if (response.status === 404) directoryReachable = false;
		else if (response.status === 405) directoryReachable = true; // Some servers reject PROPFIND on the root.
		else return { ok: false, message: `服务器返回 ${response.status} ${response.statusText || ''}`.trim(), lastModified: null, size: null };
	} catch (error) {
		return { ok: false, message: describeNetworkError(error, dirUrl), lastModified: null, size: null };
	}
	try {
		const response = await webdavRequest('PROPFIND', fileUrl, target, undefined, { depth: '0' });
		if (response.status === 207 || response.status === 200) {
			const text = await response.text();
			const modified = propfindValue(text, 'getlastmodified');
			const length = propfindValue(text, 'getcontentlength');
			return {
				ok: true,
				message: directoryReachable ? '连接成功，云端已有备份' : '连接成功（目录尚未创建，上传时自动建立），云端已有备份',
				lastModified: modified ? new Date(modified).toISOString() : null,
				size: length !== null && Number.isFinite(Number(length)) ? Number(length) : null,
			};
		}
		if (response.status === 404) {
			return { ok: true, message: directoryReachable ? '连接成功，云端暂无备份' : '连接成功（目录尚未创建，上传时自动建立），云端暂无备份', lastModified: null, size: null };
		}
		if (response.status === 401 || response.status === 403) return { ok: false, message: '认证失败：用户名或密码不正确，或无访问权限', lastModified: null, size: null };
		return { ok: false, message: `服务器返回 ${response.status} ${response.statusText || ''}`.trim(), lastModified: null, size: null };
	} catch (error) {
		return { ok: false, message: describeNetworkError(error, fileUrl), lastModified: null, size: null };
	}
}

function propfindValue(xml: string, property: string): string | null {
	const match = new RegExp(`<(?:[\\w.-]+:)?${property}[^>]*>([^<]*)</(?:[\\w.-]+:)?${property}>`, 'i').exec(xml);
	return match && match[1] ? match[1] : null;
}

/** Creates each missing directory segment below the server address (405 = already exists), then PUTs the file. */
export async function webdavUpload(target: WebdavTarget, bytes: Uint8Array): Promise<{ lastModified: string | null }> {
	const base = new URL(target.url);
	const { fileUrl } = webdavUrls(target);
	// The server address is the WebDAV mount point and must already exist —
	// Jianguoyun answers MKCOL on /dav/ itself with 403 — so only the
	// directories of the remote path are created, never the address segments.
	// Bare file names are stored inside the default "pi-desktop" directory.
	const segments = webdavFileSegments(target.remotePath);
	segments.pop(); // The file itself is not a directory.
	let current = `${base.origin}${['', ...base.pathname.split('/').filter(Boolean).map(encodeSegment)].join('/')}`;
	for (const segment of segments) {
		current = `${current}/${encodeSegment(segment)}`;
		try {
			const response = await webdavRequest('MKCOL', `${current}/`, target);
			// 201 created, 200/405 already exists; anything else fails only if
			// the same status repeats on the PUT below.
			if (!(response.status === 201 || response.status === 200 || response.status === 405 || response.status === 301 || response.status === 302)) {
				throw new Error(`创建目录失败：服务器返回 ${response.status} ${response.statusText || ''}`.trim());
			}
		} catch (error) {
			if (error instanceof Error && error.message.startsWith('创建目录失败')) throw error;
			throw new Error(`${describeNetworkError(error, current)}（创建目录时）`);
		}
	}
	try {
		const response = await webdavRequest('PUT', fileUrl, target, bytes, { 'content-type': 'application/json' });
		if (!(response.status >= 200 && response.status < 300)) {
			throw new Error(`上传失败：服务器返回 ${response.status} ${response.statusText || ''}`.trim());
		}
		try { await response.arrayBuffer(); } catch { /* body is irrelevant */ }
		return { lastModified: response.headers.get('last-modified') };
	} catch (error) {
		if (error instanceof Error && (error.message.startsWith('上传失败') || error.message.startsWith('无法连接'))) throw error;
		throw new Error(`${describeNetworkError(error, fileUrl)}（上传时）`);
	}
}

/** Returns null when the remote backup does not exist yet. */
export async function webdavDownload(target: WebdavTarget): Promise<{ bytes: Uint8Array; lastModified: string | null } | null> {
	const { fileUrl } = webdavUrls(target);
	let response: Response;
	try {
		response = await webdavRequest('GET', fileUrl, target);
	} catch (error) {
		throw new Error(`${describeNetworkError(error, fileUrl)}（下载时）`);
	}
	if (response.status === 404) return null;
	if (response.status === 401 || response.status === 403) throw new Error('认证失败：用户名或密码不正确，或无访问权限');
	if (!(response.status >= 200 && response.status < 300)) throw new Error(`下载失败：服务器返回 ${response.status} ${response.statusText || ''}`.trim());
	const bytes = new Uint8Array(await response.arrayBuffer());
	return { bytes, lastModified: response.headers.get('last-modified') };
}
