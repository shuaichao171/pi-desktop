import { useSyncExternalStore } from 'react';

/**
 * Question auto-resolution (zcode askUserQuestionAutoResolution): a question
 * the agent waits on cancels itself when it stays unanswered, so a run can
 * never deadlock on a missed prompt. The timeline follows zcode's
 * interaction-registry: a hidden grace (no countdown shown), then a visible
 * countdown, then the deadline auto-cancels the request. The grace is 60s but
 * never more than half the deadline, so even a 1-minute limit shows its
 * countdown. The first user interaction with the question permanently pauses
 * its auto-resolution.
 *
 * The deadline is a user preference in whole minutes and `0` means "no limit",
 * which is also the default: an unanswered question then waits forever.
 * Each question is measured from when it was armed (its arrival while a limit
 * was set). Changing the limit re-plans waiting questions against that same
 * arrival time instead of restarting them; one the new limit already overran
 * still gets a final visible countdown (QUESTION_AUTO_RESOLUTION_FINAL_NOTICE_MS)
 * rather than vanishing at once. Picking 不限 disarms every waiting question,
 * and setting a limit again only arms questions that arrive afterwards.
 */

const STORAGE_KEY = 'pi-desktop:question-auto-resolution';
const listeners = new Set<() => void>();

export const QUESTION_AUTO_RESOLUTION_HIDDEN_GRACE_MS = 60_000;
/** Shortest visible countdown a waiting question gets when a lowered limit has already passed. */
export const QUESTION_AUTO_RESOLUTION_FINAL_NOTICE_MS = 30_000;
/** Selectable deadlines in whole minutes; 0 is 不限 (no auto cancel). */
export const QUESTION_AUTO_RESOLUTION_MINUTE_OPTIONS = [0, 1, 3, 5, 10, 30] as const;
export const DEFAULT_QUESTION_AUTO_RESOLUTION_MINUTES = 0;
/** Deadline the old on/off preference implied; migrating `true` keeps that behavior. */
export const LEGACY_QUESTION_AUTO_RESOLUTION_MINUTES = 5;
/** Upper bound for a stored value: a day. Anything else is treated as no limit. */
const MAX_AUTO_RESOLUTION_MINUTES = 24 * 60;

/**
 * Normalizes a stored preference into minutes. Legacy booleans migrate: an
 * explicitly enabled switch keeps its old 5-minute deadline, a disabled one and
 * a missing value both become 不限. Unusable values fall back to 不限 so a
 * corrupt entry can never auto-cancel a question the user meant to answer.
 */
export function normalizeQuestionAutoResolutionMinutes(value: unknown): number {
	if (value === true) return LEGACY_QUESTION_AUTO_RESOLUTION_MINUTES;
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_QUESTION_AUTO_RESOLUTION_MINUTES;
	return Math.min(MAX_AUTO_RESOLUTION_MINUTES, Math.ceil(value));
}

function readStored(): number {
	try {
		return normalizeQuestionAutoResolutionMinutes(typeof window === 'undefined' ? null : JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null'));
	} catch {
		return normalizeQuestionAutoResolutionMinutes(null);
	}
}

let minutes = readStored();

function publish(next: number): void {
	if (minutes === next) return;
	minutes = next;
	for (const listener of listeners) listener();
}

export function getQuestionAutoResolutionMinutes(): number {
	return minutes;
}

/** Apply locally even when persistence fails; the return value reports storage success. */
export function setQuestionAutoResolutionMinutes(value: number): boolean {
	const normalized = normalizeQuestionAutoResolutionMinutes(value);
	publish(normalized);
	try {
		if (typeof window !== 'undefined') {
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
			return true;
		}
	} catch { /* keep the in-session preference */ }
	return false;
}

export function subscribeQuestionAutoResolution(listener: () => void): () => void {
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

export function useQuestionAutoResolutionMinutes(): [number, typeof setQuestionAutoResolutionMinutes] {
	return [useSyncExternalStore(subscribeQuestionAutoResolution, getQuestionAutoResolutionMinutes, () => DEFAULT_QUESTION_AUTO_RESOLUTION_MINUTES), setQuestionAutoResolutionMinutes];
}

/** Question kinds the agent blocks on; approvals (confirm) and notices never auto-cancel. */
export function isQuestionAutoResolutionKind(kind: string): boolean {
	return kind === 'select' || kind === 'input' || kind === 'editor';
}

export type QuestionAutoResolutionPlan =
	| { state: 'unlimited' }
	| { state: 'grace' }
	| { state: 'countdown'; remainingMs: number }
	| { state: 'expired' };

/**
 * Pure timeline so tests can cover the grace/countdown/deadline semantics.
 * `timeoutMs` is the total deadline measured from the request appearing and
 * includes the hidden grace; null or non-positive means no limit.
 */
export function planQuestionAutoResolution(elapsedMs: number, timeoutMs: number | null = null): QuestionAutoResolutionPlan {
	if (timeoutMs === null || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return { state: 'unlimited' };
	if (!Number.isFinite(elapsedMs) || elapsedMs >= timeoutMs) return { state: 'expired' };
	const graceMs = Math.min(QUESTION_AUTO_RESOLUTION_HIDDEN_GRACE_MS, timeoutMs / 2);
	if (elapsedMs >= graceMs) return { state: 'countdown', remainingMs: Math.max(0, timeoutMs - elapsedMs) };
	return { state: 'grace' };
}

/** m:ss label for the visible countdown chip. */
export function formatQuestionCountdown(remainingMs: number): string {
	const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
	const minutes = Math.floor(seconds / 60);
	return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
