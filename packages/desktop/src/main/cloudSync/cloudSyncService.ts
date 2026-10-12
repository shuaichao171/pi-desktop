/**
 * Cloud backup service for the model-provider database (cc-switch style).
 *
 * The provider database is three files in the agent directory — models.json,
 * auth.json, model-prefs.json. Uploads wrap them in a versioned envelope and
 * push it to WebDAV or S3/R2; restores validate the envelope and hand it to the
 * agent service, which installs it atomically (old files are kept as
 * *.pi-desktop-backup). Auto-sync re-uploads after every provider change.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { UiCloudSyncBackupInfo, UiCloudSyncConfig, UiCloudSyncKind, UiCloudSyncRestoreResult, UiCloudSyncState, UiCloudSyncTestResult, UiCloudSyncUploadResult } from '@pidesktop/shared';
import { testWebdavConnection, webdavDownload, webdavUpload, type WebdavTarget } from './webdav.ts';
import { s3Download, s3Upload, testS3Connection, type CloudConnectionTest, type S3Target } from './s3.ts';
import { createCloudSyncStore, DEFAULT_REMOTE_PATH, type CloudSyncStore, type StoredCloudSyncConfig } from './cloudSyncStore.ts';

const BACKUP_FORMAT = 'pi-desktop.provider-backup';
const BACKUP_VERSION = 1;
const AUTO_SYNC_DEBOUNCE_MS = 2000;
const MAX_MODELS_BYTES = 8_000_000;
const MAX_AUTH_BYTES = 8_000_000;
const MAX_PREFS_BYTES = 1_000_000;
const MAX_BACKUP_BYTES = 24_000_000;

/** The three files that make up the provider database. */
export interface BackupFileSet {
	'models.json': string;
	'auth.json': string | null;
	'model-prefs.json': string | null;
}

interface ProviderBackupEnvelope {
	format: string;
	version: number;
	appVersion: string;
	uploadedAt: string;
	files: BackupFileSet;
}

export interface CloudSyncServiceDeps {
	/** Electron userData directory; cloud-sync.json lives at its root. */
	userDataPath: string;
	appVersion: string;
	agent: {
		restoreProviderBackup(files: { modelsJson: string; authJson: string | null; modelPrefsJson: string | null }): Promise<{ providers: number; models: number; credentials: number }>;
	};
	/** Broadcasts state updates to every renderer window. */
	onChanged: (state: UiCloudSyncState) => void;
}

export interface CloudSyncService {
	getState(): Promise<UiCloudSyncState>;
	saveConfig(config: UiCloudSyncConfig): Promise<UiCloudSyncState>;
	testConnection(config: UiCloudSyncConfig): Promise<UiCloudSyncTestResult>;
	upload(reason?: 'manual' | 'auto'): Promise<UiCloudSyncUploadResult>;
	inspect(): Promise<UiCloudSyncBackupInfo>;
	restore(): Promise<UiCloudSyncRestoreResult>;
	/** Debounced auto upload after any provider-database change. */
	onProviderDatabaseChanged(): void;
	dispose(): Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** models.json tolerates JSONC comments; strip them before counting. */
function stripJsonComments(text: string): string {
	let result = '';
	let index = 0;
	let inString = false;
	while (index < text.length) {
		const char = text[index]!;
		if (inString) {
			if (char === '\\') { result += text.slice(index, index + 2); index += 2; continue; }
			if (char === '"') inString = false;
			result += char; index += 1; continue;
		}
		if (char === '"') { inString = true; result += char; index += 1; continue; }
		if (char === '/' && text[index + 1] === '/') { while (index < text.length && text[index] !== '\n') index += 1; continue; }
		if (char === '/' && text[index + 1] === '*') {
			index += 2;
			while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
			index += 2;
			continue;
		}
		result += char;
		index += 1;
	}
	return result;
}

function countDatabase(modelsJson: string, authJson: string | null): { providers: number | null; models: number | null; credentials: number | null } {
	let providers: number | null = null;
	let models = 0;
	try {
		const parsed: unknown = JSON.parse(stripJsonComments(modelsJson.replace(/^\uFEFF/, '')));
		if (isRecord(parsed) && isRecord(parsed.providers)) {
			providers = Object.keys(parsed.providers).length;
			for (const config of Object.values(parsed.providers)) {
				if (isRecord(config) && Array.isArray(config.models)) models += config.models.length;
			}
		}
	} catch { providers = null; }
	let credentials: number | null = 0;
	if (authJson !== null) {
		try {
			const parsed: unknown = JSON.parse(authJson.replace(/^\uFEFF/, ''));
			credentials = isRecord(parsed) ? Object.values(parsed).filter(isRecord).length : 0;
		} catch { credentials = null; }
	}
	return { providers, models: providers === null ? null : models, credentials };
}

export function createCloudSyncService(deps: CloudSyncServiceDeps): CloudSyncService {
	const store: CloudSyncStore = createCloudSyncStore(deps.userDataPath);
	let queue: Promise<unknown> = Promise.resolve();
	let autoSyncTimer: ReturnType<typeof setTimeout> | null = null;
	let uploadInFlight = false;

	const readConfig = (): Promise<StoredCloudSyncConfig | null> => store.tryRead();

	/** Serializes mutating cloud operations so uploads/restores never race. */
	const runQueued = <T>(operation: () => Promise<T>): Promise<T> => {
		const next = queue.then(operation, operation);
		queue = next.catch(() => {});
		return next;
	};

	const isConfigured = (config: StoredCloudSyncConfig | null): boolean => {
		if (!config) return false;
		if (config.kind === 'webdav') return !!config.webdav?.url.trim() && !!config.webdav?.username.trim() && !!store.decrypt(config.webdav?.password ?? '');
		if (config.kind === 's3') return !!config.s3?.bucket.trim() && !!config.s3?.accessKeyId.trim() && !!store.decrypt(config.s3?.secretAccessKey ?? '');
		return !!config.r2?.accountId.trim() && !!config.r2?.bucket.trim() && !!config.r2?.accessKeyId.trim() && !!store.decrypt(config.r2?.secretAccessKey ?? '');
	};

	const toUiConfig = (config: StoredCloudSyncConfig | null): UiCloudSyncConfig | null => {
		if (!config) return null;
		const remotePath = config.remotePath || DEFAULT_REMOTE_PATH;
		if (config.kind === 'webdav' && config.webdav) {
			return { kind: 'webdav', autoSync: config.autoSync, remotePath, webdav: { url: config.webdav.url, username: config.webdav.username, hasPassword: !!store.decrypt(config.webdav.password) } };
		}
		if (config.kind === 's3' && config.s3) {
			return { kind: 's3', autoSync: config.autoSync, remotePath, s3: { endpoint: config.s3.endpoint, region: config.s3.region, bucket: config.s3.bucket, accessKeyId: config.s3.accessKeyId, hasSecret: !!store.decrypt(config.s3.secretAccessKey) } };
		}
		if (config.kind === 'r2' && config.r2) {
			return { kind: 'r2', autoSync: config.autoSync, remotePath, r2: { accountId: config.r2.accountId, bucket: config.r2.bucket, accessKeyId: config.r2.accessKeyId, hasSecret: !!store.decrypt(config.r2.secretAccessKey) } };
		}
		return { kind: config.kind, autoSync: config.autoSync, remotePath };
	};

	const snapshotState = async (): Promise<UiCloudSyncState> => {
		const config = await readConfig();
		return {
			configured: isConfigured(config),
			config: toUiConfig(config),
			status: {
				lastUploadAt: config?.lastUploadAt ?? null,
				lastAutoSyncAt: config?.lastAutoSyncAt ?? null,
				lastError: config?.lastError ?? null,
				pending: autoSyncTimer !== null || uploadInFlight,
			},
		};
	};

	const persistStatus = async (patch: Partial<Pick<StoredCloudSyncConfig, 'lastUploadAt' | 'lastAutoSyncAt' | 'lastError'>>): Promise<void> => {
		const config = await readConfig();
		if (!config) return;
		await store.write({ ...config, ...patch });
		deps.onChanged(await snapshotState());
	};

	const normalizeRemotePath = (value: unknown): string => {
		const text = typeof value === 'string' ? value.trim() : '';
		if (!text) return DEFAULT_REMOTE_PATH;
		if (text.length > 200 || /[\u0000-\u001f\u007f\\]/.test(text) || text.startsWith('/') || text.endsWith('/')) throw new Error('备份文件名无效：不能以 / 开头或结尾');
		if (text.split('/').some((segment) => !segment.trim() || segment === '.' || segment === '..')) throw new Error('备份文件名无效：路径段不能为空、. 或 ..');
		return text;
	};

	const requireText = (value: unknown, label: string, max: number): string => {
		const text = typeof value === 'string' ? value.trim() : '';
		if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw new Error(`${label}无效`);
		return text;
	};

	/** Merges a renderer draft onto the stored config; omitted secrets carry over. */
	const mergeConfig = (stored: StoredCloudSyncConfig | null, draft: UiCloudSyncConfig): StoredCloudSyncConfig => {
		if (!isRecord(draft)) throw new Error('云同步配置无效');
		const kind: UiCloudSyncKind = draft.kind;
		if (kind !== 'webdav' && kind !== 's3' && kind !== 'r2') throw new Error('云同步类型无效');
		const base: StoredCloudSyncConfig = {
			kind,
			autoSync: draft.autoSync === true,
			remotePath: normalizeRemotePath(draft.remotePath),
			lastUploadAt: stored?.kind === kind ? stored.lastUploadAt : null,
			lastAutoSyncAt: stored?.kind === kind ? stored.lastAutoSyncAt : null,
			lastError: stored?.kind === kind ? stored.lastError : null,
		};
		if (kind === 'webdav') {
			const webdav: Record<string, unknown> = isRecord(draft.webdav) ? draft.webdav : {};
			const url = requireText(webdav.url, '服务器地址', 2000);
			const parsed = new URL(url);
			if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('服务器地址必须是 http(s):// 开头');
			const username = requireText(webdav.username, '用户名', 500);
			const password = typeof webdav.password === 'string' && webdav.password
				? store.encrypt(webdav.password)
				: (stored?.kind === 'webdav' && stored.webdav ? stored.webdav.password : '');
			return { ...base, webdav: { url, username, password } };
		}
		if (kind === 's3') {
			const s3: Record<string, unknown> = isRecord(draft.s3) ? draft.s3 : {};
			const endpoint = typeof s3.endpoint === 'string' ? s3.endpoint.trim() : '';
			if (endpoint) {
				const parsed = new URL(endpoint);
				if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('自定义端点必须是 http(s):// 开头');
			}
			const region = requireText(s3.region || 'us-east-1', '区域', 100);
			const bucket = requireText(s3.bucket, '存储桶名称', 255);
			if (!/^[a-z0-9][a-z0-9.-]{1,253}[a-z0-9]$/.test(bucket)) throw new Error('存储桶名称无效');
			const accessKeyId = requireText(s3.accessKeyId, 'Access Key ID', 500);
			const secretAccessKey = typeof s3.secretAccessKey === 'string' && s3.secretAccessKey
				? store.encrypt(s3.secretAccessKey)
				: (stored?.kind === 's3' && stored.s3 ? stored.s3.secretAccessKey : '');
			return { ...base, s3: { endpoint, region, bucket, accessKeyId, secretAccessKey } };
		}
		const r2: Record<string, unknown> = isRecord(draft.r2) ? draft.r2 : {};
		const accountId = requireText(r2.accountId, 'Cloudflare 账户 ID', 200);
		const bucket = requireText(r2.bucket, '存储桶名称', 255);
		if (!/^[a-z0-9][a-z0-9.-]{1,253}[a-z0-9]$/.test(bucket)) throw new Error('存储桶名称无效');
		const accessKeyId = requireText(r2.accessKeyId, 'Access Key ID', 500);
		const secretAccessKey = typeof r2.secretAccessKey === 'string' && r2.secretAccessKey
			? store.encrypt(r2.secretAccessKey)
			: (stored?.kind === 'r2' && stored.r2 ? stored.r2.secretAccessKey : '');
		return { ...base, r2: { accountId, bucket, accessKeyId, secretAccessKey } };
	};

	/** Builds the transport target, decrypting secrets at the last moment. */
	const resolveTarget = (config: StoredCloudSyncConfig): { webdav?: WebdavTarget; s3?: S3Target } => {
		const remotePath = config.remotePath || DEFAULT_REMOTE_PATH;
		if (config.kind === 'webdav' && config.webdav) {
			return { webdav: { url: config.webdav.url.replace(/\/+$/, ''), username: config.webdav.username, password: store.decrypt(config.webdav.password), remotePath } };
		}
		if (config.kind === 's3' && config.s3) {
			const endpoint = config.s3.endpoint.trim();
			return {
				s3: {
					endpoint: endpoint || `https://s3.${config.s3.region}.amazonaws.com`,
					region: config.s3.region || 'us-east-1',
					bucket: config.s3.bucket,
					accessKeyId: config.s3.accessKeyId,
					secretAccessKey: store.decrypt(config.s3.secretAccessKey),
					remotePath,
					pathStyle: !!endpoint,
				},
			};
		}
		if (config.kind === 'r2' && config.r2) {
			return {
				s3: {
					endpoint: `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
					region: 'auto',
					bucket: config.r2.bucket,
					accessKeyId: config.r2.accessKeyId,
					secretAccessKey: store.decrypt(config.r2.secretAccessKey),
					remotePath,
					pathStyle: true,
				},
			};
		}
		throw new Error('云同步配置不完整，请先保存连接信息');
	};

	const readLocalDatabase = async (): Promise<BackupFileSet> => {
		const directory = getAgentDir();
		const readOptional = async (path: string, max: number): Promise<string | null> => {
			let text: string;
			try { text = await readFile(path, 'utf8'); }
			catch (error) {
				if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
				throw error;
			}
			if (text.length > max) throw new Error('本地配置文件过大，已取消上传');
			return text.trim() ? text : null;
		};
		const models = await readOptional(join(directory, 'models.json'), MAX_MODELS_BYTES);
		if (models === null) throw new Error('本地尚未配置任何模型供应商，无需上传备份');
		return {
			'models.json': models,
			'auth.json': await readOptional(join(directory, 'auth.json'), MAX_AUTH_BYTES),
			'model-prefs.json': await readOptional(join(directory, 'model-prefs.json'), MAX_PREFS_BYTES),
		};
	};

	const parseEnvelope = (bytes: Uint8Array, lastModifiedHeader: string | null): ProviderBackupEnvelope => {
		if (!bytes.length) throw new Error('云端备份文件为空');
		if (bytes.length > MAX_BACKUP_BYTES) throw new Error('云端备份超过大小限制（24 MB）');
		let value: unknown;
		try { value = JSON.parse(Buffer.from(bytes).toString('utf8')); }
		catch { throw new Error('云端备份不是有效的 JSON，文件可能已损坏'); }
		if (!isRecord(value) || value.format !== BACKUP_FORMAT) throw new Error('云端文件不是 Pi Desktop 的供应商备份');
		if (value.version !== BACKUP_VERSION) throw new Error(`云端备份版本（${String(value.version)}）不受当前版本应用支持`);
		const files = value.files;
		if (!isRecord(files) || typeof files['models.json'] !== 'string' || !files['models.json'].trim()) throw new Error('云端备份缺少 models.json');
		if (files['auth.json'] !== null && typeof files['auth.json'] !== 'string') throw new Error('云端备份中的 auth.json 无效');
		if (files['model-prefs.json'] !== null && typeof files['model-prefs.json'] !== 'string') throw new Error('云端备份中的 model-prefs.json 无效');
		const modelsJson = files['models.json'];
		const authJson = files['auth.json'] as string | null;
		const modelPrefsJson = files['model-prefs.json'] as string | null;
		if (modelsJson.length > MAX_MODELS_BYTES || (authJson !== null && authJson.length > MAX_AUTH_BYTES) || (modelPrefsJson !== null && modelPrefsJson.length > MAX_PREFS_BYTES)) throw new Error('云端备份中的文件超过大小限制');
		const headerTime = lastModifiedHeader !== null && !Number.isNaN(Date.parse(lastModifiedHeader)) ? new Date(lastModifiedHeader).toISOString() : null;
		const uploadedAt = typeof value.uploadedAt === 'string' && !Number.isNaN(Date.parse(value.uploadedAt)) ? new Date(value.uploadedAt).toISOString() : headerTime;
		const appVersion = typeof value.appVersion === 'string' && value.appVersion.trim() ? value.appVersion : null;
		return { format: BACKUP_FORMAT, version: BACKUP_VERSION, appVersion: appVersion ?? '', uploadedAt: uploadedAt ?? new Date().toISOString(), files: { 'models.json': modelsJson, 'auth.json': authJson, 'model-prefs.json': modelPrefsJson } };
	};

	const upload = (reason: 'manual' | 'auto' = 'manual'): Promise<UiCloudSyncUploadResult> => runQueued(async () => {
		uploadInFlight = true;
		try {
			const config = await readConfig();
			if (!isConfigured(config)) throw new Error('云同步尚未配置完整，请先保存连接信息');
			const files = await readLocalDatabase();
			const counts = countDatabase(files['models.json'], files['auth.json']);
			if (counts.providers === null) throw new Error('本地 models.json 无法解析，已取消上传');
			const envelope: ProviderBackupEnvelope = {
				format: BACKUP_FORMAT,
				version: BACKUP_VERSION,
				appVersion: deps.appVersion,
				uploadedAt: new Date().toISOString(),
				files,
			};
			const bytes = Buffer.from(JSON.stringify(envelope), 'utf8');
			const { webdav, s3 } = resolveTarget(config!);
			if (webdav) await webdavUpload(webdav, bytes);
			else await s3Upload(s3!, bytes);
			const uploadedAt = new Date().toISOString();
			await persistStatus({ lastUploadAt: uploadedAt, lastError: null, ...(reason === 'auto' ? { lastAutoSyncAt: uploadedAt } : {}) });
			return { uploadedAt, bytes: bytes.length, providers: counts.providers, models: counts.models ?? 0, credentials: counts.credentials ?? 0 };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await persistStatus({ lastError: message }).catch(() => { });
			throw error;
		} finally {
			uploadInFlight = false;
			deps.onChanged(await snapshotState());
		}
	});

	const inspect = (): Promise<UiCloudSyncBackupInfo> => runQueued(async () => {
		const config = await readConfig();
		if (!isConfigured(config)) throw new Error('云同步尚未配置完整，请先保存连接信息');
		const { webdav, s3 } = resolveTarget(config!);
		const downloaded = webdav ? await webdavDownload(webdav) : await s3Download(s3!);
		if (!downloaded) return { uploadedAt: null, size: null, providers: null, models: null, credentials: null, appVersion: null };
		const envelope = parseEnvelope(downloaded.bytes, downloaded.lastModified);
		const counts = countDatabase(envelope.files['models.json'], envelope.files['auth.json']);
		return { uploadedAt: envelope.uploadedAt, size: downloaded.bytes.length, providers: counts.providers, models: counts.models, credentials: counts.credentials, appVersion: envelope.appVersion || null };
	});

	const restore = (): Promise<UiCloudSyncRestoreResult> => runQueued(async () => {
		const config = await readConfig();
		if (!isConfigured(config)) throw new Error('云同步尚未配置完整，请先保存连接信息');
		const { webdav, s3 } = resolveTarget(config!);
		const downloaded = webdav ? await webdavDownload(webdav) : await s3Download(s3!);
		if (!downloaded) throw new Error('云端没有备份可下载');
		const envelope = parseEnvelope(downloaded.bytes, downloaded.lastModified);
		const counts = await deps.agent.restoreProviderBackup({
			modelsJson: envelope.files['models.json'],
			authJson: envelope.files['auth.json'],
			modelPrefsJson: envelope.files['model-prefs.json'],
		});
		return { ...counts, uploadedAt: envelope.uploadedAt ?? null };
	});

	return {
		getState: snapshotState,
		async saveConfig(draft: UiCloudSyncConfig): Promise<UiCloudSyncState> {
			const stored = await readConfig();
			await store.write(mergeConfig(stored, draft));
			const state = await snapshotState();
			deps.onChanged(state);
			return state;
		},
		async testConnection(draft: UiCloudSyncConfig): Promise<UiCloudSyncTestResult> {
			const stored = await readConfig();
			const merged = mergeConfig(stored, draft);
			if (!isConfigured(merged)) throw new Error('连接信息不完整，请填写所有必填项');
			const { webdav, s3 } = resolveTarget(merged);
			const result: CloudConnectionTest = webdav ? await testWebdavConnection(webdav) : await testS3Connection(s3!);
			const remote: UiCloudSyncBackupInfo | null = result.lastModified !== null || result.size !== null
				? { uploadedAt: result.lastModified, size: result.size, providers: null, models: null, credentials: null, appVersion: null }
				: null;
			return { ok: result.ok, message: result.message, remote };
		},
		upload,
		inspect,
		restore,
		onProviderDatabaseChanged(): void {
			void (async () => {
				const config = await readConfig();
				if (!config?.autoSync || !isConfigured(config)) return;
				if (autoSyncTimer !== null) clearTimeout(autoSyncTimer);
				autoSyncTimer = setTimeout(() => {
					autoSyncTimer = null;
					upload('auto').catch((error) => { console.error('自动同步上传失败：', error); });
				}, AUTO_SYNC_DEBOUNCE_MS);
				deps.onChanged(await snapshotState());
			})();
		},
		async dispose(): Promise<void> {
			if (autoSyncTimer !== null) { clearTimeout(autoSyncTimer); autoSyncTimer = null; }
			await queue.catch(() => { });
		},
	};
}
