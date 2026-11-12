/**
 * Focus-aware polling (session polling gating): non-critical renderer polls
 * run at their base interval while the window is focused, stretch their
 * interval while it is not, pause entirely after a long unfocused stretch, and
 * refresh once immediately when focus returns. Time-sensitive schedulers (the
 * automation executor) intentionally do not use this.
 */

export interface FocusAwarePollOptions {
	/** Interval multiplier while the window is unfocused (clamped to >= 1). */
	unfocusedMultiplier?: number;
	/** Sustained unfocused time after which the poll pauses (null disables the cutoff). */
	idleCutoffMs?: number | null;
}

export const FOCUS_AWARE_POLL_DEFAULTS: Required<Exclude<FocusAwarePollOptions, 'idleCutoffMs'>> & { idleCutoffMs: number | null } = {
	unfocusedMultiplier: 3,
	idleCutoffMs: 10 * 60_000,
};

export interface FocusPollState {
	focused: boolean;
	/** How long the window has been unfocused right now (0 while focused). */
	unfocusedMs: number;
}

/**
 * The delay a poll should wait right now: the base interval while focused,
 * a stretched one while unfocused, or null once the idle cutoff has paused it.
 */
export function focusAwarePollDelayMs(baseIntervalMs: number, state: FocusPollState, options?: FocusAwarePollOptions): number | null {
	if (!Number.isFinite(baseIntervalMs) || baseIntervalMs <= 0) return null;
	if (state.focused) return baseIntervalMs;
	const idleCutoffMs = options?.idleCutoffMs !== undefined ? options.idleCutoffMs : FOCUS_AWARE_POLL_DEFAULTS.idleCutoffMs;
	if (idleCutoffMs !== null && Number.isFinite(idleCutoffMs) && idleCutoffMs >= 0 && state.unfocusedMs >= idleCutoffMs) return null;
	// 非有限倍率（如 NaN）按默认处理：Math.max(1, NaN) = NaN 会让 setTimeout 立即触发。
	const requestedMultiplier = options?.unfocusedMultiplier ?? FOCUS_AWARE_POLL_DEFAULTS.unfocusedMultiplier;
	const multiplier = Number.isFinite(requestedMultiplier) ? Math.max(1, requestedMultiplier) : FOCUS_AWARE_POLL_DEFAULTS.unfocusedMultiplier;
	return baseIntervalMs * multiplier;
}
