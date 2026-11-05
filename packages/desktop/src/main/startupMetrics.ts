/**
 * Cold-start phase marks (审计 P2：冷启动打点). The main process records a
 * monotonic timeline — module load, app ready, splash shown, IPC registered,
 * workspace resolved, window created, renderer loaded / first paint, and the
 * splash→main swap — from a single anchor so the phases are comparable.
 *
 * Output is deliberately low-noise: diagnostics (the app's structured
 * jsonl channel) always receives one event per phase, while the human-readable
 * one-line summary is only logged when the caller enables it (dev builds or
 * PI_STARTUP_LOG=1). The module is pure — clocks, sinks and flags are
 * injected — so tests drive it with fake timers.
 */
export type StartupPhase =
	| 'main-start'       // the main bundle was evaluated (≈ process start)
	| 'app-ready'        // Electron finished initializing
	| 'splash-created'   // the boot window exists
	| 'splash-shown'     // the boot window is visible and bootstrap is scheduled
	| 'ipc-ready'        // the heavy host bridge import + IPC registration finished
	| 'window-created'   // the main window exists and its renderer load started
	| 'workspace-ready'  // the startup workspace resolved (parallel branch)
	| 'renderer-loaded'  // the renderer finished loading the document
	| 'ready-to-show'    // the hidden renderer painted its first frame
	| 'renderer-ready'   // React acknowledged a committed conversation
	| 'first-frame';     // the main window was revealed (the splash swap)

export interface StartupMark {
	phase: StartupPhase;
	/** Milliseconds since the process started (performance.now()). */
	atMs: number;
	/** Milliseconds since the previous recorded phase. */
	deltaMs: number;
}

export interface StartupPhaseRecord extends StartupMark {
	outcome: 'success' | 'failure';
}

export interface StartupMetricsOptions {
	now(): number;
	/** Human-readable summary logging; diagnostics recording is independent of it. */
	enabled?: boolean;
	logger?: (...args: unknown[]) => void;
	/** Structured sink (wired to diagnostics in index.ts). Called once per phase at completion. */
	record?: (record: StartupPhaseRecord) => void;
}

const SUMMARY_PREFIX = '[pi-startup]';

export function formatStartupSummary(marks: readonly StartupMark[], outcome: 'success' | 'failure'): string {
	const phases = marks.map((mark) => `${mark.phase}=${Math.round(mark.atMs)}`).join(' ');
	const total = marks.length > 0 ? Math.round(marks[marks.length - 1].atMs) : 0;
	return outcome === 'success'
		? `${SUMMARY_PREFIX} cold start ${total}ms ${phases}`
		: `${SUMMARY_PREFIX} cold start failed after ${total}ms ${phases}`;
}

export interface StartupMetrics {
	/** Record a phase; only the first occurrence counts, and only before completion. */
	mark(phase: StartupPhase): void;
	/** Complete the timeline successfully (the first frame was revealed). */
	finish(): void;
	/** Complete the timeline with a startup failure (the boot error page). */
	abort(): void;
	/** Marks recorded so far, in order. */
	snapshot(): StartupMark[];
}

export function createStartupMetrics(options: StartupMetricsOptions): StartupMetrics {
	const enabled = options.enabled ?? false;
	const logger = options.logger ?? console.log;
	const marks: StartupMark[] = [];
	let outcome: 'success' | 'failure' | null = null;

	const publish = (): void => {
		if (outcome === null) return;
		for (const mark of marks) options.record?.({ ...mark, outcome });
		if (enabled) logger(formatStartupSummary(marks, outcome));
	};

	return {
		mark(phase) {
			if (outcome !== null || marks.some((mark) => mark.phase === phase)) return;
			const atMs = options.now();
			marks.push({ phase, atMs, deltaMs: marks.length === 0 ? 0 : atMs - marks[marks.length - 1].atMs });
		},
		finish() {
			if (outcome !== null) return;
			outcome = 'success';
			publish();
		},
		abort() {
			if (outcome !== null) return;
			outcome = 'failure';
			publish();
		},
		snapshot() {
			return marks.map((mark) => ({ ...mark }));
		},
	};
}
