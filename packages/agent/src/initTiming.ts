import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

/**
 * Phase timing of one conversation runtime initialization (new conversation,
 * cold switch, workspace activation). Durations only: no paths, names or
 * payloads, so the record is safe for the diagnostics log.
 */
export interface UiInitTiming {
	kind: 'fresh' | 'restore';
	outcome: 'success' | 'failure';
	totalMs: number;
	/** Longest stretch the host event loop could not run timers while initializing. */
	maxStallMs: number;
	phases: Record<string, number>;
}

/** Phase names reported by initSession and the runtime factory, in order. */
export const INIT_TIMING_PHASES = ['teardown', 'open', 'trust', 'services', 'shellTools', 'session', 'runtime', 'bind', 'ready'] as const;
export type InitTimingPhase = typeof INIT_TIMING_PHASES[number];

const STALL_PROBE_MS = 10;

export class InitPhaseTimer {
	private readonly started = performance.now();
	private last = this.started;
	private readonly phases: Record<string, number> = {};
	private maxStall = 0;
	private expected = performance.now() + STALL_PROBE_MS;
	private probe: ReturnType<typeof setInterval> | null;
	private readonly kind: UiInitTiming['kind'];

	constructor(kind: UiInitTiming['kind']) {
		this.kind = kind;
		this.probe = setInterval(() => {
			const now = performance.now();
			this.maxStall = Math.max(this.maxStall, now - this.expected);
			this.expected = now + STALL_PROBE_MS;
		}, STALL_PROBE_MS);
		this.probe.unref?.();
	}

	/** Closes the current phase: the time since the previous mark is attributed to `phase`. */
	mark(phase: InitTimingPhase): void {
		const now = performance.now();
		this.phases[phase] = round((this.phases[phase] ?? 0) + now - this.last);
		this.last = now;
	}

	finish(outcome: UiInitTiming['outcome']): UiInitTiming {
		if (this.probe) { clearInterval(this.probe); this.probe = null; }
		const now = performance.now();
		// A stall still in progress when init returns counts too.
		this.maxStall = Math.max(this.maxStall, now - this.expected);
		return { kind: this.kind, outcome, totalMs: round(now - this.started), maxStallMs: round(Math.max(0, this.maxStall)), phases: { ...this.phases } };
	}
}

const round = (value: number): number => Math.round(value * 10) / 10;

/** Lets the SDK-invoked runtime factory report into the initialization that called it. */
export const initTimingContext = new AsyncLocalStorage<InitPhaseTimer>();

export function markInitPhase(phase: InitTimingPhase): void {
	initTimingContext.getStore()?.mark(phase);
}
