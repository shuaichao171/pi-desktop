import { useSyncExternalStore } from 'react';

/**
 * Whether the conversation stream renders the model's reasoning (thinking)
 * blocks (zcode messageStreamShowReasoning). Turned off, only the reply text
 * and tool activity remain; the underlying thinking stays in the session
 * file so re-enabling restores it everywhere.
 */

const STORAGE_KEY = 'pi-desktop:message-stream-show-reasoning';
const listeners = new Set<() => void>();

export function normalizeMessageStreamShowReasoning(value: unknown): boolean {
	return value === false ? false : true; // shown by default
}

function readStored(): boolean {
	try {
		return normalizeMessageStreamShowReasoning(typeof window === 'undefined' ? null : JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null'));
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

export function getMessageStreamShowReasoning(): boolean {
	return enabled;
}

/** Apply locally even when persistence fails; the return value reports storage success. */
export function setMessageStreamShowReasoning(value: boolean): boolean {
	publish(value);
	try {
		if (typeof window !== 'undefined') {
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
			return true;
		}
	} catch { /* keep the in-session preference */ }
	return false;
}

export function subscribeMessageStreamShowReasoning(listener: () => void): () => void {
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

export function useMessageStreamShowReasoning(): [boolean, typeof setMessageStreamShowReasoning] {
	return [useSyncExternalStore(subscribeMessageStreamShowReasoning, getMessageStreamShowReasoning, () => true), setMessageStreamShowReasoning];
}
