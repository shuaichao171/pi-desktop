import { useEffect, useSyncExternalStore } from 'react';

/**
 * highlight.js loads on demand instead of shipping in the startup bundle. Until
 * it arrives, code blocks render as escaped plain text; once loaded it stays
 * resident, so later renders highlight synchronously without flicker.
 */
export type Highlighter = typeof import('highlight.js/lib/common').default;

let loaded: Highlighter | null = null;
let loading: Promise<Highlighter | null> | null = null;
const listeners = new Set<() => void>();

export function loadHighlighter(): Promise<Highlighter | null> {
	if (loaded) return Promise.resolve(loaded);
	loading ??= import('highlight.js/lib/common').then((module) => {
		loaded = module.default;
		for (const listener of listeners) listener();
		return loaded;
	}, () => {
		// A failed chunk load leaves plain text in place; the next mount retries.
		loading = null;
		return null;
	});
	return loading;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

const snapshot = () => loaded;

/** The loaded highlighter, or null while it is still loading (callers render plain text). */
export function useHighlighter(enabled = true): Highlighter | null {
	const highlighter = useSyncExternalStore(subscribe, snapshot, snapshot);
	useEffect(() => { if (enabled && !highlighter) void loadHighlighter(); }, [enabled, highlighter]);
	return highlighter;
}
