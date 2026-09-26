import { recordDiagnostic } from './diagnostics.ts';
import { app, utilityProcess, type UtilityProcess } from 'electron';
import { join } from 'node:path';
import type { ProjectTrustDecision } from '@pidesktop/agent';
import type { AgentEventEnvelope, AgentSnapshot, UiExtensionDialogRequest } from '@pidesktop/shared';
import { createAgentHostProxy, type AgentHostMethod, type AgentHostToMain, type MainToAgentHost } from './agentHostProtocol';

export interface AgentHostUiHandlers {
	requestProjectTrust(cwd: string): Promise<ProjectTrustDecision>;
	requestExtensionDialog(request: UiExtensionDialogRequest, signal: AbortSignal): Promise<string | boolean | null>;
	onHostCrash?(): void;
}

interface PendingCall {
	startedAt: number;
	method: AgentHostMethod;
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout> | null;
}

function defaultCallTimeout(method: AgentHostMethod): number {
	// Package managers own subprocesses without a public cancellation API. Keep
	// their mutation reserved until it actually settles; app shutdown remains bounded.
	if (method === 'mutatePlugin') return 0;
	if (method === 'abort') return 30_000;
	if (method === 'dispose') return 10_000;
	if (['init', 'switchWorkspace', 'switchSession', 'newSession', 'setExtensionEnabled', 'prompt', 'executeSlashCommand'].includes(method)) return 300_000;
	return 120_000;
}

export class AgentHostClient {
	private readonly ui: AgentHostUiHandlers;
	private readonly callTimeout: (method: AgentHostMethod) => number;
	private host: UtilityProcess | null = null;
	private hostExit: Promise<void> | null = null;
	private ready: Promise<void> | null = null;
	private readyResolve: (() => void) | null = null;
	private readyReject: ((error: Error) => void) | null = null;
	private startTimer: ReturnType<typeof setTimeout> | null = null;
	private nextCallId = 0;
	private readonly pending = new Map<number, PendingCall>();
	private readonly activeDialogs = new Map<number, { controller: AbortController; callId?: number }>();
	private readonly listeners = new Set<(event: AgentEventEnvelope) => void>();
	private readonly backgroundActivityListeners = new Set<(cwd: string, path: string) => void>();
	private lastSequence = 0;
	private sequenceOffset = 0;
	private currentCwd = '';
	private closing = false;
	private shutdown: Promise<void> | null = null;
	private lastAutomaticRestart = 0;

	constructor(
		ui: AgentHostUiHandlers,
		callTimeout: (method: AgentHostMethod) => number = defaultCallTimeout,
	) {
		this.ui = ui;
		this.callTimeout = callTimeout;
	}

	onEvent(listener: (event: AgentEventEnvelope) => void): void {
		this.listeners.add(listener);
	}

	onBackgroundActivity(listener: (cwd: string, path: string) => void): void {
		this.backgroundActivityListeners.add(listener);
	}

	get cwd(): string {
		return this.currentCwd;
	}

	private emit(event: AgentEventEnvelope): void {
		this.lastSequence = Math.max(this.lastSequence, event.sequence);
		if (event.event.type === 'reset' || event.event.type === 'ready') this.currentCwd = event.event.cwd;
		for (const listener of this.listeners) listener(event);
	}

	private start(): Promise<void> {
		if (this.closing) return Promise.reject(new Error('Pi agent is shutting down'));
		if (this.ready) return this.ready;
		recordDiagnostic({ stage: 'host', action: 'spawn', outcome: 'start' });
		const host = utilityProcess.fork(join(app.getAppPath(), 'out', 'main', 'agentHost.js'), [], { serviceName: 'Pi Agent' });
		this.host = host;
		let resolveExit!: () => void;
		this.hostExit = new Promise<void>((resolve) => { resolveExit = resolve; });
		// The utility process starts its event counter at zero after every crash.
		this.sequenceOffset = this.lastSequence;
		this.ready = new Promise<void>((resolve, reject) => {
			this.readyResolve = resolve;
			this.readyReject = reject;
		});
		host.on('message', (message: AgentHostToMain) => this.handleMessage(host, message));
		host.on('error', (type, location, report) => {
			console.error(`Pi agent host error (${type}) at ${location}: ${report}`);
		});
		host.on('exit', (code) => {
			recordDiagnostic({ stage: 'host', action: 'exit', outcome: 'exit', code: String(code) });
			resolveExit();
			if (this.host !== host) return;
			if (this.startTimer) clearTimeout(this.startTimer);
			this.startTimer = null;
			this.host = null;
			this.hostExit = null;
			this.ready = null;
			const error = new Error(`Pi agent process exited (code ${code})`);
			this.readyReject?.(error);
			this.readyResolve = null;
			this.readyReject = null;
			for (const pending of this.pending.values()) {
				if (pending.timer) clearTimeout(pending.timer);
				pending.reject(error);
			}
			this.pending.clear();
			for (const dialog of this.activeDialogs.values()) dialog.controller.abort();
			this.activeDialogs.clear();
			if (!this.closing) {
				this.emit({ sequence: ++this.lastSequence, event: { type: 'status', status: 'error', message: error.message } });
				this.emit({ sequence: ++this.lastSequence, event: { type: 'error', message: error.message } });
				const now = Date.now();
				if (now - this.lastAutomaticRestart > 60_000) {
					this.lastAutomaticRestart = now;
					this.ui.onHostCrash?.();
				}
			}
		});
		this.startTimer = setTimeout(() => {
			if (this.host === host && this.readyReject) host.kill();
		}, 60_000);
		return this.ready;
	}

	private handleMessage(host: UtilityProcess, message: AgentHostToMain): void {
		if (this.host !== host) return;
		switch (message.kind) {
			case 'ready':
				if (this.startTimer) clearTimeout(this.startTimer);
				this.startTimer = null;
				this.readyResolve?.();
				this.readyResolve = null;
				this.readyReject = null;
				return;
			case 'reply':
			case 'error': {
				const pending = this.pending.get(message.id);
				if (!pending) return;
				recordDiagnostic({ stage: pending.method === 'mutatePlugin' ? 'plugin' : 'rpc', action: pending.method, outcome: message.kind === 'reply' ? 'success' : 'failure', durationMs: Date.now() - pending.startedAt, requestId: message.id });
				this.pending.delete(message.id);
				if (pending.timer) clearTimeout(pending.timer);
				if (message.kind === 'reply') {
					if (pending.method === 'getSnapshot') {
						const snapshot = message.value as AgentSnapshot;
						const sequence = this.sequenceOffset + snapshot.sequence;
						this.lastSequence = Math.max(this.lastSequence, sequence);
						pending.resolve({ ...snapshot, sequence });
					} else pending.resolve(message.value);
				}
				else pending.reject(new Error(message.message));
				return;
			}
			case 'event':
				this.emit({ ...message.envelope, sequence: this.sequenceOffset + message.envelope.sequence });
				return;
			case 'background-activity':
				for (const listener of this.backgroundActivityListeners) listener(message.cwd, message.path);
				return;
			case 'ui-request':
				void this.handleUiRequest(host, message);
				return;
			case 'ui-cancel':
				this.activeDialogs.get(message.id)?.controller.abort();
				this.activeDialogs.delete(message.id);
				return;
		}
	}

	private async handleUiRequest(host: UtilityProcess, message: Extract<AgentHostToMain, { kind: 'ui-request' }>): Promise<void> {
		const controller = new AbortController();
		const activeDialog = { controller, callId: message.callId };
		this.activeDialogs.set(message.id, activeDialog);
		try {
			const value = message.request.kind === 'project-trust'
				? await this.ui.requestProjectTrust(message.request.cwd)
				: message.request.kind === 'resolve-proxy'
					? await (await import('electron')).session.defaultSession.resolveProxy(message.request.url)
					: await this.ui.requestExtensionDialog(message.request.dialog, controller.signal);
			if (this.host === host && !controller.signal.aborted) {
				const reply: MainToAgentHost = { kind: 'ui-reply', id: message.id, value };
				host.postMessage(reply);
			}
		} catch (error) {
			if (this.host === host && !controller.signal.aborted) {
				const reply: MainToAgentHost = { kind: 'ui-error', id: message.id, message: error instanceof Error ? error.message : String(error) };
				host.postMessage(reply);
			}
		} finally {
			if (this.activeDialogs.get(message.id) === activeDialog) this.activeDialogs.delete(message.id);
		}
	}

	async call(method: AgentHostMethod, ...args: unknown[]): Promise<unknown> {
		const startedAt = Date.now();
		recordDiagnostic({ stage: method === 'mutatePlugin' ? 'plugin' : 'rpc', action: method, outcome: 'start' });
		try { return await this.performCall(method, ...args); }
		catch (error) { recordDiagnostic({ stage: method === 'mutatePlugin' ? 'plugin' : 'rpc', action: method, outcome: 'failure', durationMs: Date.now() - startedAt }); throw error; }
		finally { recordDiagnostic({ stage: 'rpc', action: `${method}.finished`, outcome: 'exit', durationMs: Date.now() - startedAt }); }
	}
	private async performCall(method: AgentHostMethod, ...args: unknown[]): Promise<unknown> {
		const ready = this.start();
		const host = this.host;
		await ready;
		if (this.closing && method !== 'dispose') throw new Error('Pi agent is shutting down');
		// A ready host can exit before this await resumes. Never replay that call
		// against a replacement host, whose active session may be different.
		if (!host || this.host !== host) throw new Error('Pi agent process is unavailable');
		const id = ++this.nextCallId;
		return new Promise<unknown>((resolve, reject) => {
			const pending: PendingCall = { method, resolve, reject, timer: null, startedAt: Date.now() };
			recordDiagnostic({ stage: 'rpc', action: method, outcome: 'start', requestId: id });
			this.pending.set(id, pending);
			const timeout = this.callTimeout(method);
			const expire = (): void => {
				if (this.pending.get(id) !== pending) return;
				// Keep only the call that opened a project trust or extension dialog
				// alive while it waits for the user's answer.
				if ([...this.activeDialogs.values()].some((dialog) => dialog.callId === id)) {
					pending.timer = setTimeout(expire, Math.min(timeout, 60_000));
					return;
				}
				this.pending.delete(id);
				reject(new Error(`Pi 操作响应超时（${method}），请确认当前状态后重试`));
				// Never kill the host here: an accepted prompt can still have a long
				// Pi tool run in progress, and abort remains callable separately.
			};
			if (timeout > 0) pending.timer = setTimeout(expire, timeout);
			const request: MainToAgentHost = { kind: 'call', id, method, args };
			try {
				host.postMessage(request);
			} catch (error) {
				this.pending.delete(id);
				if (pending.timer) clearTimeout(pending.timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	dispose(): Promise<void> {
		if (this.shutdown) return this.shutdown;
		const host = this.host;
		if (!host) {
			this.closing = true;
			return this.shutdown = Promise.resolve();
		}
		// Start the shutdown RPC before closing the call gate, without yielding.
		// A host exit from this point on is intentional and must not restart Pi.
		const reply = this.call('dispose');
		this.closing = true;
		return this.shutdown = this.finishShutdown(host, reply, this.hostExit!);
	}

	private async finishShutdown(host: UtilityProcess, reply: Promise<unknown>, exited: Promise<void>): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				reply,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error('Pi agent shutdown timed out')), 10_000);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
			// kill() only acknowledges a termination request. Keep the caller's
			// session ownership until the actual process exit has been observed.
			let killError: unknown;
			if (this.host === host) {
				try { if (host.kill() === false) killError = new Error('Pi agent process could not be terminated'); }
				catch (error) { killError = error; }
			}
			let exitTimer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					exited,
					new Promise<never>((_, reject) => {
						exitTimer = setTimeout(() => reject(Object.assign(
							new Error('Pi agent process did not exit after shutdown', { cause: killError }),
							{ workerStillRunning: true },
						)), 5_000);
					}),
				]);
			} finally {
				if (exitTimer) clearTimeout(exitTimer);
			}
		}
	}
}

/** Method surface used by the Electron IPC handlers. Calls remain async. */
export function createIsolatedAgentService(ui: AgentHostUiHandlers) {
	const client = new AgentHostClient(ui);
	return {
		...createAgentHostProxy((method, ...args) => client.call(method, ...args)),
		get cwd(): string { return client.cwd; },
		onEvent: (listener: (event: AgentEventEnvelope) => void): void => client.onEvent(listener),
		onBackgroundActivity: (listener: (cwd: string, path: string) => void): void => client.onBackgroundActivity(listener),
		dispose: () => client.dispose(),
	};
}
