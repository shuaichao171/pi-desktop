import { useSyncExternalStore } from 'react';
import type { UiSplitPaneState } from '@pidesktop/shared';

/**
 * "Loaded sessions" (已加载会话): conversations the user keeps ready in the main window.
 * Two kinds share one list in the sidebar:
 * - main: kept warm in a pinned background context of the main agent; Ctrl+Tab cycles them.
 * - pane: every split pane of the window, shown or hidden. A pane's own close button only
 *   hides it (its conversation keeps running); closing it for real happens from this list.
 */
export interface LoadedSessionEntry { cwd: string; path: string }
export interface LoadedSessionsState { main: LoadedSessionEntry[]; panes: UiSplitPaneState[] }

export const MAX_LOADED_SESSIONS = 10;
const STORAGE_KEY = 'pi-desktop:loaded-sessions';
const listeners = new Set<() => void>();

export function normalizeLoadedSessions(value: unknown): LoadedSessionEntry[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const entries: LoadedSessionEntry[] = [];
	for (const item of value) {
		if (!item || typeof item !== 'object') continue;
		const { cwd, path } = item as Partial<LoadedSessionEntry>;
		if (typeof cwd !== 'string' || !cwd || typeof path !== 'string' || !path || seen.has(path)) continue;
		seen.add(path);
		entries.push({ cwd, path });
		if (entries.length >= MAX_LOADED_SESSIONS) break;
	}
	return entries;
}

function readStored(): LoadedSessionEntry[] {
	try { return normalizeLoadedSessions(typeof window === 'undefined' ? null : JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')); }
	catch { return []; }
}

let state: LoadedSessionsState = { main: readStored(), panes: [] };

function publish(next: LoadedSessionsState, persist: boolean): void {
	state = next;
	if (persist) {
		try { if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next.main)); }
		catch { /* The list still works for this session. */ }
	}
	for (const listener of listeners) listener();
}

export function getLoadedSessions(): LoadedSessionsState { return state; }

/** Adds (or moves to the end) a main-window loaded conversation; returns false when the list is full. */
export function addLoadedSession(entry: LoadedSessionEntry): boolean {
	if (state.main.some((item) => item.path === entry.path)) return true;
	if (state.main.length >= MAX_LOADED_SESSIONS) return false;
	publish({ ...state, main: [...state.main, { cwd: entry.cwd, path: entry.path }] }, true);
	return true;
}

export function removeLoadedSession(path: string): void {
	if (!state.main.some((item) => item.path === path)) return;
	publish({ ...state, main: state.main.filter((item) => item.path !== path) }, true);
}

export function setLoadedPanes(panes: UiSplitPaneState[]): void {
	publish({ ...state, panes: panes.map((pane) => ({ ...pane })) }, false);
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

export function useLoadedSessions(): LoadedSessionsState {
	return useSyncExternalStore(subscribe, getLoadedSessions, getLoadedSessions);
}

/**
 * Ctrl+Tab target among the main window's loaded conversations (pane-hosted ones excluded:
 * they live in their own view). From a conversation outside the list, forward goes to the
 * first entry and backward to the last.
 */
export function nextLoadedSession(entries: readonly LoadedSessionEntry[], panes: readonly UiSplitPaneState[], currentPath: string | null, direction: 1 | -1): LoadedSessionEntry | null {
	const held = new Set(panes.map((pane) => pane.sessionPath).filter(Boolean));
	const cycle = entries.filter((entry) => !held.has(entry.path));
	if (!cycle.length) return null;
	const index = cycle.findIndex((entry) => entry.path === currentPath);
	if (index < 0) return direction > 0 ? cycle[0]! : cycle[cycle.length - 1]!;
	if (cycle.length === 1) return null;
	return cycle[(index + direction + cycle.length) % cycle.length]!;
}

/** Shared drag payload: a conversation dragged from the sidebar toward a drop target. */
export interface SessionDragState { cwd: string; path: string; title: string; x: number; y: number; target: 'loaded' | 'split' | null }
let drag: SessionDragState | null = null;
const dragListeners = new Set<() => void>();
export function getSessionDrag(): SessionDragState | null { return drag; }
export function setSessionDrag(next: SessionDragState | null): void {
	drag = next;
	for (const listener of dragListeners) listener();
}
export function useSessionDrag(): SessionDragState | null {
	return useSyncExternalStore((listener) => { dragListeners.add(listener); return () => { dragListeners.delete(listener); }; }, getSessionDrag, getSessionDrag);
}

/** Resolves which drop target (if any) is under the pointer. */
export function sessionDropTargetAt(x: number, y: number): 'loaded' | 'split' | null {
	if (typeof document === 'undefined') return null;
	const element = document.elementFromPoint(x, y);
	const zone = element?.closest<HTMLElement>('[data-session-drop]');
	const kind = zone?.dataset.sessionDrop;
	return kind === 'loaded' || kind === 'split' ? kind : null;
}
