import { useEffect, useRef } from 'react';
import { focusAwarePollDelayMs, FOCUS_AWARE_POLL_DEFAULTS, type FocusAwarePollOptions, type FocusPollState } from './focusAwarePolling';

/**
 * Window focus tracking shared by every focus-aware poll. The app already
 * treats `document.hasFocus()` as the truth for background notifications
 * (task completion sound); the same signal gates non-critical polling.
 */

let focused = typeof window === 'undefined' ? true : document.hasFocus();
let blurredAt: number | null = focused ? null : Date.now();
const listeners = new Set<() => void>();

function publish(): void {
	for (const listener of listeners) listener();
}

if (typeof window !== 'undefined') {
	window.addEventListener('focus', () => { if (focused) return; focused = true; blurredAt = null; publish(); });
	window.addEventListener('blur', () => { if (!focused) return; focused = false; blurredAt = Date.now(); publish(); });
}

/** Current focus/idle state; `unfocusedMs` is 0 while focused. */
export function windowFocusState(): FocusPollState {
	return { focused, unfocusedMs: focused || blurredAt === null ? 0 : Date.now() - blurredAt };
}

export function subscribeWindowFocus(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

/**
 * Self-scheduling focus-aware poll. While focused it ticks at `baseIntervalMs`;
 * unfocused it stretches the interval (`unfocusedMultiplier`), pauses after the
 * idle cutoff, and regaining focus fires the callback once immediately before
 * resuming the normal cadence. Pass a non-positive interval to disable it.
 */
export function useFocusAwarePoll(callback: () => void, baseIntervalMs: number, options?: FocusAwarePollOptions): void {
	const callbackRef = useRef(callback);
	callbackRef.current = callback;
	const multiplier = options?.unfocusedMultiplier ?? FOCUS_AWARE_POLL_DEFAULTS.unfocusedMultiplier;
	const idleCutoffMs = options?.idleCutoffMs !== undefined ? options.idleCutoffMs : FOCUS_AWARE_POLL_DEFAULTS.idleCutoffMs;
	const optionsKey = `${multiplier}:${idleCutoffMs ?? 'off'}`;
	useEffect(() => {
		if (!Number.isFinite(baseIntervalMs) || baseIntervalMs <= 0) return;
		const resolved: FocusAwarePollOptions = { unfocusedMultiplier: multiplier, idleCutoffMs };
		let timer: ReturnType<typeof setTimeout> | null = null;
		let stopped = false;
		const clear = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
		const schedule = () => {
			if (stopped || timer !== null) return;
			// null delay = idle cutoff: no timer. Refocus reschedules through the listener.
			const delay = focusAwarePollDelayMs(baseIntervalMs, windowFocusState(), resolved);
			if (delay === null) return;
			timer = setTimeout(() => { timer = null; if (!stopped) { callbackRef.current(); schedule(); } }, delay);
		};
		const onFocusChange = () => {
			clear();
			if (windowFocusState().focused && !stopped) {
				// Refocus refreshes once immediately, then resumes the normal cadence.
				callbackRef.current();
			}
			schedule();
		};
		schedule();
		const unsubscribe = subscribeWindowFocus(onFocusChange);
		return () => { stopped = true; clear(); unsubscribe(); };
	}, [baseIntervalMs, optionsKey, multiplier, idleCutoffMs]);
}
