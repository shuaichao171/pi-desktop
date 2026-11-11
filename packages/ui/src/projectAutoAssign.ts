import { useSyncExternalStore } from 'react';
import { sidebarWorkspaceKey } from './sidebarOrganization.ts';

/**
 * Automatic project assignment: when the first message of an unassigned
 * conversation names a path inside an opened project (e.g. "E:\work\app 审查项目"),
 * the conversation is created in that project instead of the temporary
 * conversation directory. Enabled by default; stored in localStorage, which the
 * main window, pai windows and split panes share.
 */

const STORAGE_KEY = 'pi-desktop:project-auto-assign';
const listeners = new Set<() => void>();

export function normalizeProjectAutoAssign(value: unknown): boolean {
	return value === false ? false : true; // enabled by default
}

function readStored(): boolean {
	try {
		return normalizeProjectAutoAssign(typeof window === 'undefined' ? null : JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null'));
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

export function getProjectAutoAssignEnabled(): boolean {
	return enabled;
}

/** Applies locally even when persistence fails; returns whether it was stored. */
export function setProjectAutoAssignEnabled(value: boolean): boolean {
	publish(value);
	try {
		if (typeof window !== 'undefined') {
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
			return true;
		}
	} catch { /* keep the in-session preference */ }
	return false;
}

export function subscribeProjectAutoAssign(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

export function useProjectAutoAssignEnabled(): [boolean, (value: boolean) => boolean] {
	return [useSyncExternalStore(subscribeProjectAutoAssign, getProjectAutoAssignEnabled, getProjectAutoAssignEnabled), setProjectAutoAssignEnabled];
}

if (typeof window !== 'undefined') {
	window.addEventListener('storage', (event) => {
		if (event.key !== null && event.key !== STORAGE_KEY) return;
		try { if (event.storageArea && event.storageArea !== window.localStorage) return; } catch { return; }
		publish(readStored());
	});
}

/** Separators collapse so "E:\\a\\b", "E:/a/b" and "E:\a\b" compare equal. */
function normalizePathText(text: string): string {
	return text.replace(/[\\/]+/g, '/');
}

/** A character that can continue a file name, so "E:/app" must not match "E:/apple". */
function continuesName(text: string, index: number): boolean {
	const char = text[index];
	if (char === undefined) return false;
	if (/[A-Za-z0-9_\-]/.test(char)) return true;
	// "E:/app." at a sentence end is a boundary; "E:/app.v2" is another folder.
	return char === '.' && /[A-Za-z0-9_\-]/.test(text[index + 1] ?? '');
}

/** A path mention starts the message or follows a non-name character (space, quote, punctuation). */
function startsMention(text: string, index: number): boolean {
	return index === 0 || !/[A-Za-z0-9_\-.:]/.test(text[index - 1]!);
}

/**
 * Returns the opened project that a message's absolute path points into, or null.
 * The deepest project containing a mentioned path wins; when the message names
 * several different projects, only a path that opens the message decides.
 */
export function detectMessageProject(text: string, projects: readonly string[]): string | null {
	const message = normalizePathText(text.trim());
	if (!message) return null;
	const lowered = message.toLowerCase();
	const candidates = projects
		.map((project) => {
			const raw = sidebarWorkspaceKey(project);
			// sidebarWorkspaceKey lowercases Windows (drive / UNC) paths only; POSIX stays case-sensitive.
			return { project, key: normalizePathText(raw), caseInsensitive: /^[a-z]:(?:\/|$)/i.test(raw) || raw.startsWith('//') };
		})
		// A bare root ("/" or "C:") would claim every path.
		.filter((candidate) => candidate.key.length > 1 && !/^[a-z]:\/?$/i.test(candidate.key))
		.sort((a, b) => b.key.length - a.key.length);
	if (!candidates.length) return null;
	const matches: { index: number; project: string }[] = [];
	for (let index = 0; index < message.length; index += 1) {
		if (!startsMention(message, index)) continue;
		for (const candidate of candidates) {
			const haystack = candidate.caseInsensitive ? lowered : message;
			if (!haystack.startsWith(candidate.key, index)) continue;
			const end = index + candidate.key.length;
			if (continuesName(message, end)) continue;
			matches.push({ index, project: candidate.project });
			break; // longest key first: the deepest project at this position
		}
	}
	if (!matches.length) return null;
	const distinct = new Set(matches.map((match) => sidebarWorkspaceKey(match.project)));
	if (distinct.size === 1) return matches[0]!.project;
	return matches[0]!.index === 0 ? matches[0]!.project : null;
}

const MAX_CANDIDATES = 16;
/** Characters that end an unquoted path: whitespace, quotes, shell metacharacters and CJK punctuation. */
const PATH_STOP = String.raw`\s"'` + '`' + '<>|?*，。；：！？、“”‘’（）【】《》';
const QUOTED_PATH = /["'`“‘]((?:[A-Za-z]:[\\/]|\\\\|\/)[^"'`”’\r\n]*)["'`”’]/g;
// A bare path starts the text or follows a character that cannot be part of a path or URL.
const BARE_PATH = new RegExp(String.raw`(?:^|[^A-Za-z0-9_\-.:/\\])((?:[A-Za-z]:[\\/]|\\\\)[^${PATH_STOP}]*|/[^${PATH_STOP}/][^${PATH_STOP}]*)`, 'g');
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

/**
 * Absolute paths a message mentions, in order, for the main process to check on
 * disk. A bare path written straight into Chinese text ("E:\app审查") also yields
 * the part before the first CJK character, since the folder name may end there.
 */
export function projectPathCandidates(text: string): string[] {
	const found: string[] = [];
	const add = (raw: string) => {
		const path = raw.replace(/[.,;:!?)\]}]+$/, '');
		if (path.length < 3 || found.includes(path)) return;
		found.push(path);
	};
	for (const match of text.matchAll(QUOTED_PATH)) add(match[1]!);
	for (const match of text.matchAll(BARE_PATH)) {
		const raw = match[1]!;
		add(raw);
		const cjk = raw.search(CJK);
		if (cjk > 0) add(raw.slice(0, cjk));
	}
	return found.slice(0, MAX_CANDIDATES);
}
