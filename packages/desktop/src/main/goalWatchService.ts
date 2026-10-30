import { type FSWatcher, watch } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { UiGoalLedgerEvent, UiGoalRecord, UiGoalSnapshot, UiGoalTask } from '@pidesktop/shared';

/**
 * Read-only bridge to pi-goal-x durable state.
 *
 * The plugin persists goals as `.pi/goals/active_goal_*.md` files whose bodies
 * start with a full JSON GoalRecord (followed by a human-readable summary) and
 * appends lifecycle events to `.pi/goals/goal_events.jsonl`. Watching those
 * files keeps the desktop decoupled from plugin internals — when the plugin is
 * not installed the directory simply does not exist and every snapshot
 * resolves to `available:false`. Nothing in this service may throw to callers;
 * all file errors collapse into empty snapshots.
 *
 * The plugin writes files atomically (temp file + rename), so directory
 * watchers see rename events; watchers are re-attached lazily because any
 * level of `.pi/goals` can appear or disappear at runtime.
 */

const GOALS_DIRECTORY = '.pi/goals';
const PI_DIRECTORY = '.pi';
const ACTIVE_FILE_PATTERN = /^active_goal_.+\.md$/;
const LEDGER_FILE = 'goal_events.jsonl';
/** Goal files with a JSON prefix beyond this size are pathological; never read further. */
const MAX_GOAL_FILE_BYTES = 512 * 1024;
const LEDGER_TAIL_BYTES = 64 * 1024;
const MAX_LEDGER_EVENTS = 30;
const RESCAN_DEBOUNCE_MS = 200;

const GOAL_STATUSES = new Set(['active', 'paused', 'blocked', 'budget_limited', 'complete']);
const TASK_STATUSES = new Set(['pending', 'complete', 'skipped']);

export interface GoalWatchOptions {
	/** Fired (debounced, change-detected) after a workspace's goal files change. */
	onChanged(cwd: string): void;
	onError?(error: unknown): void;
}

interface WorkspaceWatch {
	cwdWatcher?: FSWatcher;
	piWatcher?: FSWatcher;
	goalsWatcher?: FSWatcher;
	rescanTimer?: NodeJS.Timeout;
	lastSignature?: string;
	/** Serializes attach runs: concurrent invocations must not double-watch a directory. */
	attachChain?: Promise<void>;
}

export interface GoalWatchService {
	snapshot(cwd: string): Promise<UiGoalSnapshot>;
	dispose(): void;
}

interface RawGoalTask {
	id?: unknown;
	title?: unknown;
	status?: unknown;
	evidence?: unknown;
	subtasks?: unknown;
}

/** String-aware brace matching: index of the `}` closing the first top-level `{`, or -1. */
function findJsonPrefixEnd(content: string): number {
	let depth = 0;
	let inString = false;
	let escaped = false;
	let started = false;
	for (let index = 0; index < content.length; index++) {
		const char = content[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === '\\') escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') { inString = true; continue; }
		if (char === '{') { depth++; started = true; continue; }
		if (char === '}') {
			depth--;
			if (started && depth === 0) return index;
		}
	}
	return -1;
}

function finiteNonNegative(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function projectTask(raw: unknown): { task: UiGoalTask; subtasks: RawGoalTask[] } | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const source = raw as RawGoalTask;
	const id = typeof source.id === 'string' ? source.id : '';
	const title = typeof source.title === 'string' ? source.title : '';
	if (!id || !title) return null;
	const status = typeof source.status === 'string' && TASK_STATUSES.has(source.status) ? source.status as UiGoalTask['status'] : 'pending';
	const subtasks = Array.isArray(source.subtasks) ? (source.subtasks.filter((entry) => typeof entry === 'object' && entry !== null) as RawGoalTask[]) : [];
	return { task: { id, title, status, evidence: optionalString(source.evidence) }, subtasks };
}

function countTree(tasks: RawGoalTask[], counts: { pending: number; complete: number; skipped: number }): void {
	for (const raw of tasks) {
		const projected = projectTask(raw);
		if (!projected) continue;
		if (projected.task.status === 'complete') counts.complete++;
		else if (projected.task.status === 'skipped') counts.skipped++;
		else counts.pending++;
		countTree(projected.subtasks, counts);
	}
}

/** Defensive projection of a parsed JSON prefix into the renderer payload. Unknown shapes return null. */
function projectGoalRecord(raw: unknown): UiGoalRecord | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const source = raw as Record<string, unknown>;
	const id = typeof source.id === 'string' && source.id.trim() ? source.id : '';
	const objective = typeof source.objective === 'string' ? source.objective.trim() : '';
	if (!id || !objective) return null;
	const usage = (typeof source.usage === 'object' && source.usage !== null ? source.usage : {}) as Record<string, unknown>;
	const rawTasks = (typeof source.taskList === 'object' && source.taskList !== null
		? (source.taskList as Record<string, unknown>).tasks : undefined) as unknown;
	const taskList = Array.isArray(rawTasks) ? (rawTasks.filter((entry) => typeof entry === 'object' && entry !== null) as RawGoalTask[]) : [];
	const counts = { pending: 0, complete: 0, skipped: 0 };
	countTree(taskList, counts);
	const tasks: UiGoalTask[] = [];
	for (const rawTask of taskList) {
		const projected = projectTask(rawTask);
		if (projected) tasks.push(projected.task);
	}
	return {
		id,
		objective,
		status: typeof source.status === 'string' && GOAL_STATUSES.has(source.status) ? source.status as UiGoalRecord['status'] : 'active',
		autoContinue: source.autoContinue === true,
		sisyphus: source.sisyphus === true,
		createdAt: typeof source.createdAt === 'string' ? source.createdAt : '',
		updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : '',
		tokensUsed: finiteNonNegative(usage.tokensUsed) ?? 0,
		activeSeconds: finiteNonNegative(usage.activeSeconds) ?? 0,
		tokenBudget: finiteNonNegative(source.tokenBudget),
		currentTaskId: optionalString(source.currentTaskId),
		pauseReason: optionalString(source.pauseReason),
		pauseSuggestedAction: optionalString(source.pauseSuggestedAction),
		tasks,
		pendingTasks: counts.pending,
		completedTasks: counts.complete,
		skippedTasks: counts.skipped,
	};
}

async function readGoalFile(path: string): Promise<UiGoalRecord | null> {
	try {
		const handle = await open(path, 'r');
		try {
			const { size } = await handle.stat();
			const length = Math.min(size, MAX_GOAL_FILE_BYTES);
			const buffer = Buffer.alloc(length);
			await handle.read(buffer, 0, length, 0);
			const content = buffer.toString('utf8');
			const start = content.indexOf('{');
			if (start < 0) return null;
			const end = findJsonPrefixEnd(content.slice(start));
			if (end < 0) return null;
			return projectGoalRecord(JSON.parse(content.slice(start, start + end + 1)));
		} finally {
			await handle.close();
		}
	} catch {
		return null; // torn atomic write, foreign file, or unreadable — ignore
	}
}

async function readLedgerTail(path: string): Promise<UiGoalLedgerEvent[]> {
	try {
		const handle = await open(path, 'r');
		try {
			const { size } = await handle.stat();
			if (size === 0) return [];
			const length = Math.min(size, LEDGER_TAIL_BYTES);
			const buffer = Buffer.alloc(length);
			await handle.read(buffer, 0, length, size - length);
			let text = buffer.toString('utf8');
			if (length < size) {
				const firstNewline = text.indexOf('\n');
				text = firstNewline === -1 ? '' : text.slice(firstNewline + 1); // drop the torn leading line
			}
			const events: UiGoalLedgerEvent[] = [];
			for (const line of text.split('\n')) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					const parsed: unknown = JSON.parse(trimmed);
					if (typeof parsed !== 'object' || parsed === null) continue;
					const record = parsed as Record<string, unknown>;
					if (typeof record.type !== 'string' || !record.type) continue;
					events.push({ type: record.type, goalId: optionalString(record.goalId), at: optionalString(record.at) });
				} catch {
					// torn trailing line mid-append or a foreign line — skip
				}
			}
			return events.slice(-MAX_LEDGER_EVENTS).reverse();
		} finally {
			await handle.close();
		}
	} catch {
		return [];
	}
}

async function directoryExists(path: string): Promise<boolean> {
	try { return (await stat(path)).isDirectory(); } catch { return false; }
}

export function createGoalWatchService(options: GoalWatchOptions): GoalWatchService {
	const workspaces = new Map<string, WorkspaceWatch>();
	let disposed = false;

	function scheduleRescan(entry: WorkspaceWatch, cwd: string): void {
		if (entry.rescanTimer) clearTimeout(entry.rescanTimer);
		entry.rescanTimer = setTimeout(() => {
			entry.rescanTimer = undefined;
			void rescanAndNotify(cwd);
		}, RESCAN_DEBOUNCE_MS);
	}

	/** Attach runs are serialized per workspace: watcher events and snapshot() calls
	 * arrive concurrently, and two interleaved runs could both pass the presence
	 * check and double-watch (and then leak) one directory. */
	function queueAttachWatchers(entry: WorkspaceWatch, cwd: string): void {
		if (disposed) return;
		const run = entry.attachChain ?? Promise.resolve();
		entry.attachChain = run.then(() => attachWatchers(entry, cwd)).catch((error) => options.onError?.(error));
	}

	function attachWatcher(entry: WorkspaceWatch, cwd: string, directory: string, key: 'cwdWatcher' | 'piWatcher' | 'goalsWatcher', relevantName: string | null): void {
		// Presence is the liveness check: the close/error handlers below clear the slot.
		if (entry[key]) return;
		let watcher: FSWatcher;
		try {
			watcher = watch(directory, { persistent: false }, (_eventType, filename) => {
				// Watchers one level up only react to the relevant child so unrelated
				// workspace churn never triggers a rescan.
				if (relevantName !== null && basename(String(filename ?? '')) !== relevantName) return;
				queueAttachWatchers(entry, cwd);
				scheduleRescan(entry, cwd);
			});
		} catch {
			return; // directory vanished between stat and watch — retried on the next snapshot
		}
		watcher.on('error', (error) => {
			try { watcher.close(); } catch { /* already closed */ }
			if (entry[key] === watcher) entry[key] = undefined;
			// The watcher died while the directory may still exist (e.g. a transient
			// EPERM); try to reattach — a vanished directory simply fails to watch.
			queueAttachWatchers(entry, cwd);
			options.onError?.(error);
		});
		watcher.on('close', () => { if (entry[key] === watcher) entry[key] = undefined; });
		entry[key] = watcher;
	}

	/** Idempotently watch every existing level: <cwd>, <cwd>/.pi, <cwd>/.pi/goals. */
	async function attachWatchers(entry: WorkspaceWatch, cwd: string): Promise<void> {
		const [cwdExists, piExists, goalsExists] = await Promise.all([
			directoryExists(cwd),
			directoryExists(join(cwd, PI_DIRECTORY)),
			directoryExists(join(cwd, GOALS_DIRECTORY)),
		]);
		if (cwdExists) attachWatcher(entry, cwd, cwd, 'cwdWatcher', PI_DIRECTORY);
		if (piExists) attachWatcher(entry, cwd, join(cwd, PI_DIRECTORY), 'piWatcher', GOALS_DIRECTORY.split('/').pop()!);
		if (goalsExists) attachWatcher(entry, cwd, join(cwd, GOALS_DIRECTORY), 'goalsWatcher', null);
	}

	async function readSnapshot(cwd: string): Promise<UiGoalSnapshot> {
		const goalsDirectory = join(cwd, GOALS_DIRECTORY);
		if (!(await directoryExists(goalsDirectory))) return { cwd, available: false, goals: [], recentEvents: [] };
		let names: string[];
		try { names = await readdir(goalsDirectory); } catch { return { cwd, available: false, goals: [], recentEvents: [] }; }
		const goals: UiGoalRecord[] = [];
		for (const name of names) {
			if (!ACTIVE_FILE_PATTERN.test(name)) continue;
			const record = await readGoalFile(join(goalsDirectory, name));
			if (record) goals.push(record);
		}
		goals.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		const recentEvents = await readLedgerTail(join(goalsDirectory, LEDGER_FILE));
		return { cwd, available: true, goals, recentEvents };
	}

	async function rescanAndNotify(cwd: string): Promise<void> {
		const entry = workspaces.get(cwd);
		if (!entry) return;
		try {
			const snapshot = await readSnapshot(cwd);
			const signature = JSON.stringify([snapshot.available, snapshot.goals, snapshot.recentEvents]);
			if (signature !== entry.lastSignature) {
				entry.lastSignature = signature;
				options.onChanged(cwd);
			}
		} catch (error) {
			options.onError?.(error);
		}
	}

	return {
		async snapshot(inputCwd: string): Promise<UiGoalSnapshot> {
			const cwd = resolve(inputCwd);
			let entry = workspaces.get(cwd);
			if (!entry) {
				entry = {};
				workspaces.set(cwd, entry);
			}
			queueAttachWatchers(entry, cwd);
			return readSnapshot(cwd);
		},
		dispose(): void {
			disposed = true;
			for (const entry of workspaces.values()) {
				if (entry.rescanTimer) clearTimeout(entry.rescanTimer);
				for (const watcher of [entry.cwdWatcher, entry.piWatcher, entry.goalsWatcher]) {
					try { watcher?.close(); } catch { /* already closed */ }
				}
			}
			workspaces.clear();
		},
	};
}
