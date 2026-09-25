/**
 * @pidesktop/ui — renderer-side chat store (zustand).
 *
 * Consumes the normalized AgentUiEvent stream through an injected AgentBridge
 * so the UI package stays independent of Electron specifics (same pattern as
 * ZCode's packages/ui + packages/client split).
 */

import { create } from 'zustand';
import { translate } from './i18n.ts';
import { parseSlashCommand } from './composerSlash.ts';
import type {
	AgentBridge,
	AgentEventEnvelope,
	AgentSnapshot,
	AgentStatus,
	AgentUiEvent,
	AppInfo,
	UiAttachment,
	UiFileChange,
	UiContextUsage,
	UiMessage,
	UiModelSummary,
	UiModelProvider,
	UiSaveCustomProviderRequest,
	UiProviderAuthStatus,
	UiQueuedMessage,
	UiSessionSummary,
	UiSessionMetaPatch,
	UiThinkingLevel,
	UiToolActivity,
} from '@pidesktop/shared';

interface ChatState {
	bridge: AgentBridge | null;
	status: AgentStatus;
	statusMessage: string | undefined;
	model: string;
	modelName: string | null;
	modelProvider: string;
	thinkingLevel: UiThinkingLevel | '';
	availableThinkingLevels: UiThinkingLevel[];
	contextUsage: UiContextUsage | null;
	models: UiModelSummary[];
	modelProviders: UiModelProvider[];
	providerAuth: UiProviderAuthStatus[];
	settingsLoading: boolean;
	settingsError: string | null;
	cwd: string;
	workspaces: string[];
	sessionsByWorkspace: Record<string, UiSessionSummary[]>;
	sessionId: string | null;
	sessionPath: string | null;
	sessions: UiSessionSummary[];
	messages: UiMessage[];
	activities: UiToolActivity[];
	timelineRevision: number;
	queuedCount: number;
	queuedMessages: UiQueuedMessage[];
	fileChanges: UiFileChange[];
	error: string | null;
	appInfo: AppInfo | null;
	/** Latest explicit project/session navigation intent; stale requests cannot overwrite it. */
	navigationRequestId: number;
	navigationPending: boolean;

	setBridge(bridge: AgentBridge): void;
	retryAgent(): Promise<void>;
	handleEvent(event: AgentUiEvent): void;
	refreshSessions(): Promise<void>;
	refreshWorkspaces(): Promise<void>;
	refreshWorkspaceSessions(cwd: string): Promise<void>;
	switchWorkspace(cwd: string): Promise<void>;
	updateSessionMeta(path: string, patch: UiSessionMetaPatch): Promise<void>;
	updateSessionOrders(entries: { path: string; order: number | null }[]): Promise<void>;
	refreshModels(): Promise<void>;
	refreshModelProviders(): Promise<void>;
	saveCustomProvider(request: UiSaveCustomProviderRequest): Promise<void>;
	removeCustomProvider(provider: string): Promise<void>;
	setModel(provider: string, id: string): Promise<void>;
	setThinkingLevel(level: UiThinkingLevel): Promise<void>;
	refreshProviderAuth(): Promise<void>;
	setProviderApiKey(provider: string, key: string): Promise<void>;
	removeProviderCredential(provider: string): Promise<void>;
	switchSession(path: string): Promise<void>;
	selectSession(cwd: string, path: string): Promise<boolean>;
	send(text: string, behavior?: 'steer' | 'followUp', attachments?: UiAttachment[]): Promise<void>;
	/** Rewind to a sent user message and resend the edited text (zcode-style edit). */
	editMessage(entryId: string, text: string, attachments?: UiAttachment[]): Promise<void>;
	abort(): Promise<void>;
	newSession(): Promise<void>;
	pickWorkspace(): Promise<void>;
}

const sessionListRequests = new Map<string, number>();
let workspacesRequest = 0;
let settingsRequestCount = 0;
let settingsGeneration = 0;
let modelsRequest = 0;
let modelProvidersRequest = 0;
let providerAuthRequest = 0;
let unsubscribeAgentEvent: (() => void) | null = null;
let bridgeGeneration = 0;
const MAX_BOOTSTRAP_EVENTS = 256;
const MAX_BOOTSTRAP_RESYNCS = 3;
const SNAPSHOT_TIMEOUT_MS = 15_000;

async function snapshotWithTimeout(bridge: AgentBridge): Promise<AgentSnapshot> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			bridge.getAgentSnapshot(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(translate('store.snapshotTimeout'))), SNAPSHOT_TIMEOUT_MS);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function resetSettingsRequests(): void {
	settingsGeneration += 1;
	settingsRequestCount = 0;
}

function beginSettingsRequest(): number {
	settingsRequestCount += 1;
	useChatStore.setState({ settingsLoading: true, settingsError: null });
	return settingsGeneration;
}

function endSettingsRequest(generation: number): void {
	if (generation !== settingsGeneration) return;
	settingsRequestCount = Math.max(0, settingsRequestCount - 1);
	useChatStore.setState({ settingsLoading: settingsRequestCount > 0 });
}

export const useChatStore = create<ChatState>((set, get) => ({
	bridge: null,
	status: 'uninitialized',
	statusMessage: undefined,
	model: '',
	modelName: null,
	modelProvider: '',
	thinkingLevel: '',
	availableThinkingLevels: [],
	contextUsage: null,
	models: [],
	modelProviders: [],
	providerAuth: [],
	settingsLoading: false,
	settingsError: null,
	cwd: '',
	workspaces: [],
	sessionsByWorkspace: {},
	sessionId: null,
	sessionPath: null,
	sessions: [],
	messages: [],
	activities: [],
	timelineRevision: 0,
	queuedCount: 0,
	queuedMessages: [],
	fileChanges: [],
	error: null,
	appInfo: null,
	navigationRequestId: 0,
	navigationPending: false,

	setBridge(bridge) {
		if (get().bridge === bridge) return;
		unsubscribeAgentEvent?.();
		unsubscribeAgentEvent = null;
		bridgeGeneration += 1;
		const generation = bridgeGeneration;
		sessionListRequests.clear();
		resetSettingsRequests();
		set({
			...useChatStore.getInitialState(),
			bridge,
			timelineRevision: get().timelineRevision + 1,
		});
		let bootstrapping = true;
		let needsRecovery = false;
		let overflowed = false;
		const buffered: AgentEventEnvelope[] = [];
		unsubscribeAgentEvent = bridge.onAgentEvent((envelope) => {
			if (generation !== bridgeGeneration || get().bridge !== bridge) return;
			if (bootstrapping) {
				if (buffered.length >= MAX_BOOTSTRAP_EVENTS) {
					buffered.shift();
					overflowed = true;
				}
				buffered.push(envelope);
				return;
			}
			if (needsRecovery) {
				if (envelope.event.type !== 'reset' && envelope.event.type !== 'ready') return;
				needsRecovery = false;
			}
			get().handleEvent(envelope.event);
		});
		void (async () => {
			for (let attempt = 0; attempt < MAX_BOOTSTRAP_RESYNCS; attempt += 1) {
				const snapshot = await snapshotWithTimeout(bridge);
				if (generation !== bridgeGeneration || get().bridge !== bridge) return;
				if (overflowed) {
					// The first snapshot may predate dropped events. Start a fresh snapshot
					// with an empty, bounded buffer so no delta is silently lost.
					buffered.length = 0;
					overflowed = false;
					continue;
				}
				set({
					status: snapshot.status,
					statusMessage: snapshot.statusMessage,
					model: snapshot.model,
					modelName: snapshot.modelName ?? null,
					modelProvider: snapshot.modelProvider,
					thinkingLevel: snapshot.thinkingLevel,
					availableThinkingLevels: snapshot.availableThinkingLevels,
					contextUsage: snapshot.contextUsage ? { ...snapshot.contextUsage } : null,
					cwd: snapshot.cwd,
					sessionId: snapshot.sessionId,
					sessionPath: snapshot.sessionPath,
					messages: snapshot.messages,
					activities: snapshot.activities,
					timelineRevision: get().timelineRevision + 1,
					queuedCount: snapshot.queuedCount,
					queuedMessages: snapshot.queuedMessages ?? [],
					fileChanges: snapshot.fileChanges ?? [],
					error: snapshot.error,
				});
				bootstrapping = false;
				for (const envelope of buffered) {
					if (envelope.sequence > snapshot.sequence) get().handleEvent(envelope.event);
				}
				buffered.length = 0;
				void get().refreshSessions();
				void get().refreshWorkspaces();
				return;
			}
			throw new Error(translate('store.bootstrapOverflow'));
		})().catch((error: unknown) => {
				if (generation !== bridgeGeneration || get().bridge !== bridge) return;
				bootstrapping = false;
				const latestReady = buffered.findLastIndex((envelope) => envelope.event.type === 'ready');
				if (!overflowed && latestReady >= 0) {
					for (const envelope of buffered.slice(latestReady)) get().handleEvent(envelope.event);
					buffered.length = 0;
					if (get().status === 'idle' || get().status === 'busy') {
						void get().refreshSessions();
						void get().refreshWorkspaces();
						return;
					}
				}
				buffered.length = 0;
				needsRecovery = true;
				set({ error: errorMessage(error), status: 'error' });
				void get().refreshWorkspaces();
			});
		void bridge
			.getAppInfo()
			.then((appInfo) => { if (generation === bridgeGeneration && get().bridge === bridge) set({ appInfo }); })
			.catch(() => {});
	},

	async retryAgent() {
		const { bridge, status, cwd, workspaces } = get();
		if (!bridge || status !== 'error') return;
		const request = beginSessionNavigation();
		set({ status: 'starting', error: null, statusMessage: undefined });
		try {
			const target = cwd || workspaces[0] || (await bridge.listWorkspaces())[0];
			if (!currentSessionNavigation(bridge, request)) return;
			if (!target) throw new Error(translate('store.noWorkspaceToRetry'));
			await bridge.initAgent(target);
		} catch (error) {
			if (!currentSessionNavigation(bridge, request)) return;
			set({ status: 'error', error: errorMessage(error) });
			throw error;
		} finally { finishSessionNavigation(bridge, request); }
	},

	handleEvent(event) {
		switch (event.type) {
			case 'reset':
				resetSettingsRequests();
				set({
					status: 'uninitialized',
					statusMessage: undefined,
					model: '',
					modelName: null,
					modelProvider: '',
					thinkingLevel: '',
					availableThinkingLevels: [],
					contextUsage: null,
					models: [],
					modelProviders: [],
					providerAuth: [],
					settingsLoading: false,
					settingsError: null,
					cwd: event.cwd,
					sessionId: null,
					sessionPath: null,
					sessions: get().sessionsByWorkspace[event.cwd] ?? [],
					messages: [],
					activities: [],
					timelineRevision: get().timelineRevision + 1,
					queuedCount: 0,
					queuedMessages: [],
					fileChanges: [],
					error: null,
				});
				return;
			case 'status': {
				const previousStatus = get().status;
				set((state) => ({
					status: event.status, statusMessage: event.message,
					...(event.status === 'error' ? {
						messages: state.messages.map((message) => message.status === 'streaming' ? {
							...message, status: 'error' as const, errorMessage: event.message ?? message.errorMessage,
							thinkingStatus: message.thinkingStatus === 'streaming' ? 'error' as const : message.thinkingStatus,
						} : message),
						activities: state.activities.map((activity) => activity.status === 'running'
							? { ...activity, status: 'interrupted' as const } : activity),
					} : {}),
				}));
				if (event.status === 'idle' && previousStatus !== 'idle') void get().refreshSessions();
				return;
			}
			case 'ready':
				// A fresh session context: clear the conversation view.
				set({
					model: event.model,
					modelName: event.modelName ?? null,
					modelProvider: event.modelProvider,
					thinkingLevel: event.thinkingLevel,
					availableThinkingLevels: event.availableThinkingLevels,
					contextUsage: event.contextUsage ? { ...event.contextUsage } : null,
					cwd: event.cwd,
					sessions: get().sessionsByWorkspace[event.cwd] ?? [],
					sessionId: event.sessionId,
					sessionPath: event.sessionPath,
					messages: event.messages,
					activities: event.activities,
					timelineRevision: get().timelineRevision + 1,
					queuedCount: 0,
					queuedMessages: [],
					fileChanges: event.fileChanges ?? [],
					error: null,
				});
				return;
			case 'model':
				set({
					model: event.model,
					modelName: event.modelName ?? null,
					modelProvider: event.modelProvider,
					thinkingLevel: event.thinkingLevel,
					availableThinkingLevels: event.availableThinkingLevels,
					contextUsage: event.contextUsage ? { ...event.contextUsage } : null,
				});
				return;
			case 'context-usage':
				set({ contextUsage: event.contextUsage ? { ...event.contextUsage } : null });
				return;
			case 'thinking-level':
				set({ thinkingLevel: event.level });
				return;
			case 'user-message':
				set((s) => ({
					messages: [...s.messages, { id: event.id, order: event.order, role: 'user', text: event.text, attachments: event.attachments, status: 'done' }],
					timelineRevision: s.timelineRevision + 1,
				}));
				return;
			case 'assistant-start':
				set((s) => ({
					messages: [...s.messages, { id: event.id, order: event.order, role: 'assistant', text: '', status: 'streaming' }],
					timelineRevision: s.timelineRevision + 1,
					error: null,
				}));
				return;
			case 'assistant-delta':
				set((s) => ({
					messages: s.messages.map((m) =>
						m.id === event.id ? { ...m, text: m.text + event.delta } : m,
					),
				}));
				return;
			case 'assistant-thinking':
				set((s) => ({
					messages: s.messages.map((message) => message.id === event.id && message.status === 'streaming'
						? { ...message, thinking: event.thinking, thinkingStatus: event.thinkingStatus, thinkingTruncated: event.thinkingTruncated }
						: message),
				}));
				return;
			case 'assistant-end':
				set((s) => ({
					messages: s.messages.map((m) =>
						m.id === event.id
							? {
									...m,
									text: event.text || m.text,
									thinking: event.thinking ?? m.thinking,
									thinkingTruncated: event.thinkingTruncated ?? m.thinkingTruncated,
									thinkingStatus: event.thinkingStatus ?? (m.thinkingStatus
										? event.errorMessage ? 'error' : event.aborted ? 'interrupted' : 'done'
										: undefined),
									errorMessage: event.errorMessage,
									status: event.aborted || event.errorMessage ? 'error' : 'done',
								}
							: m,
					),
					...(event.errorMessage ? { error: event.errorMessage } : {}),
				}));
				return;
			case 'tool': {
				const incoming: UiToolActivity = event.activity;
				set((s) => {
					const index = s.activities.findIndex((a) => a.id === incoming.id);
					const activities = [...s.activities];
					if (index >= 0) {
						activities[index] = incoming;
					} else {
						activities.push(incoming);
					}
					return { activities, ...(index < 0 ? { timelineRevision: s.timelineRevision + 1 } : {}) };
				});
				return;
			}
			case 'queue':
				set({ queuedCount: event.count, queuedMessages: event.items ?? [] });
				return;
			case 'file-changes':
				set({ fileChanges: event.items });
				return;
			case 'sessions-changed':
				void get().refreshWorkspaceSessions(event.cwd);
				return;
			case 'error':
				set({ error: event.message });
				return;
		}
	},

	async refreshSessions() {
		const cwd = get().cwd;
		if (cwd) await get().refreshWorkspaceSessions(cwd);
	},

	async refreshWorkspaces() {
		const bridge = get().bridge;
		if (!bridge) return;
		const request = ++workspacesRequest;
		const navigationRequest = get().navigationRequestId;
		try {
			const workspaces = await bridge.listWorkspaces();
			if (get().bridge !== bridge || request !== workspacesRequest) return;
			const current = get().cwd;
			set({ workspaces: current && !workspaces.includes(current) ? [current, ...workspaces] : workspaces });
		} catch (error) {
			if (request === workspacesRequest && currentSessionNavigation(bridge, navigationRequest)) set({ error: errorMessage(error) });
		}
	},

	refreshWorkspaceSessions: (cwd) => refreshSessionCache(cwd),

	async switchWorkspace(cwd) {
		const bridge = get().bridge;
		if (!bridge || !cwd || (cwd === get().cwd && !get().navigationPending)) return;
		const request = beginSessionNavigation();
		try {
			await bridge.switchWorkspace(cwd);
			if (!currentSessionNavigation(bridge, request)) return;
			await Promise.all([get().refreshWorkspaces(), get().refreshWorkspaceSessions(cwd)]);
		} catch (error) {
			if (currentSessionNavigation(bridge, request)) set({ error: errorMessage(error) });
			throw error;
		} finally { finishSessionNavigation(bridge, request); }
	},

	async updateSessionMeta(path, patch) {
		const { bridge, cwd, sessionId, navigationRequestId } = get();
		if (!bridge) return;
		const workspace = Object.entries(get().sessionsByWorkspace).find(([, sessions]) => sessions.some((session) => session.path === path))?.[0] ?? cwd;
		const isCurrent = () => currentSessionNavigation(bridge, navigationRequestId) && get().cwd === cwd && get().sessionId === sessionId;
		// Editors own mutation errors and retain their drafts. Do not turn a
		// failed title/metadata edit into a chat failure, especially after switching.
		await bridge.updateSessionMeta(path, patch);
		if (get().bridge !== bridge) return;
		if (workspace) await refreshSessionCache(workspace, isCurrent());
	},

	async updateSessionOrders(entries) {
		const { bridge, navigationRequestId } = get();
		if (!bridge || !entries.length) return;
		const byWorkspace = new Map<string, string[]>();
		for (const entry of entries) {
			const workspace = Object.entries(get().sessionsByWorkspace).find(([, sessions]) => sessions.some((session) => session.path === entry.path))?.[0];
			if (!workspace) continue;
			byWorkspace.set(workspace, [...(byWorkspace.get(workspace) ?? []), entry.path]);
		}
		const isCurrent = () => currentSessionNavigation(bridge, navigationRequestId);
		await bridge.updateSessionOrders(entries);
		if (get().bridge !== bridge) return;
		await Promise.all([...byWorkspace.keys()].map((workspace) => refreshSessionCache(workspace, isCurrent())));
	},

	async refreshModels() {
		const bridge = get().bridge;
		if (!bridge) return;
		const generation = beginSettingsRequest();
		const request = ++modelsRequest;
		try {
			const models = await bridge.listModels();
			if (generation === settingsGeneration && request === modelsRequest) set({ models });
		} catch (error) {
			if (generation === settingsGeneration && request === modelsRequest) set({ settingsError: errorMessage(error) });
			throw error;
		} finally {
			endSettingsRequest(generation);
		}
	},

	async refreshModelProviders() {
		const bridge = get().bridge;
		if (!bridge) return;
		const generation = beginSettingsRequest();
		const request = ++modelProvidersRequest;
		try {
			const modelProviders = await bridge.listModelProviders();
			if (generation === settingsGeneration && request === modelProvidersRequest) set({ modelProviders });
		} catch (error) {
			if (generation === settingsGeneration && request === modelProvidersRequest) set({ settingsError: errorMessage(error) });
			throw error;
		} finally {
			endSettingsRequest(generation);
		}
	},

	async saveCustomProvider(request) {
		await updateCustomProvider((bridge) => bridge.saveCustomProvider(request));
	},

	async removeCustomProvider(provider) {
		await updateCustomProvider((bridge) => bridge.removeCustomProvider(provider));
	},

	async setModel(provider, id) {
		const bridge = get().bridge;
		if (!bridge) return;
		const generation = beginSettingsRequest();
		try {
			await bridge.setModel(provider, id);
		} catch (error) {
			if (generation === settingsGeneration) set({ settingsError: errorMessage(error) });
			throw error;
		} finally {
			endSettingsRequest(generation);
		}
	},

	async setThinkingLevel(level) {
		const bridge = get().bridge;
		if (!bridge) return;
		const generation = beginSettingsRequest();
		try {
			await bridge.setThinkingLevel(level);
		} catch (error) {
			if (generation === settingsGeneration) set({ settingsError: errorMessage(error) });
			throw error;
		} finally {
			endSettingsRequest(generation);
		}
	},

	async refreshProviderAuth() {
		const bridge = get().bridge;
		if (!bridge) return;
		const generation = beginSettingsRequest();
		const request = ++providerAuthRequest;
		try {
			const providerAuth = await bridge.listProviderAuth();
			if (generation === settingsGeneration && request === providerAuthRequest) set({ providerAuth });
		} catch (error) {
			if (generation === settingsGeneration && request === providerAuthRequest) set({ settingsError: errorMessage(error) });
			throw error;
		} finally {
			endSettingsRequest(generation);
		}
	},

	async setProviderApiKey(provider, key) {
		const bridge = get().bridge;
		if (!bridge) return;
		const generation = beginSettingsRequest();
		try {
			await bridge.setProviderApiKey(provider, key.trim());
			if (generation !== settingsGeneration) return;
			await refreshModelSettings();
		} catch (error) {
			if (generation === settingsGeneration) set({ settingsError: errorMessage(error) });
			throw error;
		} finally {
			endSettingsRequest(generation);
		}
	},

	async removeProviderCredential(provider) {
		const bridge = get().bridge;
		if (!bridge) return;
		const generation = beginSettingsRequest();
		try {
			await bridge.removeProviderCredential(provider);
			if (generation !== settingsGeneration) return;
			await refreshModelSettings();
		} catch (error) {
			if (generation === settingsGeneration) set({ settingsError: errorMessage(error) });
			throw error;
		} finally {
			endSettingsRequest(generation);
		}
	},

	async switchSession(path) {
		const bridge = get().bridge;
		if (!bridge) return;
		const request = beginSessionNavigation();
		try {
			await bridge.switchSession(path);
			if (!currentSessionNavigation(bridge, request)) return;
			await get().refreshSessions();
		} catch (error) {
			if (currentSessionNavigation(bridge, request)) set({ error: errorMessage(error) });
			throw error;
		} finally { finishSessionNavigation(bridge, request); }
	},

	async selectSession(cwd, path) {
		const bridge = get().bridge;
		if (!bridge || !cwd || !path) return false;
		const request = beginSessionNavigation();
		const workspaceChanged = get().cwd !== cwd;
		try {
			if (workspaceChanged) {
				await bridge.switchWorkspace(cwd);
				if (!currentSessionNavigation(bridge, request)) return false;
			}
			await bridge.switchSession(path);
			if (!currentSessionNavigation(bridge, request)) return false;
			await Promise.all([get().refreshWorkspaceSessions(cwd), ...(workspaceChanged ? [get().refreshWorkspaces()] : [])]);
			return currentSessionNavigation(bridge, request);
		} catch (error) {
			if (!currentSessionNavigation(bridge, request)) return false;
			set({ error: errorMessage(error) });
			throw error;
		} finally { finishSessionNavigation(bridge, request); }
	},

	async send(text, behavior, attachments) {
		const { bridge, status, cwd, sessionId } = get();
		const trimmed = text.trim();
		if (!bridge || (!trimmed && !attachments?.length)) return;
		if (status !== 'idle' && status !== 'busy') {
			const error = new Error(translate('store.agentNotReady'));
			set({ error: error.message });
			throw error;
		}
		set({ error: null });
		let navigationRequest: number | undefined;
		try {
			const command = parseSlashCommand(trimmed);
			const delivery = behavior ?? (status === 'busy' ? 'followUp' : undefined);
			if (command) {
				if (!sessionId) throw new Error(translate('store.agentNotReady'));
				if (command.name === 'new') navigationRequest = beginSessionNavigation();
				await bridge.executeSlashCommand({ cwd, sessionId, ...command, behavior: delivery, attachments });
			} else await bridge.prompt(trimmed, delivery, attachments);
		} catch (error) {
			if (get().bridge === bridge && get().cwd === cwd && get().sessionId === sessionId
				&& (navigationRequest === undefined || currentSessionNavigation(bridge, navigationRequest))) set({ error: errorMessage(error) });
			throw error;
		} finally { if (navigationRequest !== undefined) finishSessionNavigation(bridge, navigationRequest); }
	},

	async editMessage(entryId, text, attachments) {
		const { bridge, status, cwd, sessionId } = get();
		const trimmed = text.trim();
		if (!bridge || !trimmed) return;
		if (status !== 'idle') {
			const error = new Error(translate('store.sessionBusy'));
			set({ error: error.message });
			throw error;
		}
		set({ error: null });
		try {
			await bridge.editMessage(entryId, trimmed, attachments);
		} catch (error) {
			if (get().bridge === bridge && get().cwd === cwd && get().sessionId === sessionId) set({ error: errorMessage(error) });
			throw error;
		}
	},

	async abort() {
		const { bridge, cwd, sessionId, navigationRequestId } = get();
		try {
			await bridge?.abort();
		} catch (error) {
			if (bridge && currentSessionNavigation(bridge, navigationRequestId) && get().cwd === cwd && get().sessionId === sessionId) set({ error: errorMessage(error) });
		}
	},

	async newSession() {
		const bridge = get().bridge;
		if (!bridge) return;
		const request = beginSessionNavigation();
		try {
			await bridge.newSession();
			if (!currentSessionNavigation(bridge, request)) return;
			await get().refreshSessions();
		} catch (error) {
			if (currentSessionNavigation(bridge, request)) set({ error: errorMessage(error) });
			throw error;
		} finally { finishSessionNavigation(bridge, request); }
	},

	async pickWorkspace() {
		const bridge = get().bridge;
		if (!bridge) return;
		const request = beginSessionNavigation();
		try {
			const cwd = await bridge.pickWorkspace();
			if (!currentSessionNavigation(bridge, request)) return;
			if (cwd) {
				await bridge.switchWorkspace(cwd);
				if (!currentSessionNavigation(bridge, request)) return;
				await Promise.all([get().refreshWorkspaces(), get().refreshWorkspaceSessions(cwd)]);
			}
		} catch (error) {
			if (currentSessionNavigation(bridge, request)) set({ error: errorMessage(error) });
			throw error;
		} finally { finishSessionNavigation(bridge, request); }
	},
}));

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function refreshModelSettings(): Promise<void> {
	const state = useChatStore.getState();
	// Finish every refresh before releasing the mutation's loading state.
	const results = await Promise.allSettled([state.refreshModels(), state.refreshProviderAuth(), state.refreshModelProviders()]);
	const failure = results.find((result) => result.status === 'rejected');
	if (failure?.status === 'rejected') throw failure.reason;
}

async function updateCustomProvider(action: (bridge: AgentBridge) => Promise<void>): Promise<void> {
	const bridge = useChatStore.getState().bridge;
	if (!bridge) return;
	const generation = beginSettingsRequest();
	try {
		await action(bridge);
		if (generation !== settingsGeneration) return;
		await refreshModelSettings();
	} catch (error) {
		if (generation === settingsGeneration) useChatStore.setState({ settingsError: errorMessage(error) });
		throw error;
	} finally {
		endSettingsRequest(generation);
	}
}

async function refreshSessionCache(cwd: string, reportError = true): Promise<void> {
	const { bridge, navigationRequestId } = useChatStore.getState();
	if (!bridge || !cwd) return;
	const request = (sessionListRequests.get(cwd) ?? 0) + 1;
	sessionListRequests.set(cwd, request);
	try {
		const sessions = await bridge.listSessions(cwd);
		if (useChatStore.getState().bridge !== bridge || sessionListRequests.get(cwd) !== request) return;
		useChatStore.setState((state) => ({
			sessionsByWorkspace: { ...state.sessionsByWorkspace, [cwd]: sessions },
			...(state.cwd === cwd ? { sessions } : {}),
		}));
	} catch (error) {
		if (reportError && currentSessionNavigation(bridge, navigationRequestId) && sessionListRequests.get(cwd) === request) useChatStore.setState({ error: errorMessage(error) });
	}
}

function beginSessionNavigation(): number {
	const request = useChatStore.getState().navigationRequestId + 1;
	useChatStore.setState({ navigationRequestId: request, navigationPending: true, error: null });
	return request;
}

function currentSessionNavigation(bridge: AgentBridge, request: number): boolean {
	const state = useChatStore.getState();
	return state.bridge === bridge && state.navigationRequestId === request;
}

function finishSessionNavigation(bridge: AgentBridge, request: number): void {
	if (currentSessionNavigation(bridge, request)) useChatStore.setState({ navigationPending: false });
}

/** Convenience selector: is the agent currently producing output? */
export const selectBusy = (s: ChatState): boolean =>
	s.status === 'busy' || s.status === 'starting';

/** A ready session carries its restored timeline; status alone can arrive first. */
export const selectStartupReady = (s: ChatState): boolean =>
	s.status === 'error' || (s.sessionId !== null && (s.status === 'idle' || s.status === 'busy'));
