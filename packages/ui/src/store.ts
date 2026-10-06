/**
 * @pidesktop/ui — renderer-side chat store (zustand).
 *
 * Consumes the normalized AgentUiEvent stream through an injected AgentBridge
 * so the UI package stays independent of Electron specifics (same pattern as
 * ZCode's packages/ui + packages/client split).
 */

import { create } from 'zustand';
import { sessionOpenMetrics } from './sessionOpenMetrics.ts';
import { translate } from './i18n.ts';
import { parseSlashCommand } from './composerSlash.ts';
import { mergeRuntimeStates, sessionRuntimeKey, type WorkspaceSessionRequest } from './managementState.ts';
import { mergeConversationRuns } from './conversationRuns.ts';
import type { UiAgentError } from '@pidesktop/shared';
import type {
	AgentBridge,
	AgentEventEnvelope,
	AgentSnapshot,
	AgentStatus,
	AgentUiEvent,
	AppInfo,
	UiAttachment,
	UiInputScope,
	UiFileChange,
	UiContextUsage,
	UiMessage,
	UiConversationRun,
	UiModelSummary,
	UiModelProvider,
	UiSaveCustomProviderRequest,
	UiProviderAuthStatus,
	UiQueuedMessage,
	UiSessionSummary,
	UiSessionRuntimeState,
	UiSessionMetaPatch,
	UiThinkingLevel,
	UiToolActivity,
} from '@pidesktop/shared';

interface ChatState {
	bridge: AgentBridge | null;
	status: AgentStatus;
	statusMessage: string | undefined;
	/** Auto-retry progress from the agent (4.4 run-status bar). */
	retryAttempt: number | undefined;
	retryMaxAttempts: number | undefined;
	sessionLoading: boolean;
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
	/** Internal conversation folders remain searchable without becoming projects. */
	conversationWorkspaces: string[];
	defaultWorkspace: string | null;
	sessionsByWorkspace: Record<string, UiSessionSummary[]>;
	workspaceSessionRequests: Record<string, WorkspaceSessionRequest>;
	sessionRuntimes: Record<string, UiSessionRuntimeState>;
	sessionId: string | null;
	sessionPath: string | null;
	sessions: UiSessionSummary[];
	messages: UiMessage[];
	activities: UiToolActivity[];
	runs: UiConversationRun[];
	timelineRevision: number;
	/** Changes when ready/reset replaces the branch, but not on live appends. */
	historyGeneration: number;
	/** Full timeline entry count of the loaded branch; older entries load via loadOlderMessages. */
	historyTotal: number;
	loadingOlder: boolean;
	queuedCount: number;
	queuedMessages: UiQueuedMessage[];
	fileChanges: UiFileChange[];
	error: string | null;
	/** Structured evidence for the last agent failure; text-only errors stay null. */
	errorInfo: UiAgentError | null;
	appInfo: AppInfo | null;
	/** Latest explicit project/session navigation intent; stale requests cannot overwrite it. */
	navigationRequestId: number;
	navigationPending: boolean;
	/** A new standalone conversation is prepared without blocking its local draft. */
	sessionPreparation: { requestId: number; draftScope: UiInputScope } | null;
	draftTransfer: { requestId: number; from: UiInputScope; to: UiInputScope } | null;
	/** Completed creations whose local draft was left before the backend receipt arrived. */
	backgroundDraftTransfers: Array<{ requestId: number; from: UiInputScope; to: UiInputScope }>;

	setBridge(bridge: AgentBridge): void;
	retryAgent(): Promise<void>;
	handleEvent(event: AgentUiEvent): void;
	refreshSessions(): Promise<void>;
	/** Loads the next older slice of the active session's timeline (2.6). */
	loadOlderMessages(pageSize?: number): Promise<boolean>;
	refreshWorkspaces(): Promise<void>;
	refreshWorkspaceSessions(cwd: string): Promise<void>;
	/** force retries a failed activation/persistence step even after the agent has emitted the target cwd. */
	switchWorkspace(cwd: string, options?: { fresh?: boolean; force?: boolean }): Promise<void>;
	removeWorkspace(cwd: string): Promise<void>;
	updateSessionMeta(path: string, patch: UiSessionMetaPatch): Promise<void>;
	/** Moves a conversation to the app trash after a confirmation; active sessions switch away first (3.3). */
	deleteSession(path: string): Promise<void>;
	/** Trash several conversations in one batch: sequential bridge calls with independent failures (one bad path never rolls back the rest), a pre-flight re-validation of the selection, and a single cache refresh for the whole batch. */
	deleteSessions(paths: string[], options?: { expectArchived?: boolean }): Promise<{ deleted: string[]; failed: Record<string, string>; skipped: Record<string, string> }>;
	updateSessionOrders(entries: { path: string; order: number | null }[]): Promise<void>;
	refreshModels(): Promise<void>;
	refreshModelProviders(): Promise<void>;
	saveCustomProvider(request: UiSaveCustomProviderRequest): Promise<void>;
	removeCustomProvider(provider: string): Promise<void>;
	setModelEnabled(provider: string, modelId: string, enabled: boolean): Promise<void>;
	setModel(provider: string, id: string): Promise<void>;
	setThinkingLevel(level: UiThinkingLevel): Promise<void>;
	refreshProviderAuth(): Promise<void>;
	setProviderApiKey(provider: string, key: string): Promise<void>;
	removeProviderCredential(provider: string): Promise<void>;
	switchSession(path: string): Promise<void>;
	selectSession(cwd: string, path: string): Promise<boolean>;
	selectResidentSession(cwd: string, sessionId: string, sessionPath: string | null): Promise<boolean>;
	send(text: string, behavior?: 'steer' | 'followUp', attachments?: UiAttachment[], inputId?: string): Promise<void>;
	/** Rewind to a sent user message and resend the edited text (zcode-style edit). */
	editMessage(entryId: string, text: string, attachments?: UiAttachment[], fileMode?: 'keep' | 'rewind'): Promise<void>;
	/** Rewind to the latest user message and resend it, keeping the old reply as a branch (3.4). */
	regenerate(replyId?: string): Promise<void>;
	/** Fork the conversation at an assistant message (rewinds the visible branch to it). */
	forkMessage(entryId: string): Promise<void>;
	/** Edit, remove, or steer-early a queued instruction while the agent is busy (Codex-style queue management). */
	updateQueuedMessage(id: string, action: 'edit' | 'remove' | 'steer', text?: string): Promise<void>;
	abort(): Promise<void>;
	newSession(options?: { cwd?: string }): Promise<void>;
	detachProject(): Promise<void>;
	pickWorkspace(options?: { fresh?: boolean }): Promise<void>;
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
let historyLoadRequest = 0;
const MAX_BOOTSTRAP_EVENTS = 256;
const MAX_BOOTSTRAP_RESYNCS = 3;
const SNAPSHOT_TIMEOUT_MS = 15_000;

type ReadyEvent = Extract<AgentUiEvent, { type: 'ready' }>;
interface SessionPreparation {
	bridge: AgentBridge;
	requestId: number;
	kind: 'new' | 'detach';
	options?: { cwd?: string };
	draftScope: UiInputScope;
	failed: boolean;
	ready: ReadyEvent | null;
	reset: boolean;
	promise: Promise<void>;
}
interface PreparedInput {
	bridge: AgentBridge;
	requestId: number;
	id: string;
	text: string;
	message: UiMessage;
	echoed: boolean;
	dispatched: boolean;
	runtimeStatus: AgentStatus | null;
	cancel(): void;
}
let sessionPreparation: SessionPreparation | null = null;
let preparedInput: PreparedInput | null = null;
const recoverableNewDrafts: Array<{ bridge: AgentBridge; cwd?: string; scope: UiInputScope }> = [];

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

// Tracks in-flight session/workspace switches so the chat area can show a
// loading placeholder (logo) instead of the previous conversation while the
// agent host loads the target session.
let activeSessionLoads = 0;
function beginSessionLoadIndicator(set: (partial: Partial<ChatState>) => void): number {
	activeSessionLoads += 1;
	set({ sessionLoading: true });
	return bridgeGeneration;
}
function finishSessionLoadIndicator(set: (partial: Partial<ChatState>) => void, generation: number): void {
	if (generation !== bridgeGeneration) return;
	activeSessionLoads = Math.max(0, activeSessionLoads - 1);
	set({ sessionLoading: activeSessionLoads > 0 });
}

export const useChatStore = create<ChatState>((set, get) => ({
	bridge: null,
	status: 'uninitialized',
	statusMessage: undefined,
	retryAttempt: undefined,
	retryMaxAttempts: undefined,
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
	conversationWorkspaces: [],
	defaultWorkspace: null,
	sessionsByWorkspace: {},
	workspaceSessionRequests: {},
	sessionRuntimes: {},
	sessionId: null,
	sessionPath: null,
	sessions: [],
	messages: [],
	activities: [],
	runs: [],
	timelineRevision: 0,
	historyGeneration: 0,
	historyTotal: 0,
	loadingOlder: false,
	sessionLoading: false,
	queuedCount: 0,
	queuedMessages: [],
	fileChanges: [],
	error: null,
	errorInfo: null,
	appInfo: null,
	navigationRequestId: 0,
	navigationPending: false,
	sessionPreparation: null,
	draftTransfer: null,
	backgroundDraftTransfers: [],

	setBridge(bridge) {
		if (get().bridge === bridge) return;
		sessionOpenMetrics.cancel();
		cancelPreparedInput();
		sessionPreparation = null;
		recoverableNewDrafts.length = 0;
		unsubscribeAgentEvent?.();
		unsubscribeAgentEvent = null;
		bridgeGeneration += 1;
		activeSessionLoads = 0;
		historyLoadRequest += 1;
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
					sessionRuntimes: Object.fromEntries((snapshot.sessionRuntimes ?? []).map((entry) => [sessionRuntimeKey(entry.cwd, entry.path), entry.runtime])),
					statusMessage: snapshot.statusMessage,
					retryAttempt: snapshot.retryAttempt,
					retryMaxAttempts: snapshot.retryMaxAttempts,
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
					runs: snapshot.runs ?? [],
					timelineRevision: get().timelineRevision + 1,
					historyGeneration: get().historyGeneration + 1,
					queuedCount: snapshot.queuedCount,
					queuedMessages: snapshot.queuedMessages ?? [],
					fileChanges: snapshot.fileChanges ?? [],
					historyTotal: snapshot.historyTotal ?? snapshot.messages.length + snapshot.activities.length,
					error: snapshot.error,
					errorInfo: snapshot.errorInfo ?? null,
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
		const preparing = sessionPreparation;
		if (preparing?.failed && get().sessionPreparation?.requestId === preparing.requestId && currentSessionNavigation(bridge, preparing.requestId)) {
			return prepareConversation('new', preparing.options, preparing.draftScope);
		}
		const request = beginSessionNavigation();
		set({ status: 'starting', error: null, statusMessage: undefined, retryAttempt: undefined, retryMaxAttempts: undefined });
		try {
			const target = cwd || workspaces[0] || (await bridge.listWorkspaces())[0];
			if (!currentSessionNavigation(bridge, request)) return;
			if (!target) throw new Error(translate('store.noWorkspaceToRetry'));
			await bridge.initAgent(target);
			sessionOpenMetrics.rpc(request);
		} catch (error) {
			if (!currentSessionNavigation(bridge, request)) return;
			set({ status: 'error', error: errorMessage(error) });
			throw error;
		} finally { finishSessionNavigation(bridge, request); }
	},

	handleEvent(event) {
		const preparing = sessionPreparation;
		if (preparing && get().sessionPreparation?.requestId === preparing.requestId && currentSessionNavigation(preparing.bridge, preparing.requestId)
			&& event.type !== 'session-runtime' && event.type !== 'sessions-changed') {
			// Workspace initialization emits reset/starting/busy before its real
			// draft scope exists. Keep those transient states behind the local view.
			if (event.type === 'reset') { preparing.reset = true; preparing.ready = null; }
			if (event.type === 'ready') preparing.ready = event;
			return;
		}
		switch (event.type) {
			case 'reset':
				resetSettingsRequests();
				historyLoadRequest += 1;
				set({
					status: 'uninitialized',
					statusMessage: undefined,
					retryAttempt: undefined,
					retryMaxAttempts: undefined,
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
					runs: [],
					timelineRevision: get().timelineRevision + 1,
					historyGeneration: get().historyGeneration + 1,
					historyTotal: 0,
					loadingOlder: false,
					queuedCount: 0,
					queuedMessages: [],
					fileChanges: [],
					error: null,
				});
				return;
			case 'status': {
				const pending = currentPreparedInput();
				if (pending?.dispatched) pending.runtimeStatus = event.status;
				const previousStatus = get().status;
				set((state) => ({
					status: event.status, statusMessage: event.message, retryAttempt: event.attempt, retryMaxAttempts: event.maxAttempts,
					...(event.status === 'error' ? {
						runs: state.runs.map(run => run.status === 'running' ? { ...run, status: 'interrupted' as const, finishedAt: null } : run),
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
			case 'ready': {
				sessionOpenMetrics.snapshot(event.cwd, event.sessionPath, event.sessionId, event.resumeKind);
				const previous = get();
				const completedPreparation = previous.sessionPreparation;
				const pending = currentPreparedInput();
				if (pending?.dispatched && event.messages.some(message => message.role === 'user')) pending.echoed = true;
				const messages = pending && !pending.echoed ? [...event.messages, pending.message] : event.messages;
				// A fresh session context clears the view; a same-session resync keeps older pages coming.
				const sameSession = previous.cwd === event.cwd && previous.sessionId === event.sessionId && previous.sessionPath === event.sessionPath;
				if (!sameSession) historyLoadRequest += 1;
				const olderLoaded = sameSession
					? previous.messages.length + previous.activities.length - (event.messages.length + event.activities.length)
					: 0;
				set({
					...(completedPreparation ? { sessionPreparation: null, navigationPending: false,
						draftTransfer: { requestId: completedPreparation.requestId, from: completedPreparation.draftScope,
							to: { cwd: event.cwd, sessionPath: event.sessionPath } }, status: pending ? 'busy' as const : 'idle' as const } : {}),
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
					messages,
					activities: event.activities,
					runs: event.runs ?? [],
					historyTotal: (event.historyTotal ?? event.messages.length + event.activities.length) + (messages.length - event.messages.length),
					timelineRevision: get().timelineRevision + 1,
					historyGeneration: previous.historyGeneration + 1,
					loadingOlder: sameSession && previous.loadingOlder,
					queuedCount: 0,
					queuedMessages: [],
					fileChanges: event.fileChanges ?? [],
					error: null,
				});
				// agent_settled resyncs re-send only the newest window; restore pages the user already opened.
				if (olderLoaded > 0) void get().loadOlderMessages(Math.min(olderLoaded, 500));
				return;
			}
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
			case 'run':
				set(state => ({ runs: mergeConversationRuns(state.runs, [event.run]) }));
				return;
			case 'user-message': {
				const pending = currentPreparedInput();
				// This is the first submitted input in a brand-new session. A slash
				// template may expand its text, so use the submission lifecycle.
				const replacesPending = Boolean(pending?.dispatched && !pending.echoed);
				if (replacesPending) pending!.echoed = true;
				set((s) => ({
					...acceptedSessionTitle(s, event.text),
					messages: [...s.messages.filter(message => !replacesPending || message.id !== pending!.message.id), { id: event.id, order: event.order, runId: event.runId, role: 'user', text: event.text, attachments: event.attachments, attachmentsOmitted: event.attachmentsOmitted, attachmentReferences: event.attachmentReferences, status: 'done' }],
					historyTotal: s.historyTotal + (replacesPending ? 0 : 1),
					timelineRevision: s.timelineRevision + 1,
				}));
				// Refresh only after the accepted message has updated the row. This also
				// supersedes list requests started before the first input was accepted.
				void get().refreshSessions();
				return;
			}
			case 'assistant-start':
				set((s) => ({
					messages: [...s.messages, { id: event.id, order: event.order, runId: event.runId, role: 'assistant', text: '', status: 'streaming' }],
					historyTotal: s.historyTotal + 1,
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
					...(event.errorMessage ? { error: event.errorMessage, errorInfo: event.error ?? null } : {}),
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
					return { activities, ...(index < 0 ? { timelineRevision: s.timelineRevision + 1, historyTotal: s.historyTotal + 1 } : {}) };
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
			case 'session-runtime': {
				set((state) => {
					const sessionRuntimes = { ...state.sessionRuntimes, [sessionRuntimeKey(event.cwd, event.path)]: event.runtime };
					const cached = state.sessionsByWorkspace[event.cwd];
					const sessions = cached ? mergeRuntimeStates(event.cwd, cached, sessionRuntimes) : undefined;
					return { sessionRuntimes, ...(sessions ? { sessionsByWorkspace: { ...state.sessionsByWorkspace, [event.cwd]: sessions }, ...(state.cwd === event.cwd ? { sessions } : {}) } : {}) };
				});
				// A newly persisted background conversation may not have a row yet.
				if (!get().sessionsByWorkspace[event.cwd]?.some((session) => session.path === event.path)) void get().refreshWorkspaceSessions(event.cwd);
				return;
			}
			case 'error':
				set({ error: event.message, errorInfo: event.error ?? null });
				return;
		}
	},

	async refreshSessions() {
		const cwd = get().cwd;
		if (cwd) await get().refreshWorkspaceSessions(cwd);
	},

	async loadOlderMessages(pageSize = 200) {
		const { bridge, cwd, sessionId, sessionPath, navigationRequestId } = get();
		if (!bridge || get().loadingOlder || !Number.isInteger(pageSize) || pageSize < 1) return false;
		if (get().historyTotal <= get().messages.length + get().activities.length) return false;
		const request = ++historyLoadRequest;
		const isCurrentSession = () => {
			const current = get();
			return request === historyLoadRequest && current.bridge === bridge && current.cwd === cwd &&
				current.sessionId === sessionId && current.sessionPath === sessionPath && current.navigationRequestId === navigationRequestId;
		};
		set({ loadingOlder: true });
		try {
			for (let attempt = 0; attempt < 2; attempt += 1) {
				const before = get();
				const remaining = before.historyTotal - before.messages.length - before.activities.length;
				if (remaining <= 0) return false;
				const limit = Math.min(pageSize, remaining, 500);
				const offset = Math.max(0, remaining - limit);
				const page = await bridge.getHistoryPage(offset, limit);
				if (!isCurrentSession()) return false;
				const current = get();
				// Branch replacement invalidates the offset. Retry it once against
				// the fresh window; live appends do not invalidate older entries.
				if (current.historyGeneration !== before.historyGeneration) continue;
				const messages = new Set(current.messages.map((message) => message.id));
				const activities = new Set(current.activities.map((activity) => activity.id));
				const olderMessages = page.messages.filter((message) => !messages.has(message.id));
				const olderActivities = page.activities.filter((activity) => !activities.has(activity.id));
				set({
					messages: [...olderMessages, ...current.messages],
					activities: [...olderActivities, ...current.activities],
					runs: mergeConversationRuns(current.runs, page.runs ?? []),
					historyTotal: Math.max(current.historyTotal, page.total),
					timelineRevision: current.timelineRevision + 1,
				});
				return olderMessages.length + olderActivities.length > 0;
			}
			set({ error: translate('store.historyChanged') });
			return false;
		} catch (error) {
			if (isCurrentSession()) set({ error: errorMessage(error) });
			return false;
		} finally {
			if (request === historyLoadRequest) set({ loadingOlder: false });
		}
	},

	async refreshWorkspaces() {
		const bridge = get().bridge;
		if (!bridge) return;
		const request = ++workspacesRequest;
		const navigationRequest = get().navigationRequestId;
		try {
			const [workspaces, automaticDirectories, defaultWorkspace] = await Promise.all([
				bridge.listWorkspaces(),
				bridge.listConversationWorkspaces?.() ?? null,
				bridge.getDefaultWorkspace?.() ?? null,
			]);
			const conversationWorkspaces = automaticDirectories ?? (defaultWorkspace ? [defaultWorkspace] : []);
			if (get().bridge !== bridge || request !== workspacesRequest) return;
			const current = get().cwd;
			set({ workspaces: current && !workspaces.includes(current) ? [current, ...workspaces] : workspaces, conversationWorkspaces, defaultWorkspace });
		} catch (error) {
			if (request === workspacesRequest && currentSessionNavigation(bridge, navigationRequest)) set({ error: errorMessage(error) });
		}
	},

	refreshWorkspaceSessions: (cwd) => refreshSessionCache(cwd),

	async switchWorkspace(cwd, options) {
		const bridge = get().bridge;
		if (!bridge || !cwd || (cwd === get().cwd && !get().navigationPending && !options?.fresh && !options?.force)) return;
		const request = beginSessionNavigation({ cwd });
		try {
			await bridge.switchWorkspace(cwd, options?.fresh === undefined ? undefined : { fresh: options.fresh });
			sessionOpenMetrics.rpc(request);
			if (!currentSessionNavigation(bridge, request)) return;
			await Promise.all([get().refreshWorkspaces(), get().refreshWorkspaceSessions(cwd)]);
		} catch (error) {
			if (currentSessionNavigation(bridge, request)) set({ error: errorMessage(error) });
			throw error;
		} finally { finishSessionNavigation(bridge, request); }
	},

	async removeWorkspace(cwd) {
		const bridge = get().bridge;
		if (!bridge || !cwd) return;
		if (cwd === get().cwd) {
			// Keep the next conversation separate from the project being removed.
			await get().newSession();
		}
		try {
			await bridge.removeWorkspace(cwd);
		} catch (error) {
			if (get().bridge === bridge) set({ error: errorMessage(error) });
			throw error;
		}
		if (get().bridge !== bridge) return;
		sessionListRequests.set(cwd, (sessionListRequests.get(cwd) ?? 0) + 1);
		set((state) => ({
			workspaces: state.workspaces.filter((path) => path !== cwd),
			sessionsByWorkspace: Object.fromEntries(Object.entries(state.sessionsByWorkspace).filter(([path]) => path !== cwd)),
			workspaceSessionRequests: Object.fromEntries(Object.entries(state.workspaceSessionRequests).filter(([path]) => path !== cwd)),
			sessionRuntimes: Object.fromEntries(Object.entries(state.sessionRuntimes).filter(([key]) => !key.startsWith(`${JSON.stringify([cwd]).slice(0, -1)},`))),
		}));
		await get().refreshWorkspaces();
	},

	async updateSessionMeta(path, patch) {
		const { bridge, cwd, sessionId, navigationRequestId } = get();
		if (!bridge) return;
		const workspace = Object.entries(get().sessionsByWorkspace).find(([, sessions]) => sessions.some((session) => session.path === path))?.[0] ?? cwd;
		const isCurrent = () => currentSessionNavigation(bridge, navigationRequestId) && get().cwd === cwd && get().sessionId === sessionId;
		// zcode setOverlay semantics: boolean flags flip in the cached lists
		// immediately, persistence converges through the authoritative refetch,
		// and a failed write restores the captured rows (runtime events merge
		// onto cached entries, so an in-flight overlay survives them).
		const overlay = applySessionMetaOverlay(path, patch);
		try {
			// Editors own mutation errors and retain their drafts. Do not turn a
			// failed title/metadata edit into a chat failure, especially after switching.
			await bridge.updateSessionMeta(path, patch);
		} catch (error) {
			restoreSessionMetaOverlay(overlay);
			throw error;
		}
		if (get().bridge !== bridge) return;
		if (workspace) await refreshSessionCache(workspace, isCurrent());
	},

	async deleteSession(path) {
		const { bridge } = get();
		if (!bridge || !path) return;
		set({ error: null });
		try {
			// The main process rejects deleting the open session; switch to a fresh one first.
			if (get().sessionPath === path) await get().newSession();
			await bridge.deleteSession(path);
			set((state) => ({
				sessionsByWorkspace: Object.fromEntries(Object.entries(state.sessionsByWorkspace)
					.map(([workspace, sessions]) => [workspace, sessions.filter((session) => session.path !== path)])),
				sessions: state.sessions.filter((session) => session.path !== path),
			}));
			const workspace = Object.keys(get().sessionsByWorkspace).find((cwd) => cwd === get().cwd);
			if (workspace) await get().refreshWorkspaceSessions(workspace);
		} catch (error) {
			set({ error: errorMessage(error) });
			throw error;
		}
	},
	
	async deleteSessions(paths, options) {
		const { bridge } = get();
		const targets = [...new Set(paths)].filter(Boolean);
		if (!bridge || !targets.length) return { deleted: [], failed: {}, skipped: {} };
		set({ error: null });
		const failed: Record<string, string> = {};
		const skipped: Record<string, string> = {};
		const deleted: string[] = [];
		const dropFromCache = (path: string) => set((state) => ({
			sessionsByWorkspace: Object.fromEntries(Object.entries(state.sessionsByWorkspace)
				.map(([workspace, sessions]) => [workspace, sessions.filter((session) => session.path !== path)])),
			sessions: state.sessions.filter((session) => session.path !== path),
		}));
		try {
			// zcode deleteArchivedTask guards on archived===1 inside the delete transaction:
			// the selection may go stale while the confirmation sits open. Re-validate the
			// whole selection against one authoritative listSessions snapshot up front and
			// report changed paths as skipped instead of hard-failing them.
			let candidates = targets;
			if (options?.expectArchived) {
				const workspace = get().cwd;
				const sessions = await bridge.listSessions(workspace);
				const byPath = new Map(sessions.map((session) => [session.path, session]));
				candidates = targets.filter((path) => {
					const session = byPath.get(path);
					if (!session) { skipped[path] = '会话已不存在'; return false; }
					if (!session.archived) { skipped[path] = '会话已移出归档'; return false; }
					return true;
				});
			}
			// zcode deleteArchivedTasks: per-item deletion stays sequential and independent —
			// one failure must neither roll back earlier successes nor hide later ones.
			if (candidates.includes(get().sessionPath ?? '')) await get().newSession();
			for (const path of candidates) {
				try {
					await bridge.deleteSession(path);
					deleted.push(path);
					dropFromCache(path);
				} catch (cause) { failed[path] = cause instanceof Error ? cause.message : String(cause); }
			}
			// One refresh for the whole batch instead of one per deletion (zcode emits a
			// single workspace event after the batch loop, not one per item).
			const workspace = Object.keys(get().sessionsByWorkspace).find((cwd) => cwd === get().cwd);
			if (workspace) await get().refreshWorkspaceSessions(workspace);
		} catch (error) {
			set({ error: errorMessage(error) });
		}
		return { deleted, failed, skipped };
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

	async setModelEnabled(provider, modelId, enabled) {
		await updateCustomProvider((bridge) => bridge.setModelEnabled(provider, modelId, enabled));
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
		const request = beginSessionNavigation({ cwd: get().cwd, path });
		const loadingGeneration = beginSessionLoadIndicator(set);
		try {
			await bridge.switchSession(path);
			sessionOpenMetrics.rpc(request);
			if (!currentSessionNavigation(bridge, request)) return;
			await get().refreshSessions();
		} catch (error) {
			if (currentSessionNavigation(bridge, request)) set({ error: errorMessage(error) });
			throw error;
		} finally { finishSessionNavigation(bridge, request); finishSessionLoadIndicator(set, loadingGeneration); }
	},

	async selectResidentSession(cwd, sessionId, sessionPath) {
		const bridge = get().bridge;
		if (!bridge?.activateResidentSession) return false;
		const request = beginSessionNavigation({ cwd, path: sessionPath, sessionId });
		const generation = beginSessionLoadIndicator(set);
		try {
			const selected = await bridge.activateResidentSession({ cwd, sessionId, sessionPath });
			sessionOpenMetrics.rpc(request);
			if (!currentSessionNavigation(bridge, request)) return false;
			if (!selected) sessionOpenMetrics.cancel(request);
			if (selected) void Promise.all([get().refreshWorkspaces(), get().refreshWorkspaceSessions(cwd)]);
			return selected;
		} catch (error) {
			if (currentSessionNavigation(bridge, request)) set({ error: errorMessage(error) });
			throw error;
		} finally { finishSessionNavigation(bridge, request); finishSessionLoadIndicator(set, generation); }
	},

	async selectSession(cwd, path) {
		const bridge = get().bridge;
		if (!bridge || !cwd || !path) return false;
		const request = beginSessionNavigation({ cwd, path });
		const loadingGeneration = beginSessionLoadIndicator(set);
		const workspaceChanged = get().cwd !== cwd;
		try {
			if (workspaceChanged) {
				await bridge.switchWorkspace(cwd);
				if (!currentSessionNavigation(bridge, request)) return false;
			}
			await bridge.switchSession(path);
			sessionOpenMetrics.rpc(request);
			if (!currentSessionNavigation(bridge, request)) return false;
			await Promise.all([get().refreshWorkspaceSessions(cwd), ...(workspaceChanged ? [get().refreshWorkspaces()] : [])]);
			return currentSessionNavigation(bridge, request);
		} catch (error) {
			if (!currentSessionNavigation(bridge, request)) return false;
			set({ error: errorMessage(error) });
			throw error;
		} finally { finishSessionNavigation(bridge, request); finishSessionLoadIndicator(set, loadingGeneration); }
	},

	async send(text, behavior, attachments, inputId) {
		const preparing = sessionPreparation;
		if (preparing && get().sessionPreparation?.requestId === preparing.requestId && currentSessionNavigation(preparing.bridge, preparing.requestId)) {
			if (preparing.failed) throw new Error(get().error ?? translate('store.agentNotReady'));
			return sendAfterPreparation(preparing, text, behavior, attachments, inputId);
		}
		const { bridge, status, cwd, sessionId, navigationPending, sessionLoading } = get();
		const trimmed = text.trim();
		if (!bridge || (!trimmed && !attachments?.length)) return;
		const command = parseSlashCommand(trimmed);
		// A new-session command is itself navigation; ordinary input must stay
		// with its visible draft until the selected conversation is ready.
		if (status !== 'idle' && status !== 'busy' || (navigationPending || sessionLoading) && command?.name !== 'new') {
			const error = new Error(translate('store.agentNotReady'));
			set({ error: error.message });
			throw error;
		}
		set({ error: null });
		let navigationRequest: number | undefined;
		try {
			const delivery = inputId ? behavior : behavior ?? (status === 'busy' ? 'followUp' : undefined);
			if (command) {
				if (!sessionId) throw new Error(translate('store.agentNotReady'));
				if (command.name === 'new') navigationRequest = beginSessionNavigation();
				await bridge.executeSlashCommand({ cwd, sessionId, ...command, behavior: delivery, attachments });
				if (navigationRequest !== undefined) sessionOpenMetrics.rpc(navigationRequest);
			} else if (inputId && 'submitInput' in bridge && typeof bridge.submitInput === 'function') {
				const receipt = await bridge.submitInput({ id: inputId, sessionId: sessionId ?? '', text: trimmed, behavior: delivery, attachments });
				if (receipt.state === 'recovered' || receipt.state === 'failed' || receipt.state === 'reserved') throw new Error(receipt.message ?? translate('store.inputNeedsConfirmation'));
			} else await bridge.prompt(trimmed, delivery, attachments);
		} catch (error) {
			if (get().bridge === bridge && get().cwd === cwd && get().sessionId === sessionId
				&& (navigationRequest === undefined || currentSessionNavigation(bridge, navigationRequest))) set({ error: errorMessage(error) });
			throw error;
		} finally { if (navigationRequest !== undefined) finishSessionNavigation(bridge, navigationRequest); }
	},

	async editMessage(entryId, text, attachments, fileMode) {
		const { bridge, status, cwd, sessionId } = get();
		const trimmed = text.trim();
		const original = get().messages.find((message) => message.id === entryId);
		if (!bridge || (!trimmed && !attachments?.length && !original?.attachmentsOmitted)) return;
		if (status !== 'idle') {
			const error = new Error(translate('store.sessionBusy'));
			set({ error: error.message });
			throw error;
		}
		set({ error: null });
		try {
			const message = get().messages.find((entry) => entry.id === entryId);
			// An incomplete history preview is not an edited attachment list.
			await bridge.editMessage(entryId, trimmed, message?.attachmentsOmitted ? undefined : attachments, ...(fileMode ? [fileMode] : []));
		} catch (error) {
			if (get().bridge === bridge && get().cwd === cwd && get().sessionId === sessionId) set({ error: errorMessage(error) });
			throw error;
		}
	},

	async regenerate(replyId) {
		// Rewind to the latest user message and resend it verbatim; editMessage reuses navigateTree.
		const messages = get().messages;
		if (replyId) {
			const replyIndex = messages.findIndex((message) => message.id === replyId && message.role === 'assistant');
			if (replyIndex < 0 || messages.slice(replyIndex + 1).some((message) => message.role === 'user')) throw new Error(translate('store.nothingToRegenerate'));
		}
		for (let i = messages.length - 1; i >= 0; i -= 1) {
			const message = messages[i]!;
			if (message.role === 'user' && (message.text.trim() || message.attachments?.length || message.attachmentsOmitted)) {
				await get().editMessage(message.id, message.text, message.attachments);
				return;
			}
		}
		const error = new Error(translate('store.nothingToRegenerate'));
		set({ error: error.message });
		throw error;
	},

	async forkMessage(entryId) {
		const { bridge, status, cwd, sessionId } = get();
		if (!bridge || !entryId) return;
		if (status !== 'idle') {
			const error = new Error(translate('store.sessionBusy'));
			set({ error: error.message });
			throw error;
		}
		set({ error: null });
		try {
			await bridge.forkAssistantMessage(entryId);
		} catch (error) {
			if (get().bridge === bridge && get().cwd === cwd && get().sessionId === sessionId) set({ error: errorMessage(error) });
			throw error;
		}
	},

	async updateQueuedMessage(id, action, text) {
		const { bridge, cwd, sessionId } = get();
		if (!bridge || !id) return;
		const trimmed = action === 'edit' ? (text ?? '').trim() : undefined;
		set({ error: null });
		try {
			await bridge.updateQueuedMessage(id, action, trimmed);
		} catch (error) {
			if (get().bridge === bridge && get().cwd === cwd && get().sessionId === sessionId) set({ error: errorMessage(error) });
			throw error;
		}
	},

	async abort() {
		if (get().sessionPreparation && currentPreparedInput()) {
			cancelPreparedInput();
			set({ status: 'idle', error: null });
			return;
		}
		const { bridge, cwd, sessionId, navigationRequestId, navigationPending, sessionLoading } = get();
		if (!bridge || navigationPending || sessionLoading) return;
		set({ error: null });
		try {
			await bridge.abort();
		} catch (error) {
			if (bridge && currentSessionNavigation(bridge, navigationRequestId) && get().cwd === cwd && get().sessionId === sessionId) set({ error: errorMessage(error) });
		}
	},

	async newSession(options) {
		const preparing = sessionPreparation;
		if (preparing?.kind === 'new' && preparing.options?.cwd === options?.cwd
			&& get().sessionPreparation?.requestId === preparing.requestId && currentSessionNavigation(preparing.bridge, preparing.requestId)) {
			return preparing.failed ? prepareConversation('new', options, preparing.draftScope) : preparing.promise;
		}
		const saved = recoverableNewDrafts.findIndex(draft => draft.bridge === get().bridge && draft.cwd === options?.cwd);
		const scope = saved < 0 ? undefined : recoverableNewDrafts.splice(saved, 1)[0]!.scope;
		return prepareConversation('new', options, scope);
	},

	async detachProject() {
		if (get().navigationPending) return;
		return prepareConversation('detach');
	},

	async pickWorkspace(options) {
		const bridge = get().bridge;
		if (!bridge) return;
		const request = beginSessionNavigation();
		try {
			const cwd = await bridge.pickWorkspace();
			if (!currentSessionNavigation(bridge, request)) return;
			if (!cwd) sessionOpenMetrics.cancel(request);
			if (cwd) {
				await bridge.switchWorkspace(cwd, options);
				sessionOpenMetrics.rpc(request);
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

function prepareConversation(kind: SessionPreparation['kind'], options?: { cwd?: string }, retainedScope?: UiInputScope): Promise<void> {
	const previous = useChatStore.getState(), bridge = previous.bridge;
	if (!bridge) return Promise.resolve();
	const generation = bridgeGeneration;
	const request = beginSessionNavigation({ cwd: options?.cwd }, retainedScope);
	// A local draft must never hydrate the previous conversation's input, even
	// when creating another conversation inside the same project.
	const draftScope = retainedScope ?? (kind === 'detach' ? { cwd: previous.cwd, sessionPath: previous.sessionPath }
		: { cwd: options?.cwd ?? '', sessionPath: `draft:${crypto.randomUUID()}` });
	const preparing: SessionPreparation = { bridge, requestId: request, kind, options, draftScope, failed: false,
		ready: null, reset: false, promise: Promise.resolve() };
	const preserveBackgroundDraft = (receipt: UiInputScope | void): void => {
		if (kind !== 'new' || !receipt || generation !== bridgeGeneration || useChatStore.getState().bridge !== bridge) return;
		useChatStore.setState(state => ({ backgroundDraftTransfers: [...state.backgroundDraftTransfers,
			{ requestId: request, from: draftScope, to: { cwd: receipt.cwd, sessionPath: receipt.sessionPath } }] }));
	};
	// Assign the waiting promise before publishing the draft. The microtask also
	// keeps synchronous bridge callbacks behind the complete local state change.
	preparing.promise = Promise.resolve().then(async () => {
		try {
			if (!currentSessionNavigation(bridge, request)) return;
			const receipt = await bridge.newSession(options);
			sessionOpenMetrics.rpc(request);
			if (!currentSessionNavigation(bridge, request)) { preserveBackgroundDraft(receipt); return; }
			if (!preparing.ready) {
				const snapshot = await snapshotWithTimeout(bridge);
				if (!snapshot.sessionId || snapshot.status === 'error') throw new Error(snapshot.error ?? translate('store.agentNotReady'));
				preparing.ready = { ...snapshot, type: 'ready', sessionId: snapshot.sessionId };
			}
			if (!currentSessionNavigation(bridge, request)) { preserveBackgroundDraft(receipt); return; }
			sessionPreparation = null;
			// Transfer input only after the backend has activated its real scope.
			useChatStore.getState().handleEvent(preparing.ready);
			void Promise.all([useChatStore.getState().refreshWorkspaces(), useChatStore.getState().refreshSessions()]);
		} catch (error) {
			if (!currentSessionNavigation(bridge, request)) {
				// 已切走且初始化失败的草稿，下次对相同目标点“新建”时继续恢复；绝不自动发送。
				// Recover an abandoned failed draft on the next New action for this target.
				if (kind === 'new' && generation === bridgeGeneration && useChatStore.getState().bridge === bridge) {
					rememberRecoverableNewDraft(preparing);
				}
				throw error;
			}
			if (kind === 'detach' && preparing.ready) {
				sessionPreparation = null;
				useChatStore.getState().handleEvent(preparing.ready);
				useChatStore.setState({ status: 'idle', error: errorMessage(error) });
			} else if (kind === 'new') {
				// Keep the new input editable; Retry reuses this exact draft and target.
				preparing.failed = true;
				useChatStore.setState({ status: 'error', error: errorMessage(error), navigationPending: false });
			} else {
				sessionPreparation = null;
				useChatStore.setState(state => ({ ...conversationView(previous), sessionPreparation: null, navigationPending: false,
					...(preparing.reset ? { status: 'error' as const } : {}), error: errorMessage(error),
					timelineRevision: state.timelineRevision + 1, historyGeneration: state.historyGeneration + 1 }));
			}
			throw error;
		} finally {
			if (sessionPreparation === preparing && !preparing.failed) sessionPreparation = null;
			finishSessionNavigation(bridge, request);
		}
	});
	sessionPreparation = preparing;
	useChatStore.setState(state => ({ sessionPreparation: { requestId: request, draftScope }, cwd: options?.cwd ?? '', sessionId: null, sessionPath: null,
		status: 'idle', statusMessage: undefined, retryAttempt: undefined, retryMaxAttempts: undefined,
		messages: [], activities: [], runs: [], fileChanges: [], contextUsage: null,
		queuedMessages: [], queuedCount: 0, historyTotal: 0, loadingOlder: false, sessionLoading: false,
		timelineRevision: state.timelineRevision + 1, historyGeneration: state.historyGeneration + 1 }));
	return preparing.promise;
}

function conversationView(state: ChatState): Partial<ChatState> {
	const { cwd, sessionId, sessionPath, status, statusMessage, messages, activities, runs, fileChanges,
		contextUsage, queuedMessages, queuedCount, historyTotal, model, modelName, modelProvider, thinkingLevel,
		availableThinkingLevels, sessions, retryAttempt, retryMaxAttempts } = state;
	return { cwd, sessionId, sessionPath, status, statusMessage, messages, activities, runs, fileChanges,
		contextUsage, queuedMessages, queuedCount, historyTotal, model, modelName, modelProvider, thinkingLevel,
		availableThinkingLevels, sessions, retryAttempt, retryMaxAttempts };
}

function currentPreparedInput(): PreparedInput | null {
	return preparedInput && currentSessionNavigation(preparedInput.bridge, preparedInput.requestId) ? preparedInput : null;
}

function cancelledSubmission(): Error {
	return Object.assign(new Error('已取消等待发送'), { name: 'AbortError' });
}

function removePreparedMessage(input: PreparedInput): void {
	useChatStore.setState(state => {
		const messages = state.messages.filter(message => message.id !== input.message.id);
		return messages.length === state.messages.length ? {} : {
			messages, historyTotal: Math.max(0, state.historyTotal - 1), timelineRevision: state.timelineRevision + 1,
		};
	});
}

function cancelPreparedInput(): void {
	const input = preparedInput;
	preparedInput = null;
	if (!input) return;
	if (!input.dispatched) input.cancel();
	removePreparedMessage(input);
}

async function sendAfterPreparation(preparing: SessionPreparation, text: string, behavior?: 'steer' | 'followUp', attachments?: UiAttachment[], inputId?: string): Promise<void> {
	const trimmed = text.trim();
	if (!trimmed && !attachments?.length) return;
	if (currentPreparedInput()) throw new Error(translate('store.sessionBusy'));
	const id = inputId ?? crypto.randomUUID();
	let cancel!: () => void;
	const cancelled = new Promise<never>((_resolve, reject) => { cancel = () => reject(cancelledSubmission()); });
	const input: PreparedInput = { bridge: preparing.bridge, requestId: preparing.requestId, id, text: trimmed,
		message: { id: `pending:${id}`, order: 0, role: 'user', text: trimmed, attachments, status: 'done' },
		echoed: false, dispatched: false, runtimeStatus: null, cancel };
	preparedInput = input;
	useChatStore.setState(state => ({ messages: [...state.messages, input.message], status: 'busy', error: null,
		historyTotal: state.historyTotal + 1, timelineRevision: state.timelineRevision + 1 }));
	try {
		await Promise.race([preparing.promise, cancelled]);
		if (preparedInput !== input || !currentSessionNavigation(input.bridge, input.requestId)) throw cancelledSubmission();
		input.dispatched = true;
		await useChatStore.getState().send(trimmed, behavior, attachments, id);
		if (parseSlashCommand(trimmed) && !input.echoed) {
			removePreparedMessage(input);
			if (preparedInput === input) preparedInput = null;
			finishPreparedBusy(input);
		}
	} catch (error) {
		removePreparedMessage(input);
		if (preparedInput === input) preparedInput = null;
		finishPreparedBusy(input);
		throw error;
	} finally {
		if (preparedInput === input && (input.echoed || !input.dispatched)) preparedInput = null;
	}
}

function finishPreparedBusy(input: PreparedInput): void {
	if (currentSessionNavigation(input.bridge, input.requestId) && input.runtimeStatus !== 'busy' && useChatStore.getState().status === 'busy') {
		useChatStore.setState({ status: 'idle' });
	}
}

function acceptedSessionTitle(state: ChatState, text: string): Partial<ChatState> {
	const { cwd, sessionPath: path, sessionId: id } = state;
	if (!cwd || !path || !id || !text.trim() || state.messages.some((message) => message.role === 'user' && message.id !== currentPreparedInput()?.message.id)) return {};
	const cached = state.sessionsByWorkspace[cwd] ?? state.sessions;
	const existing = cached.find((session) => session.path === path && session.id === id);
	if (existing?.firstMessage.trim() && existing.messageCount > 0) return {};
	// Use the accepted event, never the editable draft or a delayed prompt promise.
	// Keep an explicit name and sidebar metadata intact; only fill the fallback title.
	const entry: UiSessionSummary = { ...existing, path, id, firstMessage: text,
		modified: new Date().toISOString(), messageCount: Math.max(existing?.messageCount ?? 0, 1) };
	const sessions = [...cached.filter((session) => session.path !== path), entry];
	return { sessions, sessionsByWorkspace: { ...state.sessionsByWorkspace, [cwd]: sessions } };
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
	useChatStore.setState((state) => ({ workspaceSessionRequests: { ...state.workspaceSessionRequests,
		[cwd]: { phase: Object.hasOwn(state.sessionsByWorkspace, cwd) ? 'refreshing' : 'loading', requestId: request } } }));
	try {
		const sessions = await bridge.listSessions(cwd);
		if (useChatStore.getState().bridge !== bridge || sessionListRequests.get(cwd) !== request) return;
		useChatStore.setState((state) => {
			const merged = mergeRuntimeStates(cwd, sessions, state.sessionRuntimes);
			return { sessionsByWorkspace: { ...state.sessionsByWorkspace, [cwd]: merged },
				workspaceSessionRequests: { ...state.workspaceSessionRequests, [cwd]: { phase: 'idle', requestId: request } },
				...(state.cwd === cwd ? { sessions: merged } : {}) };
		});
	} catch (error) {
		if (useChatStore.getState().bridge !== bridge || sessionListRequests.get(cwd) !== request) return;
		useChatStore.setState((state) => ({ workspaceSessionRequests: { ...state.workspaceSessionRequests, [cwd]: { phase: 'error', requestId: request, error: errorMessage(error) } } }));
		if (reportError && currentSessionNavigation(bridge, navigationRequestId) && sessionListRequests.get(cwd) === request) useChatStore.setState({ error: errorMessage(error) });
	}
}
/** Cached rows captured before an optimistic metadata overlay; [] when nothing was flipped. */
type SessionMetaOverlay = { workspace: string; entry: UiSessionSummary }[];

/**
 * Flip boolean metadata flags across every cached workspace list at once
 * (zcode setOverlay): the sidebar re-filters instantly while persistence is
 * still in flight. Name and order edits keep their non-optimistic flow.
 */
function applySessionMetaOverlay(path: string, patch: UiSessionMetaPatch): SessionMetaOverlay {
	const flags = (['pinned', 'archived', 'unread'] as const).filter((key) => typeof patch[key] === 'boolean');
	if (!flags.length) return [];
	const overlay: SessionMetaOverlay = [];
	useChatStore.setState((state) => {
		let changed = false;
		const sessionsByWorkspace = { ...state.sessionsByWorkspace };
		for (const [workspace, sessions] of Object.entries(state.sessionsByWorkspace)) {
			const index = sessions.findIndex((session) => session.path === path);
			if (index < 0) continue;
			overlay.push({ workspace, entry: sessions[index]! });
			const entry: UiSessionSummary = { ...sessions[index]! };
			for (const key of flags) entry[key] = patch[key];
			const next = [...sessions];
			next[index] = entry;
			sessionsByWorkspace[workspace] = next;
			changed = true;
		}
		if (!changed) return state;
		return { sessionsByWorkspace, ...(state.cwd && sessionsByWorkspace[state.cwd] ? { sessions: sessionsByWorkspace[state.cwd] } : {}) };
	});
	return overlay;
}

/**
 * Roll an optimistic overlay back after a failed write: restore the captured
 * rows verbatim (the write never reached the main process). Lists that no
 * longer hold the session — deleted or refreshed meanwhile — are left alone.
 */
function restoreSessionMetaOverlay(overlay: SessionMetaOverlay): void {
	if (!overlay.length) return;
	useChatStore.setState((state) => {
		let changed = false;
		const sessionsByWorkspace = { ...state.sessionsByWorkspace };
		for (const { workspace, entry } of overlay) {
			const sessions = sessionsByWorkspace[workspace];
			if (!sessions?.some((session) => session.path === entry.path)) continue;
			sessionsByWorkspace[workspace] = sessions.map((session) => session.path === entry.path ? entry : session);
			changed = true;
		}
		if (!changed) return state;
		return { sessionsByWorkspace, ...(state.cwd && sessionsByWorkspace[state.cwd] ? { sessions: sessionsByWorkspace[state.cwd] } : {}) };
	});
}


function sameInputScope(first: UiInputScope, second?: UiInputScope): boolean {
	return first.cwd === second?.cwd && first.sessionPath === second?.sessionPath;
}

function rememberRecoverableNewDraft(preparing: SessionPreparation): void {
	if (!recoverableNewDrafts.some(draft => draft.bridge === preparing.bridge && sameInputScope(draft.scope, preparing.draftScope))) {
		recoverableNewDrafts.push({ bridge: preparing.bridge, cwd: preparing.options?.cwd, scope: preparing.draftScope });
	}
}

function beginSessionNavigation(target: { cwd?: string; path?: string | null; sessionId?: string } = {}, retainedDraftScope?: UiInputScope): number {
	const abandoned = sessionPreparation;
	if (abandoned?.kind === 'new' && abandoned.failed && useChatStore.getState().sessionPreparation?.requestId === abandoned.requestId
		&& currentSessionNavigation(abandoned.bridge, abandoned.requestId) && !sameInputScope(abandoned.draftScope, retainedDraftScope)) {
		rememberRecoverableNewDraft(abandoned);
	}
	cancelPreparedInput();
	const request = useChatStore.getState().navigationRequestId + 1;
	const state = useChatStore.getState(), bridge = state.bridge;
	sessionOpenMetrics.begin(request, target, event => { void Promise.resolve().then(() => bridge?.recordUiDiagnostic?.(event)).catch(() => {}); },
		state.sessionId ? { cwd: state.cwd, path: state.sessionPath, sessionId: state.sessionId } : undefined);
	useChatStore.setState({ navigationRequestId: request, navigationPending: true, sessionPreparation: null, draftTransfer: null, error: null });
	return request;
}

function currentSessionNavigation(bridge: AgentBridge, request: number): boolean {
	const state = useChatStore.getState();
	return state.bridge === bridge && state.navigationRequestId === request;
}

function finishSessionNavigation(bridge: AgentBridge, request: number): void {
	if (currentSessionNavigation(bridge, request)) {
		const state = useChatStore.getState();
		if (state.sessionId && !state.error) sessionOpenMetrics.reuseSnapshot(request, state.cwd, state.sessionPath, state.sessionId);
		sessionOpenMetrics.settled(request, Boolean(state.error) || state.status === 'error');
		useChatStore.setState({ navigationPending: false });
	}
}

/** Convenience selector: is the agent currently producing output? */
export const selectBusy = (s: ChatState): boolean =>
	s.status === 'busy' || s.status === 'starting';

/** A ready session carries its restored timeline; status alone can arrive first. */
export const selectStartupReady = (s: ChatState): boolean =>
	s.status === 'error' || (s.sessionId !== null && (s.status === 'idle' || s.status === 'busy'));
