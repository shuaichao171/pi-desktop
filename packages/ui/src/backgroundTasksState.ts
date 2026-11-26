import type { UiBackgroundTask, UiBackgroundTaskStatus } from '@pidesktop/shared';

export interface BackgroundTaskVisibilityState {
	readonly trackedIds: ReadonlySet<string>;
	readonly dismissedIds: ReadonlySet<string>;
	readonly visible: readonly UiBackgroundTask[];
}

export const EMPTY_BACKGROUND_TASK_VISIBILITY: BackgroundTaskVisibilityState = {
	trackedIds: new Set(),
	dismissedIds: new Set(),
	visible: [],
};

/** Normalize arbitrary whitespace/newlines into a compact single-line label. */
function singleLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/** Human-readable task name shown in the conversation bar: note first, else first non-empty command line. */
export function backgroundTaskDisplayName(task: Pick<UiBackgroundTask, 'taskId' | 'command' | 'note'>): string {
	const note = typeof task.note === 'string' ? singleLine(task.note) : '';
	if (note) return note;
	const firstLine = (task.command ?? '')
		.split(/\r?\n/)
		.map(singleLine)
		.find((line) => line.length > 0);
	return firstLine || task.taskId;
}

/** Secondary command preview shown beneath/beside the task name when a separate `note` is present. */
export function backgroundTaskCommandPreview(task: Pick<UiBackgroundTask, 'command' | 'note'>): string | null {
	const note = typeof task.note === 'string' ? singleLine(task.note) : '';
	if (!note) return null;
	const command = singleLine(task.command ?? '');
	if (!command || command === note) return null;
	return command;
}

/** Elapsed or total duration label matching FleetCard's compact tabular format. */
export function formatBackgroundTaskDuration(startedAt: number, endedAt: number | undefined, now: number): string {
	const end = endedAt ?? now;
	const seconds = Math.max(0, Math.floor((end - startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
	return `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`;
}

export type BackgroundTaskStatusLabel =
	| { kind: 'running' }
	| { kind: 'completed' }
	| { kind: 'completedOffline' }
	| { kind: 'failedSignal'; signal: string }
	| { kind: 'failedExitCode'; exitCode: number }
	| { kind: 'failed' };

/** Classify how a task's current status should be presented to the user. */
export function classifyBackgroundTaskStatus(task: Pick<UiBackgroundTask, 'status' | 'exitCode' | 'signal' | 'exitedOffline'>): BackgroundTaskStatusLabel {
	if (task.status === 'running') return { kind: 'running' };
	if (task.status === 'completed') return task.exitedOffline ? { kind: 'completedOffline' } : { kind: 'completed' };
	if (task.signal) return { kind: 'failedSignal', signal: task.signal };
	if (typeof task.exitCode === 'number') return { kind: 'failedExitCode', exitCode: task.exitCode };
	return { kind: 'failed' };
}

/**
 * Reconcile which tasks of the active session belong in the conversation bar.
 *
 * - Every `running` task is always visible and remembered in `trackedIds`.
 * - A task that finished while away and is still undelivered (`!delivered`) enters
 *   `trackedIds` so the user sees its pending/arriving result.
 * - Any task we observed while running (or undelivered) stays visible after it
 *   settles and is delivered, so the indicator visibly updates on completion until
 *   dismissed or auto-cleared.
 * - Historical tasks that were already settled and delivered before the user opened
 *   this session never appear.
 */
export function reconcileVisibleBackgroundTasks(
	previous: Pick<BackgroundTaskVisibilityState, 'trackedIds' | 'dismissedIds'>,
	tasks: readonly UiBackgroundTask[],
): BackgroundTaskVisibilityState {
	const presentIds = new Set(tasks.map((task) => task.taskId));
	const trackedIds = new Set<string>();
	const dismissedIds = new Set<string>();

	for (const id of previous.trackedIds) {
		if (presentIds.has(id)) trackedIds.add(id);
	}
	for (const id of previous.dismissedIds) {
		if (presentIds.has(id)) dismissedIds.add(id);
	}

	for (const task of tasks) {
		if (task.status === 'running') {
			trackedIds.add(task.taskId);
			dismissedIds.delete(task.taskId);
		} else if (!task.delivered && !dismissedIds.has(task.taskId)) {
			trackedIds.add(task.taskId);
		}
	}

	const visible = tasks.filter(
		(task) => (task.status === 'running' || trackedIds.has(task.taskId)) && !dismissedIds.has(task.taskId),
	);
	return { trackedIds, dismissedIds, visible };
}

/** Dismiss all currently settled tasks while keeping any running tasks visible. */
export function dismissSettledBackgroundTasks(
	previous: Pick<BackgroundTaskVisibilityState, 'trackedIds' | 'dismissedIds'>,
	tasks: readonly UiBackgroundTask[],
): BackgroundTaskVisibilityState {
	const nextDismissed = new Set(previous.dismissedIds);
	for (const task of tasks) {
		if (task.status !== 'running') nextDismissed.add(task.taskId);
	}
	return reconcileVisibleBackgroundTasks({ trackedIds: previous.trackedIds, dismissedIds: nextDismissed }, tasks);
}

export interface BackgroundTasksSummary {
	running: number;
	completed: number;
	failed: number;
	overallStatus: UiBackgroundTaskStatus;
	/** True when every visible task is settled and already delivered back into the conversation. */
	allSettledAndDelivered: boolean;
}

export function summarizeBackgroundTasks(visible: readonly UiBackgroundTask[]): BackgroundTasksSummary {
	let running = 0;
	let completed = 0;
	let failed = 0;
	let allDelivered = visible.length > 0;
	for (const task of visible) {
		if (task.status === 'running') {
			running += 1;
			allDelivered = false;
		} else if (task.status === 'failed') {
			failed += 1;
			if (!task.delivered) allDelivered = false;
		} else {
			completed += 1;
			if (!task.delivered) allDelivered = false;
		}
	}
	const overallStatus: UiBackgroundTaskStatus = running > 0 ? 'running' : failed > 0 ? 'failed' : 'completed';
	return { running, completed, failed, overallStatus, allSettledAndDelivered: running === 0 && allDelivered };
}

export function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
	if (left.size !== right.size) return false;
	for (const item of left) if (!right.has(item)) return false;
	return true;
}
