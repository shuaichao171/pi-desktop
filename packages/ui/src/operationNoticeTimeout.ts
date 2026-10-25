import { useSyncExternalStore } from 'react';
import type { OperationNotice } from './operationFeedback';

/**
 * How long operation-result notices (save, delete, copy, rename, …) stay on
 * screen before dismissing themselves. Success and error notices both go away
 * on their own now; a running operation keeps its pending notice, because that
 * card is the only visible sign of in-flight work and it is replaced by its own
 * success/error card when the operation settles.
 *
 * Failures stay twice as long as successes so the reason can be read and the
 * retry action used, and hovering or focusing a notice holds its countdown —
 * the same interaction plugin notices use, so a card never disappears under the
 * pointer. `0` (不限) keeps the old behavior: the close button is the only exit.
 */

const STORAGE_KEY = 'pi-desktop:operation-notice-timeout';
const listeners = new Set<() => void>();

/** Selectable lifetimes in whole seconds; 0 is 不限 (close manually). */
export const OPERATION_NOTICE_TIMEOUT_SECOND_OPTIONS = [0, 3, 5, 10, 30] as const;
/** Closest preset to the fixed 4.5s success timer this preference replaced. */
export const DEFAULT_OPERATION_NOTICE_TIMEOUT_SECONDS = 5;
/** Failures stay visible twice as long as successes. */
export const OPERATION_NOTICE_ERROR_MULTIPLIER = 2;
/** Upper bound for a stored value: one hour. Anything else falls back to the default. */
const MAX_TIMEOUT_SECONDS = 3600;

/**
 * Normalizes a stored preference into whole seconds. Missing, unusable, or
 * negative values fall back to the default so a corrupt entry can never make
 * notices vanish instantly; 0 is a real value and means "close manually".
 */
export function normalizeOperationNoticeTimeoutSeconds(value: unknown): number {
	const raw = typeof value === 'string' ? value.trim() : value;
	if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') return DEFAULT_OPERATION_NOTICE_TIMEOUT_SECONDS;
	const seconds = Number(raw);
	if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_OPERATION_NOTICE_TIMEOUT_SECONDS;
	return Math.min(MAX_TIMEOUT_SECONDS, Math.floor(seconds));
}

/**
 * Auto-dismiss delay for one notice, or `null` when it must stay until closed:
 * pending notices (work still running), 不限, or a zero-second preference.
 */
export function operationNoticeTimeoutMs(kind: OperationNotice['kind'], seconds: number): number | null {
	if (kind === 'pending') return null;
	const normalized = normalizeOperationNoticeTimeoutSeconds(seconds);
	if (normalized === 0) return null;
	return normalized * 1000 * (kind === 'error' ? OPERATION_NOTICE_ERROR_MULTIPLIER : 1);
}

function readStoredSeconds(): number {
	try {
		return normalizeOperationNoticeTimeoutSeconds(typeof window === 'undefined' ? null : window.localStorage.getItem(STORAGE_KEY));
	} catch {
		return DEFAULT_OPERATION_NOTICE_TIMEOUT_SECONDS;
	}
}

let timeoutSeconds = readStoredSeconds();

function publish(next: number): void {
	if (timeoutSeconds === next) return;
	timeoutSeconds = next;
	for (const listener of listeners) listener();
}

export function getOperationNoticeTimeoutSeconds(): number {
	return timeoutSeconds;
}

/** Apply immediately to every consumer, even when persistence is unavailable. */
export function setOperationNoticeTimeoutSeconds(value: number): boolean {
	let saved = false;
	try {
		if (typeof window !== 'undefined') {
			window.localStorage.setItem(STORAGE_KEY, String(normalizeOperationNoticeTimeoutSeconds(value)));
			saved = true;
		}
	} catch { /* Keep this preference available for the current app session. */ }
	publish(normalizeOperationNoticeTimeoutSeconds(value));
	return saved;
}

export function subscribeOperationNoticeTimeout(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

if (typeof window !== 'undefined') {
	window.addEventListener('storage', (event) => {
		if (event.key !== null && event.key !== STORAGE_KEY) return;
		try {
			if (event.storageArea && event.storageArea !== window.localStorage) return;
		} catch { return; }
		publish(normalizeOperationNoticeTimeoutSeconds(event.key === null ? null : event.newValue));
	});
}

export function useOperationNoticeTimeoutSeconds(): [number, (value: number) => boolean] {
	const seconds = useSyncExternalStore(subscribeOperationNoticeTimeout, getOperationNoticeTimeoutSeconds, () => DEFAULT_OPERATION_NOTICE_TIMEOUT_SECONDS);
	return [seconds, setOperationNoticeTimeoutSeconds];
}
