/**
 * At-rest encoding for secrets kept in userData state files.
 *
 * `enc:` values are encrypted with Electron safeStorage (OS keychain / DPAPI).
 * When the platform offers no encryption backend the value falls back to
 * `plain:` base64 so the setting still works; that is no worse than plain JSON.
 */

import * as electron from 'electron';

// Test stubs provide only part of Electron's surface; access safeStorage defensively.
const safeStorage = electron.safeStorage;

export function encryptSecret(value: string): string {
	if (!value) return '';
	if (typeof safeStorage?.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()) {
		try { return `enc:${Buffer.from(safeStorage.encryptString(value)).toString('base64')}`; } catch { /* fall through to plain */ }
	}
	return `plain:${Buffer.from(value, 'utf8').toString('base64')}`;
}

/** Decodes an `encryptSecret` value; '' when it cannot be read (other keychain, corrupt). */
export function decryptSecret(stored: string): string {
	if (!stored) return '';
	if (stored.startsWith('enc:')) {
		try { return safeStorage?.decryptString(Buffer.from(stored.slice(4), 'base64')) ?? ''; } catch { return ''; }
	}
	if (stored.startsWith('plain:')) {
		try { return Buffer.from(stored.slice(6), 'base64').toString('utf8'); } catch { return ''; }
	}
	return '';
}

/** True for values written by `encryptSecret` (as opposed to a legacy raw secret). */
export function isEncodedSecret(stored: string): boolean {
	return stored.startsWith('enc:') || stored.startsWith('plain:');
}
