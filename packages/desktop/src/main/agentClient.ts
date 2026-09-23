import { app, utilityProcess, type UtilityProcess } from 'electron';
import { join } from 'node:path';
import type { ProjectTrustDecision } from '@pidesktop/agent';
import type { AgentEventEnvelope, AgentSnapshot, UiExtensionDialogRequest, UiSessionSummary } from '@pidesktop/shared';
import type { AgentHostMethod, AgentHostToMain, MainToAgentHost } from './agentHostProtocol';

export interface AgentHostUiHandlers {
	requestProjectTrust(cwd: string): Promise<ProjectTrustDecision>;
	requestExtensionDialog(request: UiExtensionDialogRequest, signal: AbortSignal): Promise<string | boolean | null>;
	onHostCrash?(): void;
}

interface PendingCall {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout> | null;
}

function defaultCallTimeout(method: AgentHostMethod): number {
	if (method === 'abort') return 30_000;
	if (method === 'dispose') return 10_000;
	if (['init', 'switchWorkspace', 'switchSession', 'newSession', 'setExtensionEnabled', 'prompt'].includes(method)) return 300_000;
	return 120_000;
}

export class AgentHostClient {
	private readonly ui: AgentHostUiHandlers;
	private readonly callTimeout: (method: AgentHostMethod) => number;
	private host: UtilityProcess | null = null;
	private ready: Promise<void> | null = null;
	private readyResolve: (() => void) | null = null;
	private readyReject: ((error: Error) => void) | null = null;
	private startTimer: ReturnType<typeof setTimeout> | null = null;
	private nextCallId = 0;
	private readonly pending = new Map<number, PendingCall>();
	private readonly activeDialogs = new Map<number, AbortController>();
	private readonly listeners = new Set<(event: AgentEventEnvelope) => void>();
	private readonly backgroundActivityListeners = new Set<(cwd: string, path: string) => void>();
	private lastSequence = 0;
	private currentCwd = '';
	private closing = false;
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
		const host = utilityProcess.fork(join(app.getAppPath(), 'out', 'main', 'agentHost.js'), [], { serviceName: 'Pi Agent' });
		this.host = host;
		this.ready = new Promise<void>((resolve, reject) => {
			this.readyResolve = resolve;
			this.readyReject = reject;
		});
		host.on('message', (message: AgentHostToMain) => this.handleMessage(host, message));
		host.on('error', (type, location, report) => {
			console.error(`Pi agent host error (${type}) at ${location}: ${report}`);
		});
		host.on('exit', (code) => {
			if (this.host !== host) return;
			if (this.startTimer) clearTimeout(this.startTimer);
			this.startTimer = null;
			this.host = null;
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
			for (const controller of this.activeDialogs.values()) controller.abort();
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
				this.pending.delete(message.id);
				if (pending.timer) clearTimeout(pending.timer);
				if (message.kind === 'reply') pending.resolve(message.value);
				else pending.reject(new Error(message.message));
				return;
			}
			case 'event':
				this.emit(message.envelope);
				return;
			case 'background-activity':
				for (const listener of this.backgroundActivityListeners) listener(message.cwd, message.path);
				return;
			case 'ui-request':
				void this.handleUiRequest(host, message);
				return;
			case 'ui-cancel':
				this.activeDialogs.get(message.id)?.abort();
				this.activeDialogs.delete(message.id);
				return;
		}
	}

	private async handleUiRequest(host: UtilityProcess, message: Extract<AgentHostToMain, { kind: 'ui-request' }>): Promise<void> {
		const controller = new AbortController();
		this.activeDialogs.set(message.id, controller);
		try {
			const value = message.request.kind === 'project-trust'
				? await this.ui.requestProjectTrust(message.request.cwd)
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
			this.activeDialogs.delete(message.id);
		}
	}

	async call(method: AgentHostMethod, ...args: unknown[]): Promise<unknown> {
		await this.start();
		const host = this.host;
		if (!host) throw new Error('Pi agent process is unavailable');
		const id = ++this.nextCallId;
		return new Promise<unknown>((resolve, reject) => {
			const pending: PendingCall = { resolve, reject, timer: null };
			this.pending.set(id, pending);
			const timeout = this.callTimeout(method);
			const expire = (): void => {
				if (this.pending.get(id) !== pending) return;
				// Pi extensions and project trust may be waiting for the user. Keep the
				// request alive while one of their dialogs is open.
				if (this.activeDialogs.size > 0) {
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

	async dispose(): Promise<void> {
		const host = this.host;
		if (!host) {
			this.closing = true;
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				this.call('dispose'),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error('Pi agent shutdown timed out')), 10_000);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
			this.closing = true;
			host.kill();
		}
	}
}

/** Method surface used by the Electron IPC handlers. Calls remain async. */
export function createIsolatedAgentService(ui: AgentHostUiHandlers) {
	const client = new AgentHostClient(ui);
	return {
		get cwd(): string { return client.cwd; },
		onEvent: (listener: (event: AgentEventEnvelope) => void): void => client.onEvent(listener),
		onBackgroundActivity: (listener: (cwd: string, path: string) => void): void => client.onBackgroundActivity(listener),
		init: (...args: unknown[]) => client.call('init', ...args),
		switchWorkspace: (...args: unknown[]) => client.call('switchWorkspace', ...args),
		getSnapshot: (...args: unknown[]): Promise<AgentSnapshot> => client.call('getSnapshot', ...args) as Promise<AgentSnapshot>,
		listSessions: (...args: unknown[]): Promise<UiSessionSummary[]> => client.call('listSessions', ...args) as Promise<UiSessionSummary[]>,
		switchSession: (...args: unknown[]) => client.call('switchSession', ...args),
		renameSession: (...args: unknown[]) => client.call('renameSession', ...args),
		listModels: (...args: unknown[]) => client.call('listModels', ...args),
		setModel: (...args: unknown[]) => client.call('setModel', ...args),
		setThinkingLevel: (...args: unknown[]) => client.call('setThinkingLevel', ...args),
		listProviderAuth: (...args: unknown[]) => client.call('listProviderAuth', ...args),
		setProviderApiKey: (...args: unknown[]) => client.call('setProviderApiKey', ...args),
		removeProviderCredential: (...args: unknown[]) => client.call('removeProviderCredential', ...args),
		listExtensions: (...args: unknown[]) => client.call('listExtensions', ...args),
		setExtensionEnabled: (...args: unknown[]) => client.call('setExtensionEnabled', ...args),
		prompt: (...args: unknown[]) => client.call('prompt', ...args),
		abort: (...args: unknown[]) => client.call('abort', ...args),
		newSession: (...args: unknown[]) => client.call('newSession', ...args),
		dispose: () => client.dispose(),
	};
}
