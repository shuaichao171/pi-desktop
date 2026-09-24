import { commitSessionNavigation, createSessionNavigationHistory, planSessionNavigation, reconcileSessionNavigation, recordSessionVisit, sameSessionNavigationTarget, type SessionNavigationHistory, type SessionNavigationTarget } from './sessionNavigationHistory.ts';

export interface SessionNavigationSource {
	owner: unknown;
	intent: number;
	ready: boolean;
	target: SessionNavigationTarget | null;
}

export interface SessionNavigationAdapter {
	read(): SessionNavigationSource;
	switchWorkspace(cwd: string): Promise<void>;
	switchSession(path: string): Promise<void>;
	message(kind: 'unavailable' | 'incomplete'): string;
}

export interface SessionNavigationSnapshot {
	history: SessionNavigationHistory;
	navigating: boolean;
	error: string | null;
}

interface NavigationOperation {
	owner: unknown;
	intent: number;
	origin: SessionNavigationTarget;
}

class NavigationSuperseded extends Error {}

/** A navigation transaction suppresses intermediate workspace restores, verifies
 * the actual final session, and relinquishes control to newer user navigation. */
export class SessionNavigationController {
	private readonly adapter: SessionNavigationAdapter;
	private readonly listeners = new Set<() => void>();
	private owner: unknown;
	private observedIntent: number;
	private operation: NavigationOperation | null = null;
	private recordingTimer: ReturnType<typeof setTimeout> | null = null;
	private snapshot: SessionNavigationSnapshot = { history: createSessionNavigationHistory(), navigating: false, error: null };

	constructor(adapter: SessionNavigationAdapter) {
		this.adapter = adapter;
		this.owner = adapter.read().owner;
		this.observedIntent = adapter.read().intent;
	}

	getSnapshot = (): SessionNavigationSnapshot => this.snapshot;
	subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
	clearError = (): void => { if (this.snapshot.error) this.publish({ ...this.snapshot, error: null }); };
	goBack = (): Promise<void> => this.navigate(-1);
	goForward = (): Promise<void> => this.navigate(1);

	private publish(snapshot: SessionNavigationSnapshot): void {
		this.snapshot = snapshot;
		for (const listener of this.listeners) listener();
	}

	/** Called by the store subscription, including once when the hook mounts. */
	observe = (): void => {
		const source = this.adapter.read();
		if (source.owner !== this.owner) {
			this.owner = source.owner;
			this.operation = null;
			this.publish({ history: createSessionNavigationHistory(), navigating: false, error: null });
		}
		if (this.operation && source.intent !== this.operation.intent) {
			this.operation = null;
			this.publish({ ...this.snapshot, navigating: false, error: null });
		}
		if (source.intent !== this.observedIntent) {
			this.observedIntent = source.intent;
			if (!this.operation) this.clearError();
		}
		if (this.operation || !source.owner || !source.ready || !source.target || this.recordingTimer !== null) return;
		// Let the caller continue an awaited workspace→session selection before
		// recording the workspace's automatically restored intermediate session.
		this.recordingTimer = setTimeout(() => {
			this.recordingTimer = null;
			this.recordCurrentVisit();
		}, 0);
	};

	private recordCurrentVisit(): void {
		const source = this.adapter.read();
		if (this.operation || !source.owner || source.owner !== this.owner || !source.ready || !source.target) return;
		const history = recordSessionVisit(this.snapshot.history, source.target);
		if (history !== this.snapshot.history) this.publish({ history, navigating: false, error: null });
	}

	/** Invalidates pending work without touching the backend or stealing focus. */
	cancel = (): void => {
		if (this.recordingTimer !== null) clearTimeout(this.recordingTimer);
		this.recordingTimer = null;
		this.operation = null;
		if (this.snapshot.navigating) this.publish({ ...this.snapshot, navigating: false });
	};

	private current(operation: NavigationOperation): boolean {
		const source = this.adapter.read();
		return this.operation === operation && source.owner === operation.owner && source.intent === operation.intent;
	}

	private ensureCurrent(operation: NavigationOperation): void {
		if (!this.current(operation)) throw new NavigationSuperseded();
	}

	private async step(operation: NavigationOperation, action: () => Promise<void>): Promise<void> {
		this.ensureCurrent(operation);
		// Store navigation actions increment their intent synchronously before IPC.
		operation.intent += 1;
		const pending = action();
		if (this.adapter.read().intent === operation.intent - 1) operation.intent -= 1;
		await pending;
		this.ensureCurrent(operation);
	}

	private async visit(operation: NavigationOperation, target: SessionNavigationTarget): Promise<SessionNavigationTarget> {
		this.ensureCurrent(operation);
		if (this.adapter.read().target?.cwd !== target.cwd) {
			await this.step(operation, () => this.adapter.switchWorkspace(target.cwd));
		}
		let source = this.adapter.read();
		if (source.target?.cwd !== target.cwd) throw new Error(this.adapter.message('incomplete'));
		if (!sameSessionNavigationTarget(source.target, target)) {
			if (!target.sessionPath) throw new Error(this.adapter.message('unavailable'));
			await this.step(operation, () => this.adapter.switchSession(target.sessionPath!));
		}
		source = this.adapter.read();
		if (!source.ready || !sameSessionNavigationTarget(source.target, target)) throw new Error(this.adapter.message('incomplete'));
		return source.target!;
	}

	private async navigate(direction: -1 | 1): Promise<void> {
		this.observe();
		// An immediate shortcut must include the just-completed manual visit even
		// before its deferred recording runs.
		this.recordCurrentVisit();
		const source = this.adapter.read();
		const plan = planSessionNavigation(this.snapshot.history, direction);
		if (this.operation || !source.owner || !source.ready || !source.target || !plan) return;
		const operation: NavigationOperation = { owner: source.owner, intent: source.intent, origin: source.target };
		this.operation = operation;
		this.publish({ ...this.snapshot, navigating: true, error: null });
		try {
			const actual = await this.visit(operation, plan.target);
			this.ensureCurrent(operation);
			this.operation = null;
			this.publish({ history: commitSessionNavigation(this.snapshot.history, plan.cursor, actual), navigating: false, error: null });
		} catch (error) {
			if (!this.current(operation) || error instanceof NavigationSuperseded) return;
			let history = this.snapshot.history;
			if (!sameSessionNavigationTarget(this.adapter.read().target, operation.origin)) {
				try { await this.visit(operation, operation.origin); }
				catch {
					if (!this.current(operation)) return;
					const actual = this.adapter.read();
					if (actual.ready && actual.target) history = reconcileSessionNavigation(history, actual.target);
				}
			}
			if (!this.current(operation)) return;
			this.operation = null;
			this.publish({ history, navigating: false, error: error instanceof Error ? error.message : String(error) });
		}
	}
}
