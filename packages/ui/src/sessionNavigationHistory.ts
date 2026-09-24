export interface SessionNavigationTarget {
	cwd: string;
	sessionId: string;
	sessionPath: string | null;
}

export interface SessionNavigationHistory {
	entries: SessionNavigationTarget[];
	cursor: number;
}

export const MAX_SESSION_NAVIGATION_HISTORY = 100;

export function createSessionNavigationHistory(): SessionNavigationHistory {
	return { entries: [], cursor: -1 };
}

export function sameSessionNavigationTarget(left: SessionNavigationTarget | null | undefined, right: SessionNavigationTarget | null | undefined): boolean {
	return Boolean(left && right && left.cwd === right.cwd && left.sessionId === right.sessionId);
}

/** Session ids remain stable when a new conversation acquires a persisted path. */
export function recordSessionVisit(history: SessionNavigationHistory, target: SessionNavigationTarget): SessionNavigationHistory {
	const current = history.entries[history.cursor];
	if (sameSessionNavigationTarget(current, target)) {
		if (current?.sessionPath === target.sessionPath) return history;
		return { ...history, entries: history.entries.map((entry) => sameSessionNavigationTarget(entry, target) ? { ...target } : entry) };
	}
	const entries = [...history.entries.slice(0, history.cursor + 1), { ...target }].slice(-MAX_SESSION_NAVIGATION_HISTORY);
	return { entries, cursor: entries.length - 1 };
}

/** Planning never advances the cursor: only a verified successful visit can commit it. */
export function planSessionNavigation(history: SessionNavigationHistory, direction: -1 | 1): { cursor: number; target: SessionNavigationTarget } | null {
	const cursor = history.cursor + direction;
	const target = history.entries[cursor];
	return target ? { cursor, target: { ...target } } : null;
}

export function commitSessionNavigation(history: SessionNavigationHistory, cursor: number, target: SessionNavigationTarget): SessionNavigationHistory {
	if (!sameSessionNavigationTarget(history.entries[cursor], target)) return history;
	return { entries: history.entries.map((entry) => sameSessionNavigationTarget(entry, target) ? { ...target } : entry), cursor };
}

/** Last-resort recovery after both a navigation and its rollback fail. */
export function reconcileSessionNavigation(history: SessionNavigationHistory, actual: SessionNavigationTarget): SessionNavigationHistory {
	if (history.cursor < 0) return recordSessionVisit(history, actual);
	return { ...history, entries: history.entries.map((entry, index) => index === history.cursor ? { ...actual } : entry) };
}
