/**
 * S3 / S3-compatible (Cloudflare R2, MinIO…) client for provider-config cloud
 * sync. Implements AWS Signature V4 with node:crypto only — no new deps.
 */

import { createHash, createHmac } from 'node:crypto';
import { recordCloudRequest } from './requestLog.ts';

const REQUEST_TIMEOUT_MS = 30_000;
const EMPTY_PAYLOAD_SHA256 = createHash('sha256').update('').digest('hex');

export interface S3Target {
	/** Resolved service endpoint (R2 → https://<accountId>.r2.cloudflarestorage.com). */
	endpoint: string;
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	remotePath: string;
	/** AWS endpoints use virtual-hosted addressing; custom endpoints use path style. */
	pathStyle: boolean;
}

export interface CloudConnectionTest {
	ok: boolean;
	message: string;
	lastModified: string | null;
	size: number | null;
}

function sha256Hex(data: Uint8Array | string): string {
	return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
	return createHmac('sha256', key).update(data, 'utf8').digest();
}

function encodeKeyPath(key: string): string {
	return key.split('/').filter(Boolean).map((part) => encodeURIComponent(part)).join('/');
}

/** Virtual-hosted vs path-style object URL, plus the bucket root for probes. */
function targetUrls(target: S3Target): { objectUrl: URL; bucketUrl: URL } {
	const endpoint = new URL(target.endpoint);
	const prefix = endpoint.pathname.replace(/\/+$/, '');
	const key = encodeKeyPath(target.remotePath);
	if (target.pathStyle) {
		return {
			objectUrl: new URL(`${endpoint.origin}${prefix}/${encodeURIComponent(target.bucket)}/${key}`),
			bucketUrl: new URL(`${endpoint.origin}${prefix}/${encodeURIComponent(target.bucket)}/`),
		};
	}
	const host = `${target.bucket}.${endpoint.host}`;
	return {
		objectUrl: new URL(`${endpoint.protocol}//${host}${prefix}/${key}`),
		bucketUrl: new URL(`${endpoint.protocol}//${host}${prefix}/`),
	};
}

async function s3Request(url: URL, target: S3Target, method: 'GET' | 'PUT' | 'HEAD', body?: Uint8Array, contentType?: string): Promise<Response> {
	const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
	const dateStamp = amzDate.slice(0, 8);
	const payloadHash = body ? sha256Hex(body) : EMPTY_PAYLOAD_SHA256;
	const headers: Record<string, string> = {
		'x-amz-date': amzDate,
		'x-amz-content-sha256': payloadHash,
	};
	if (contentType) headers['content-type'] = contentType;
	// The Host header is set implicitly by fetch from the URL; SigV4 always signs it.
	const signedHeaderValues: Record<string, string> = { host: url.host, ...headers };
	const canonicalNames = Object.keys(signedHeaderValues).map((name) => name.toLowerCase()).sort();
	const canonicalHeaders = canonicalNames.map((name) => `${name}:${signedHeaderValues[name]}\n`).join('');
	const canonicalQuery = [...url.searchParams.entries()]
		.map(([key, value]) => [encodeURIComponent(key), encodeURIComponent(value)] as const)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([key, value]) => `${key}=${value}`)
		.join('&');
	const canonicalUri = url.pathname.split('/').map((part) => {
		if (!part) return '';
		try { return encodeURIComponent(decodeURIComponent(part)); } catch { return encodeURIComponent(part); }
	}).join('/');
	const canonicalRequest = [method, canonicalUri || '/', canonicalQuery, canonicalHeaders, canonicalNames.join(';'), payloadHash].join('\n');
	const scope = `${dateStamp}/${target.region}/s3/aws4_request`;
	const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
	const signature = createHmac('sha256', hmac(hmac(hmac(`AWS4${target.secretAccessKey}`, dateStamp), target.region), 'aws4_request'))
		.update(stringToSign, 'utf8')
		.digest('hex');
	headers.authorization = `AWS4-HMAC-SHA256 Credential=${target.accessKeyId}/${scope}, SignedHeaders=${canonicalNames.join(';')}, Signature=${signature}`;
	const started = Date.now();
	const requestUrl = url.toString();
	try {
		const response = await fetch(url, {
			method,
			headers,
			body,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			redirect: 'manual',
		});
		recordCloudRequest({ time: new Date().toISOString(), kind: 's3', method, url: requestUrl, status: response.status, ms: Date.now() - started, error: null });
		return response;
	} catch (error) {
		recordCloudRequest({ time: new Date().toISOString(), kind: 's3', method, url: requestUrl, status: null, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
		throw error;
	}
}

function describeNetworkError(error: unknown, url: URL): string {
	if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return `连接超时：${url.host}`;
	if (error instanceof TypeError) return `无法连接到 ${url.host}，请检查网络或端点地址`;
	return error instanceof Error ? error.message : String(error);
}

function authFailure(status: number, verb: string): CloudConnectionTest | null {
	if (status === 401 || status === 403) {
		return { ok: false, message: `认证失败或无权限（${status}）：请检查 Access Key、Secret 或存储桶策略（需 ${verb} 权限）`, lastModified: null, size: null };
	}
	return null;
}

/** HEAD the backup object, then probe the bucket to separate "no backup" from "no bucket". */
export async function testS3Connection(target: S3Target): Promise<CloudConnectionTest> {
	const { objectUrl, bucketUrl } = targetUrls(target);
	let head: Response;
	try { head = await s3Request(objectUrl, target, 'HEAD'); }
	catch (error) { return { ok: false, message: describeNetworkError(error, objectUrl), lastModified: null, size: null }; }
	const authError = authFailure(head.status, '读取对象');
	if (authError) return authError;
	if (head.status === 200 || head.status === 204) {
		const lastModified = head.headers.get('last-modified');
		const size = head.headers.get('content-length');
		return {
			ok: true,
			message: '连接成功，云端已有备份',
			lastModified: lastModified ? new Date(lastModified).toISOString() : null,
			size: size !== null && Number.isFinite(Number(size)) ? Number(size) : null,
		};
	}
	if (head.status !== 404) {
		return { ok: false, message: `服务返回 ${head.status} ${head.statusText || ''}`.trim(), lastModified: null, size: null };
	}
	// The object is missing; verify the bucket (and credentials) are reachable.
	const probe = new URL(bucketUrl);
	probe.searchParams.set('list-type', '2');
	probe.searchParams.set('max-keys', '1');
	try {
		const response = await s3Request(probe, target, 'GET');
		if (response.status === 200) return { ok: true, message: '连接成功，云端暂无备份', lastModified: null, size: null };
		const denied = authFailure(response.status, '列举对象');
		if (denied && response.status === 403) return { ok: true, message: '连接成功（无列举权限），云端暂无备份或不可见', lastModified: null, size: null };
		if (denied) return denied;
		if (response.status === 404) return { ok: false, message: `存储桶不存在或无访问权限：${target.bucket}`, lastModified: null, size: null };
		return { ok: false, message: `服务返回 ${response.status} ${response.statusText || ''}`.trim(), lastModified: null, size: null };
	} catch (error) {
		return { ok: false, message: describeNetworkError(error, probe), lastModified: null, size: null };
	}
}

export async function s3Upload(target: S3Target, bytes: Uint8Array): Promise<{ lastModified: string | null }> {
	const { objectUrl } = targetUrls(target);
	try {
		const response = await s3Request(objectUrl, target, 'PUT', bytes, 'application/json');
		if (!(response.status >= 200 && response.status < 300)) {
			const authError = authFailure(response.status, '上传对象');
			throw new Error(authError ? authError.message : `上传失败：服务返回 ${response.status} ${response.statusText || ''}`.trim());
		}
		try { await response.arrayBuffer(); } catch { /* body is irrelevant */ }
		return { lastModified: response.headers.get('last-modified') };
	} catch (error) {
		if (error instanceof Error && error.message) throw error;
		throw new Error(`${describeNetworkError(error, objectUrl)}（上传时）`);
	}
}

/** Returns null when the remote backup does not exist yet. */
export async function s3Download(target: S3Target): Promise<{ bytes: Uint8Array; lastModified: string | null } | null> {
	const { objectUrl } = targetUrls(target);
	let response: Response;
	try { response = await s3Request(objectUrl, target, 'GET'); }
	catch (error) { throw new Error(`${describeNetworkError(error, objectUrl)}（下载时）`); }
	if (response.status === 404) return null;
	const authError = authFailure(response.status, '读取对象');
	if (authError) throw new Error(authError.message);
	if (!(response.status >= 200 && response.status < 300)) throw new Error(`下载失败：服务返回 ${response.status} ${response.statusText || ''}`.trim());
	return { bytes: new Uint8Array(await response.arrayBuffer()), lastModified: response.headers.get('last-modified') };
}
