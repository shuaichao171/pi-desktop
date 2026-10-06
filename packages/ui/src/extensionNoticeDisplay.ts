import { useSyncExternalStore } from 'react';

/**
 * Whether plugin (extension) notifications surface anywhere in the UI: the
 * inline notice cards inside conversations and the transient toast stack.
 * Turned off, plugin notices are neither recorded visibly nor toasted — the
 * underlying system messages stay in the transcript untouched.
 */

const STORAGE_KEY = 'pi-desktop:extension-notice-display';
const listeners = new Set<() => void>();

export function normalizeExtensionNoticeDisplay(value: unknown): boolean {
	return value === false ? false : true; // enabled by default
}

function readStored(): boolean {
	try {
		return normalizeExtensionNoticeDisplay(typeof window === 'undefined' ? null : JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null'));
	} catch {
		return true;
	}
}

let enabled = readStored();

function publish(next: boolean): void {
	if (enabled === next) return;
	enabled = next;
	for (const listener of listeners) listener();
}

export function getExtensionNoticeDisplayEnabled(): boolean {
	return enabled;
}

/** Apply locally even when persistence fails; the return value reports storage success. */
export function setExtensionNoticeDisplayEnabled(value: boolean): boolean {
	publish(value);
	try {
		if (typeof window !== 'undefined') {
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
			return true;
		}
	} catch { /* keep the in-session preference */ }
	return false;
}

export function subscribeExtensionNoticeDisplay(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

if (typeof window !== 'undefined') {
	window.addEventListener('storage', (event) => {
		if (event.key !== null && event.key !== STORAGE_KEY) return;
		try { if (event.storageArea && event.storageArea !== window.localStorage) return; } catch { return; }
		publish(readStored());
	});
}

export function useExtensionNoticeDisplayEnabled(): [boolean, typeof setExtensionNoticeDisplayEnabled] {
	return [useSyncExternalStore(subscribeExtensionNoticeDisplay, getExtensionNoticeDisplayEnabled, () => true), setExtensionNoticeDisplayEnabled];
}
