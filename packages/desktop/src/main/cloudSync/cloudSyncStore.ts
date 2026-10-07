/**
 * Persistent cloud-sync configuration (userData/cloud-sync.json).
 *
 * Secrets are encrypted with Electron safeStorage when the OS keychain is
 * available; otherwise they fall back to obfuscated base64 and the stored
 * marker records which format is in use. Secrets never travel to the renderer.
 */

import * as electron from 'electron';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { backupCorruptStateFileAsync, CorruptStateFileError, readStateFileAsync, writeStateFileAsync } from '../stateFiles.ts';
import type { UiCloudSyncKind } from '@pidesktop/shared';

export const DEFAULT_REMOTE_PATH = 'pi-desktop/providers-backup.json';

/** The on-disk shape; secrets are stored encrypted/encoded. */
export interface StoredCloudSyncConfig {
	kind: UiCloudSyncKind;
	autoSync: boolean;
	remotePath: string;
	webdav?: { url: string; username: string; password: string };
	s3?: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string };
	r2?: { accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string };
	lastUploadAt: string | null;
	lastAutoSyncAt: string | null;
	lastError: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function stringField(value: unknown, max: number): string | undefined {
	if (typeof value !== 'string') return undefined;
	if (value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('云同步配置包含非法字符');
	return value;
}

function optionalString(value: unknown, max: number): string | null {
	const text = stringField(value, max);
	return text === undefined || text === '' ? null : text;
}

export function isValidCloudSyncConfig(value: unknown): value is StoredCloudSyncConfig {
	try {
		if (!isRecord(value)) return false;
		if (value.kind !== 'webdav' && value.kind !== 's3' && value.kind !== 'r2') return false;
		if (typeof value.autoSync !== 'boolean') return false;
		const remotePath = optionalString(value.remotePath, 200);
		if (remotePath !== null && (remotePath.startsWith('/') || remotePath.split('/').some((part) => part === '..' || part === '.'))) return false;
		if (value.kind === 'webdav') {
			if (!isRecord(value.webdav)) return false;
			const webdavUrl = stringField(value.webdav.url, 2000);
			if (!webdavUrl?.trim()) return false;
			const url = new URL(webdavUrl);
			if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
			if (!stringField(value.webdav.username, 500)?.trim()) return false;
			if (!stringField(value.webdav.password, 8000)) return false;
		}
		if (value.kind === 's3') {
			if (!isRecord(value.s3)) return false;
			const s3Endpoint = stringField(value.s3.endpoint, 2000) ?? '';
			if (s3Endpoint && !s3Endpoint.trim()) return false;
			if (s3Endpoint) new URL(s3Endpoint);
			if (!stringField(value.s3.region, 100)?.trim()) return false;
			if (!stringField(value.s3.bucket, 255)?.trim()) return false;
			if (!stringField(value.s3.accessKeyId, 500)?.trim()) return false;
			if (!stringField(value.s3.secretAccessKey, 8000)) return false;
		}
		if (value.kind === 'r2') {
			if (!isRecord(value.r2)) return false;
			if (!stringField(value.r2.accountId, 200)?.trim()) return false;
			if (!stringField(value.r2.bucket, 255)?.trim()) return false;
			if (!stringField(value.r2.accessKeyId, 500)?.trim()) return false;
			if (!stringField(value.r2.secretAccessKey, 8000)) return false;
		}
		return value.lastUploadAt === null || typeof value.lastUploadAt === 'string';
	} catch {
		return false;
	}
}

// Test stubs provide only part of Electron's surface; access safeStorage defensively.
const safeStorage = electron.safeStorage;

function encryptSecret(value: string): string {
	if (!value) return '';
	if (typeof safeStorage?.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()) {
		try { return `enc:${Buffer.from(safeStorage.encryptString(value)).toString('base64')}`; } catch { /* fall through to plain */ }
	}
	return `plain:${Buffer.from(value, 'utf8').toString('base64')}`;
}

function decryptSecret(stored: string): string {
	if (!stored) return '';
	if (stored.startsWith('enc:')) {
		try { return safeStorage?.decryptString(Buffer.from(stored.slice(4), 'base64')) ?? ''; } catch { return ''; }
	}
	if (stored.startsWith('plain:')) {
		try { return Buffer.from(stored.slice(6), 'base64').toString('utf8'); } catch { return ''; }
	}
	return '';
}

export interface CloudSyncStore {
	path: string;
	read(): Promise<StoredCloudSyncConfig | null>;
	/** Reads without throwing on corruption so diagnostics can report it. */
	tryRead(): Promise<StoredCloudSyncConfig | null>;
	write(config: StoredCloudSyncConfig): Promise<void>;
	encrypt(value: string): string;
	decrypt(value: string): string;
}

export function createCloudSyncStore(userDataPath: string): CloudSyncStore {
	const path = join(userDataPath, 'cloud-sync.json');
	const read = async (): Promise<StoredCloudSyncConfig> => readStateFileAsync(
		path,
		() => ({ kind: 'webdav', autoSync: false, remotePath: DEFAULT_REMOTE_PATH, webdav: { url: '', username: '', password: '' }, lastUploadAt: null, lastAutoSyncAt: null, lastError: null }) as StoredCloudSyncConfig,
		isValidCloudSyncConfig,
	);
	return {
		path,
		read,
		async tryRead(): Promise<StoredCloudSyncConfig | null> {
			try { await access(path); } catch { return null; }
			try { return await read(); }
			catch (error) {
				if (error instanceof CorruptStateFileError || error instanceof SyntaxError) {
					try {
						const backup = await backupCorruptStateFileAsync(path);
						console.error(`损坏的云同步配置已备份到 ${backup}`);
					} catch (backupError) { console.error('备份损坏的云同步配置失败：', backupError); }
					return null;
				}
				throw error;
			}
		},
		write: (config: StoredCloudSyncConfig) => writeStateFileAsync(path, config),
		encrypt: encryptSecret,
		decrypt: decryptSecret,
	};
}
