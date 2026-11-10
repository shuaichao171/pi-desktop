import { existsSync, rmSync } from 'node:fs';
import type { UiInterruptedRun } from '@pidesktop/shared';
import { readStateFile, writeStateFile } from './stateFiles';

/**
 * Conversations still running when the app goes away (quit mid-turn, killed, crashed).
 *
 * The file always mirrors "what is running right now", so a hard kill leaves the last
 * running set behind just like a clean quit does. A clean quit freezes the record before
 * services shut down: aborting turns during disposal must not erase what was running.
 * On the next launch the main window takes the list once and continues each conversation.
 */
interface InterruptedRunsFile { version: 1; runs: UiInterruptedRun[] }

const isRun = (value: unknown): value is UiInterruptedRun => {
	if (!value || typeof value !== 'object') return false;
	const run = value as Partial<UiInterruptedRun>;
	return typeof run.cwd === 'string' && run.cwd.length > 0 && typeof run.path === 'string' && run.path.length > 0;
};
const isFile = (value: unknown): value is InterruptedRunsFile => Boolean(value && typeof value === 'object'
	&& (value as Partial<InterruptedRunsFile>).version === 1 && Array.isArray((value as Partial<InterruptedRunsFile>).runs)
	&& (value as InterruptedRunsFile).runs.every(isRun));

export class InterruptedRunTracker {
	private readonly path: string;
	/** Left over from the previous launch, until the main window takes it. */
	private stash: UiInterruptedRun[];
	/** source (main agent / pai window / split pane) → session path → run. */
	private readonly running = new Map<string, Map<string, UiInterruptedRun>>();
	private frozen = false;
	private lastWritten = '';

	constructor(path: string) {
		this.path = path;
		let stored: InterruptedRunsFile;
		try { stored = readStateFile(path, () => ({ version: 1, runs: [] }), isFile); }
		catch { stored = { version: 1, runs: [] }; }
		this.stash = dedupe(stored.runs);
		this.lastWritten = JSON.stringify(this.stash);
	}

	/** Mark one conversation of `source` as running or settled. */
	update(source: string, run: { cwd: string; path: string | null | undefined; running: boolean }): void {
		if (this.frozen || !run.path || !run.cwd) return;
		let runs = this.running.get(source);
		if (run.running) {
			if (!runs) { runs = new Map(); this.running.set(source, runs); }
			runs.set(run.path, { cwd: run.cwd, path: run.path });
		} else if (runs?.delete(run.path) && runs.size === 0) this.running.delete(source);
		this.persist();
	}

	/** A window the user closed on purpose stops counting, whatever its agent reported last. */
	clearSource(source: string): void {
		if (this.frozen || !this.running.delete(source)) return;
		this.persist();
	}

	/** Called as shutdown begins: later aborts and disposals must not rewrite the record. */
	freeze(): void {
		if (this.frozen) return;
		this.persist();
		this.frozen = true;
	}

	/** Hand the previous launch's runs to the main window exactly once. */
	take(): UiInterruptedRun[] {
		const runs = this.stash.filter((run) => existsSync(run.path));
		this.stash = [];
		this.persist();
		return runs;
	}

	snapshot(): UiInterruptedRun[] {
		return dedupe([...this.stash, ...[...this.running.values()].flatMap((runs) => [...runs.values()])]);
	}

	private persist(): void {
		if (this.frozen) return;
		const runs = this.snapshot();
		const serialized = JSON.stringify(runs);
		if (serialized === this.lastWritten) return;
		try {
			if (runs.length) writeStateFile(this.path, { version: 1, runs } satisfies InterruptedRunsFile);
			else rmSync(this.path, { force: true });
			this.lastWritten = serialized;
		} catch (error) {
			console.error('Failed to record running conversations:', error);
		}
	}
}

function dedupe(runs: unknown): UiInterruptedRun[] {
	const byPath = new Map<string, UiInterruptedRun>();
	if (!Array.isArray(runs)) return [];
	for (const run of runs as UiInterruptedRun[]) if (run && typeof run.cwd === 'string' && typeof run.path === 'string' && run.path && !byPath.has(run.path)) byPath.set(run.path, { cwd: run.cwd, path: run.path });
	return [...byPath.values()];
}

/** Pi's runtime phases that mean a turn was still in flight. */
export function isRunningPhase(phase: string): boolean {
	return phase === 'running' || phase === 'waiting-input' || phase === 'waiting-approval';
}
