import type { UiInterruptedRun } from '@pidesktop/shared';

/** Sent verbatim to every conversation the previous app exit interrupted. */
export const INTERRUPTED_RUN_RESUME_PROMPT = 'The app was quit while you were working. Please continue from where you left off.';

export interface ResumeDependencies {
	/** Session the window opened on startup; it ends focused again afterwards. */
	current(): { cwd: string | null; path: string | null };
	/** Opens a conversation in the main window; false when navigation was refused or superseded. */
	select(cwd: string, path: string): Promise<boolean>;
	send(text: string): Promise<void>;
}

export interface ResumeResult { resumed: UiInterruptedRun[]; failed: { run: UiInterruptedRun; error: string }[] }

/**
 * Continue each interrupted conversation in turn. Switching away leaves a started turn
 * running in its background runtime, so one window can restart several of them. The
 * conversation the window started on goes last (or is reopened) so the user stays where
 * they were. One failure never blocks the others.
 */
export async function resumeInterruptedRuns(runs: readonly UiInterruptedRun[], deps: ResumeDependencies): Promise<ResumeResult> {
	const result: ResumeResult = { resumed: [], failed: [] };
	if (!runs.length) return result;
	const start = deps.current();
	const ordered = [...runs.filter((run) => run.path !== start.path), ...runs.filter((run) => run.path === start.path)];
	for (const run of ordered) {
		try {
			const here = deps.current();
			if (here.path !== run.path || here.cwd !== run.cwd) {
				if (!await deps.select(run.cwd, run.path)) throw new Error('navigation refused');
			}
			await deps.send(INTERRUPTED_RUN_RESUME_PROMPT);
			result.resumed.push(run);
		} catch (error) {
			result.failed.push({ run, error: error instanceof Error ? error.message : String(error) });
		}
	}
	const end = deps.current();
	if (start.cwd && start.path && (end.path !== start.path || end.cwd !== start.cwd)) {
		await deps.select(start.cwd, start.path).catch(() => false);
	}
	return result;
}
