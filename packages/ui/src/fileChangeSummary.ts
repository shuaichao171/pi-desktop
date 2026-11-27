import type { UiFileChange, UiFileChangeTurn, UiFileDiff, UiToolActivity } from '@pidesktop/shared';

/**
 * File-change perception fallbacks and summaries.
 *
 * Primary data source is the session file-changes tracker (fileChangeTurns,
 * recorded per tool call by the agent and replayed with the session): it carries
 * per-file paths and kinds and works without Git. The helpers here cover what
 * that tracker cannot know:
 * - sessions recorded before the tracker existed have no fileChangeTurns, so
 *   edit/write tool calls in the transcript are aggregated as a fallback;
 * - the session-level summary is one union across every turn's changes.
 */

/** Writing tools whose transcript arguments name the file they touched. */
const WRITING_TOOLS = new Set(['edit', 'write']);

/**
 * Lexically normalize one tool-call path against the workspace root. Display
 * paths never escape the workspace and always use forward slashes; anything
 * absolute outside the root, escaping via `..`, empty, or under `.git` is
 * dropped (same rule as the tracker's relativeFilePath).
 */
export function normalizeToolFilePath(cwd: string, input: string): string | null {
	if (!input || /[\u0000-\u001f\u007f]/.test(input)) return null;
	const raw = input.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
	const driveOf = (value: string) => (/^([a-zA-Z]):(?:\/|$)/.exec(value)?.[1] ?? '').toLowerCase();
	const isAbsolute = raw.startsWith('/') || /^[a-zA-Z]:\//.test(raw);
	if (isAbsolute) {
		const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
		const sameDrive = !driveOf(root) || !driveOf(raw) || driveOf(root) === driveOf(raw);
		if (!sameDrive) return null;
		const stripDrive = (value: string) => (driveOf(value) ? value.replace(/^[a-zA-Z]:/, '') : value);
		const base = stripDrive(root);
		const target = stripDrive(raw);
		// A drive-root workspace contains every absolute path on that drive.
		if (base === '') return relativeParts(target.replace(/^\//, ''));
		if (!(target + '/').startsWith(base + '/')) return null;
		return relativeParts(target.slice(base.length + 1));
	}
	// Drive-relative paths (`C:file`) resolve against the process CWD, not the workspace.
	if (/^[a-zA-Z]:/.test(raw)) return null;
	return relativeParts(raw);
}

function relativeParts(input: string): string | null {
	const parts: string[] = [];
	for (const part of input.split('/')) {
		if (!part || part === '.') continue;
		if (part === '..') { if (!parts.pop()) return null; continue; }
		parts.push(part);
	}
	const path = parts.join('/');
	if (!path || parts.includes('.git')) return null;
	return path;
}

/**
 * Aggregate completed edit/write tool calls into per-run change lists — the
 * data source for sessions predating the file-changes tracker. Paths are
 * deduplicated per run. Kind stays 'modified': without before-state snapshots
 * added/deleted cannot be told apart.
 *
 * `trackedRunIds` are the runs the tracker has records for. Once the transcript
 * reaches the first of them the tracker was running, and from there on its
 * silence is authoritative: an edit that was reverted, or a write of identical
 * bytes, is a net-zero change the tracker deliberately drops. Aggregating those
 * calls would resurrect them as phantom "modified" files, so the fallback only
 * covers the calls recorded before the tracker's first run.
 */
export function fallbackTurnChanges(cwd: string, activities: readonly UiToolActivity[], trackedRunIds: ReadonlySet<string | null> = new Set()): Map<string | null, UiFileChange[]> {
	const files = new Map<string | null, Set<string>>();
	for (const activity of activities) {
		if (trackedRunIds.has(activity.runId ?? null)) break;
		if (activity.status !== 'done' || !WRITING_TOOLS.has(activity.tool) || !activity.files?.length) continue;
		for (const raw of activity.files) {
			const path = normalizeToolFilePath(cwd, raw);
			if (!path) continue;
			const key = activity.runId ?? null;
			let bucket = files.get(key);
			if (!bucket) files.set(key, bucket = new Set());
			bucket.add(path);
		}
	}
	const result = new Map<string | null, UiFileChange[]>();
	for (const [runId, bucket] of files) {
		result.set(runId, [...bucket]
			.sort((a, b) => a.localeCompare(b))
			.map((path): UiFileChange => ({ path, kind: 'modified' })));
	}
	return result;
}

/**
 * Layer the transcript fallback under the tracker's turns. Tracker items win
 * per path; fallback paths the tracker never recorded join that run's list, and
 * runs with no tracker bucket at all become new turns appended in call order.
 */
export function mergeTurnFileChanges(tracked: readonly UiFileChangeTurn[], fallback: ReadonlyMap<string | null, UiFileChange[]>): UiFileChangeTurn[] {
	const merged = tracked.map(turn => ({ runId: turn.runId, items: [...turn.items] }));
	const byRun = new Map(merged.map(turn => [turn.runId ?? '', turn]));
	for (const [runId, items] of fallback) {
		const turn = byRun.get(runId ?? '');
		if (turn) {
			const known = new Set(turn.items.map(item => item.path));
			turn.items.push(...items.filter(item => !known.has(item.path)));
			// Keep the merged per-turn list path-sorted (tracker items arrive sorted).
			turn.items.sort((a, b) => a.path.localeCompare(b.path));
			continue;
		}
		if (!items.length) continue;
		const created = { runId, items: [...items] };
		merged.push(created);
		byRun.set(runId ?? '', created);
	}
	return merged;
}

/** Session-level union across turns: first record per path wins (tracker turns
 * lead, so recorded details outrank fallback approximations), sorted by path. */
export function unionFileChanges(turns: readonly UiFileChangeTurn[]): UiFileChange[] {
	const byPath = new Map<string, UiFileChange>();
	for (const turn of turns) for (const item of turn.items) if (!byPath.has(item.path)) byPath.set(item.path, item);
	return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Session-scope change list for the capsule and the conversation review. The
 * tracker's session records are the net first-baseline → final diff (the same
 * source as the conversation-scope diff body), so they are taken as-is. A path
 * the tracker saw in some turn but that is absent from its session records
 * netted out to no change (created then deleted, edited then reverted) and is
 * not counted. Only paths the tracker never saw at all — fallback-only paths
 * from pre-tracker turns — join from the merged turns' union, with the
 * union's first-seen approximation.
 */
export function sessionFileChanges(tracked: readonly UiFileChangeTurn[], session: readonly UiFileChange[], merged: readonly UiFileChangeTurn[]): UiFileChange[] {
	const known = new Set(session.map(item => item.path));
	for (const turn of tracked) for (const item of turn.items) known.add(item.path);
	const fallbackOnly = unionFileChanges(merged).filter(item => !known.has(item.path));
	return [...session, ...fallbackOnly].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Review-dialog degradation: paths the tracker has no diff for (fallback items)
 * still get an entry, shown as "recorded but unavailable" instead of "no text
 * differences". The loaded map itself is never mutated.
 */
export function withUnavailableDiffs(diffs: ReadonlyMap<string, UiFileDiff>, items: readonly UiFileChange[]): Map<string, UiFileDiff> {
	const merged = new Map(diffs);
	for (const item of items) if (!merged.has(item.path)) merged.set(item.path, { path: item.path, diff: null, preview: 'unavailable' });
	return merged;
}
