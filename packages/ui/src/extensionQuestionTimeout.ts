import { useSyncExternalStore } from 'react';

/**
 * Question auto-resolution (zcode askUserQuestionAutoResolution): a question
 * the agent waits on cancels itself when it stays unanswered, so a run can
 * never deadlock on a missed prompt. The timeline follows zcode's
 * interaction-registry: a 60s hidden grace (no countdown shown), then a
 * visible countdown, then the deadline auto-cancels the request. The first
 * user interaction with the question permanently pauses its auto-resolution;
 * turning the preference off cancels every pending countdown, and turning it
 * back on only arms questions that arrive afterwards.
 */

const STORAGE_KEY = 'pi-desktop:question-auto-resolution';
const listeners = new Set<() => void>();

export const QUESTION_AUTO_RESOLUTION_HIDDEN_GRACE_MS = 60_000;
export const QUESTION_AUTO_RESOLUTION_MS = 300_000;

export function normalizeQuestionAutoResolution(value: unknown): boolean {
	return value === false ? false : true; // enabled by default (zcode defaults on)
}

function readStored(): boolean {
	try {
		return normalizeQuestionAutoResolution(typeof window === 'undefined' ? null : JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null'));
	} catch {
		return normalizeQuestionAutoResolution(null);
	}
}

let enabled = readStored();

function publish(next: boolean): void {
	if (enabled === next) return;
	enabled = next;
	for (const listener of listeners) listener();
}

export function getQuestionAutoResolutionEnabled(): boolean {
	return enabled;
}

/** Apply locally even when persistence fails; the return value reports storage success. */
export function setQuestionAutoResolutionEnabled(value: boolean): boolean {
	publish(value);
	try {
		if (typeof window !== 'undefined') {
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
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

export function useQuestionAutoResolutionEnabled(): [boolean, typeof setQuestionAutoResolutionEnabled] {
	return [useSyncExternalStore(subscribeQuestionAutoResolution, getQuestionAutoResolutionEnabled, () => true), setQuestionAutoResolutionEnabled];
}

/** Question kinds the agent blocks on; approvals (confirm) and notices never auto-cancel. */
export function isQuestionAutoResolutionKind(kind: string): boolean {
	return kind === 'select' || kind === 'input' || kind === 'editor';
}

export type QuestionAutoResolutionPlan =
	| { state: 'grace' }
	| { state: 'countdown'; remainingMs: number }
	| { state: 'expired' };

/** Pure timeline so tests can cover the grace/countdown/deadline semantics. */
export function planQuestionAutoResolution(elapsedMs: number): QuestionAutoResolutionPlan {
	if (!Number.isFinite(elapsedMs) || elapsedMs >= QUESTION_AUTO_RESOLUTION_MS) return { state: 'expired' };
	if (elapsedMs >= QUESTION_AUTO_RESOLUTION_HIDDEN_GRACE_MS) return { state: 'countdown', remainingMs: Math.max(0, QUESTION_AUTO_RESOLUTION_MS - elapsedMs) };
	return { state: 'grace' };
}

/** m:ss label for the visible countdown chip. */
export function formatQuestionCountdown(remainingMs: number): string {
	const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
	const minutes = Math.floor(seconds / 60);
	return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
