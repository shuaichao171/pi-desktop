import { app, utilityProcess, type UtilityProcess } from 'electron';
import { join } from 'node:path';
import type { ProjectTrustDecision } from '@pidesktop/agent';
import type { AgentEventEnvelope, AgentSnapshot, UiAttachment, UiExtensionDialogRequest, UiSessionSummary, UiSessionSearchResult, UiSlashCommand, UiSlashCommandRequest, WorkspaceEntry } from '@pidesktop/shared';
import type { AgentHostMethod, AgentHostToMain, MainToAgentHost } from './agentHostProtocol';
import type { UiPluginCatalog, UiPluginMutation, UiPluginResourceKind, UiPluginResourcePreview, UiPluginScope } from '@pidesktop/shared';
import type { UiInstructionDocument, UiSaveInstructionRequest, UiSaveInstructionResult } from '@pidesktop/shared';

export interface AgentHostUiHandlers {
	requestProjectTrust(cwd: string): Promise<ProjectTrustDecision>;
	requestExtensionDialog(request: UiExtensionDialogRequest, signal: AbortSignal): Promise<string | boolean | null>;
	onHostCrash?(): void;
}

interface PendingCall {
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
		const ready = this.start();
		const host = this.host;
		await ready;
		if (this.closing && method !== 'dispose') throw new Error('Pi agent is shutting down');
		// A ready host can exit before this await resumes. Never replay that call
		// against a replacement host, whose active session may be different.
		if (!host || this.host !== host) throw new Error('Pi agent process is unavailable');
		const id = ++this.nextCallId;
		return new Promise<unknown>((resolve, reject) => {
			const pending: PendingCall = { method, resolve, reject, timer: null };
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
		get cwd(): string { return client.cwd; },
		getPersonalization: (): Promise<UiInstructionDocument[]> => client.call('getPersonalization') as Promise<UiInstructionDocument[]>,
		saveInstruction: (request: UiSaveInstructionRequest): Promise<UiSaveInstructionResult> => client.call('saveInstruction', request) as Promise<UiSaveInstructionResult>,
		onEvent: (listener: (event: AgentEventEnvelope) => void): void => client.onEvent(listener),
		onBackgroundActivity: (listener: (cwd: string, path: string) => void): void => client.onBackgroundActivity(listener),
		init: (...args: unknown[]) => client.call('init', ...args),
		switchWorkspace: (...args: unknown[]) => client.call('switchWorkspace', ...args),
		getSnapshot: (...args: unknown[]): Promise<AgentSnapshot> => client.call('getSnapshot', ...args) as Promise<AgentSnapshot>,
		listSessions: (...args: unknown[]): Promise<UiSessionSummary[]> => client.call('listSessions', ...args) as Promise<UiSessionSummary[]>,
		searchSessions: (workspaces: string[], query: string): Promise<{ sessions: UiSessionSearchResult[]; truncated: boolean }> =>
			client.call('searchSessions', workspaces, query) as Promise<{ sessions: UiSessionSearchResult[]; truncated: boolean }>,
		searchWorkspaceFiles: (cwd: string, query: string, options?: { includeDirectories?: boolean }): Promise<{ files: WorkspaceEntry[]; truncated: boolean }> =>
			client.call('searchWorkspaceFiles', cwd, query, options) as Promise<{ files: WorkspaceEntry[]; truncated: boolean }>,
		readSessionContext: (cwd: string, path: string): Promise<UiAttachment> => client.call('readSessionContext', cwd, path) as Promise<UiAttachment>,
		listSlashCommands: (): Promise<UiSlashCommand[]> => client.call('listSlashCommands') as Promise<UiSlashCommand[]>,
		executeSlashCommand: (request: UiSlashCommandRequest): Promise<void> => client.call('executeSlashCommand', request) as Promise<void>,
		switchSession: (...args: unknown[]) => client.call('switchSession', ...args),
		renameSession: (...args: unknown[]) => client.call('renameSession', ...args),
		listModels: (...args: unknown[]) => client.call('listModels', ...args),
		listModelProviders: (...args: unknown[]) => client.call('listModelProviders', ...args),
		discoverProviderModels: (...args: unknown[]) => client.call('discoverProviderModels', ...args),
		saveCustomProvider: (...args: unknown[]) => client.call('saveCustomProvider', ...args),
		removeCustomProvider: (...args: unknown[]) => client.call('removeCustomProvider', ...args),
		setModel: (...args: unknown[]) => client.call('setModel', ...args),
		setThinkingLevel: (...args: unknown[]) => client.call('setThinkingLevel', ...args),
		listProviderAuth: (...args: unknown[]) => client.call('listProviderAuth', ...args),
		setProviderApiKey: (...args: unknown[]) => client.call('setProviderApiKey', ...args),
		removeProviderCredential: (...args: unknown[]) => client.call('removeProviderCredential', ...args),
		listExtensions: (...args: unknown[]) => client.call('listExtensions', ...args),
		setExtensionEnabled: (...args: unknown[]) => client.call('setExtensionEnabled', ...args),
		getPluginCatalog: (cwd: string): Promise<UiPluginCatalog> => client.call('getPluginCatalog', cwd) as Promise<UiPluginCatalog>,
		mutatePlugin: (input: UiPluginMutation): Promise<UiPluginCatalog> => client.call('mutatePlugin', input) as Promise<UiPluginCatalog>,
		previewPluginResource: (request: { cwd: string; path: string; kind: UiPluginResourceKind; scope: UiPluginScope }): Promise<UiPluginResourcePreview> => client.call('previewPluginResource', request) as Promise<UiPluginResourcePreview>,
		prompt: (...args: unknown[]) => client.call('prompt', ...args),
		abort: (...args: unknown[]) => client.call('abort', ...args),
		newSession: (...args: unknown[]) => client.call('newSession', ...args),
		editUserMessage: (...args: unknown[]) => client.call('editUserMessage', ...args),
		forkAssistantMessage: (...args: unknown[]) => client.call('forkAssistantMessage', ...args),
		generateCommitMessage: (...args: unknown[]) => client.call('generateCommitMessage', ...args),
		dispose: () => client.dispose(),
	};
}
