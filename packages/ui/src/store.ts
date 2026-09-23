/**
 * @pidesktop/ui — renderer-side chat store (zustand).
 *
 * Consumes the normalized AgentUiEvent stream through an injected AgentBridge
 * so the UI package stays independent of Electron specifics (same pattern as
 * ZCode's packages/ui + packages/client split).
 */

import { create } from 'zustand';
import type {
	AgentBridge,
	AgentEventEnvelope,
	AgentSnapshot,
	AgentStatus,
	AgentUiEvent,
	AppInfo,
	UiMessage,
	UiModelSummary,
	UiProviderAuthStatus,
	UiSessionSummary,
	UiThinkingLevel,
	UiToolActivity,
} from '@pidesktop/shared';

interface ChatState {
	bridge: AgentBridge | null;
	status: AgentStatus;
	statusMessage: string | undefined;
	model: string;
	modelProvider: string;
	thinkingLevel: UiThinkingLevel | '';
	availableThinkingLevels: UiThinkingLevel[];
	models: UiModelSummary[];
	providerAuth: UiProviderAuthStatus[];
	settingsLoading: boolean;
	settingsError: string | null;
	cwd: string;
	sessionId: string | null;
	sessionPath: string | null;
	sessions: UiSessionSummary[];
	messages: UiMessage[];
	activities: UiToolActivity[];
	queuedCount: number;
	error: string | null;
	appInfo: AppInfo | null;

	setBridge(bridge: AgentBridge): void;
	handleEvent(event: AgentUiEvent): void;
	refreshSessions(): Promise<void>;
	refreshModels(): Promise<void>;
	setModel(provider: string, id: string): Promise<void>;
	setThinkingLevel(level: UiThinkingLevel): Promise<void>;
	refreshProviderAuth(): Promise<void>;
	setProviderApiKey(provider: string, key: string): Promise<void>;
	removeProviderCredential(provider: string): Promise<void>;
	switchSession(path: string): Promise<void>;
	send(text: string, behavior?: 'steer' | 'followUp'): Promise<void>;
	abort(): Promise<void>;
	newSession(): Promise<void>;
	pickWorkspace(): Promise<void>;
}

let sessionListRequest = 0;
let settingsRequestCount = 0;

function beginSettingsRequest(): void {
	settingsRequestCount += 1;
	useChatStore.setState({ settingsLoading: true, settingsError: null });
}

function endSettingsRequest(): void {
	settingsRequestCount = Math.max(0, settingsRequestCount - 1);
	useChatStore.setState({ settingsLoading: settingsRequestCount > 0 });
}

export const useChatStore = create<ChatState>((set, get) => ({
	bridge: null,
	status: 'uninitialized',
	statusMessage: undefined,
	model: '',
	modelProvider: '',
	thinkingLevel: '',
	availableThinkingLevels: [],
	models: [],
	providerAuth: [],
	settingsLoading: false,
	settingsError: null,
	cwd: '',
	sessionId: null,
	sessionPath: null,
	sessions: [],
	messages: [],
	activities: [],
	queuedCount: 0,
	error: null,
	appInfo: null,

	setBridge(bridge) {
		if (get().bridge === bridge) return;
		set({ bridge });
		let bootstrapping = true;
		const buffered: AgentEventEnvelope[] = [];
		bridge.onAgentEvent((envelope) => {
			if (bootstrapping) buffered.push(envelope);
			else get().handleEvent(envelope.event);
		});
		void bridge.getAgentSnapshot()
			.then((snapshot: AgentSnapshot) => {
				set({
					status: snapshot.status,
					statusMessage: snapshot.statusMessage,
					model: snapshot.model,
					modelProvider: snapshot.modelProvider,
					thinkingLevel: snapshot.thinkingLevel,
					availableThinkingLevels: snapshot.availableThinkingLevels,
					cwd: snapshot.cwd,
					sessionId: snapshot.sessionId,
					sessionPath: snapshot.sessionPath,
					messages: snapshot.messages,
					activities: snapshot.activities,
					queuedCount: snapshot.queuedCount,
					error: snapshot.error,
				});
				bootstrapping = false;
				for (const envelope of buffered) {
					if (envelope.sequence > snapshot.sequence) get().handleEvent(envelope.event);
				}
				void get().refreshSessions();
			})
			.catch((error: unknown) => {
				bootstrapping = false;
				set({ error: errorMessage(error), status: 'error' });
				for (const envelope of buffered) get().handleEvent(envelope.event);
			});
		void bridge
			.getAppInfo()
			.then((appInfo) => set({ appInfo }))
			.catch(() => {});
	},

	handleEvent(event) {
		switch (event.type) {
			case 'reset':
				set({
					status: 'uninitialized',
					statusMessage: undefined,
					model: '',
					modelProvider: '',
					thinkingLevel: '',
					availableThinkingLevels: [],
					models: [],
					providerAuth: [],
					cwd: event.cwd,
					sessionId: null,
					sessionPath: null,
					sessions: [],
					messages: [],
					activities: [],
					queuedCount: 0,
					error: null,
				});
				return;
			case 'status':
				set({ status: event.status, statusMessage: event.message });
				if (event.status === 'idle') void get().refreshSessions();
				return;
			case 'ready':
				// A fresh session context: clear the conversation view.
				set({
					model: event.model,
					modelProvider: event.modelProvider,
					thinkingLevel: event.thinkingLevel,
					availableThinkingLevels: event.availableThinkingLevels,
					cwd: event.cwd,
					sessionId: event.sessionId,
					sessionPath: event.sessionPath,
					messages: event.messages,
					activities: event.activities,
					queuedCount: 0,
					error: null,
				});
				return;
			case 'model':
				set({
					model: event.model,
					modelProvider: event.modelProvider,
					thinkingLevel: event.thinkingLevel,
					availableThinkingLevels: event.availableThinkingLevels,
				});
				return;
			case 'thinking-level':
				set({ thinkingLevel: event.level });
				return;
			case 'user-message':
				set((s) => ({
					messages: [...s.messages, { id: event.id, role: 'user', text: event.text, status: 'done' }],
				}));
				return;
			case 'assistant-start':
				set((s) => ({
					messages: [...s.messages, { id: event.id, role: 'assistant', text: '', status: 'streaming' }],
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
			case 'assistant-end':
				set((s) => ({
					messages: s.messages.map((m) =>
						m.id === event.id
							? {
									...m,
									text: event.text || m.text,
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
					return { activities: activities.slice(-50) };
				});
				return;
			}
			case 'queue':
				set({ queuedCount: event.count });
				return;
			case 'error':
				set({ error: event.message });
				return;
		}
	},

	async refreshSessions() {
		const { bridge, cwd } = get();
		if (!bridge || !cwd) return;
		const request = ++sessionListRequest;
		try {
			const sessions = await bridge.listSessions();
			if (get().cwd === cwd && request === sessionListRequest) set({ sessions });
		} catch (error) {
			set({ error: errorMessage(error) });
		}
	},

	async refreshModels() {
		const bridge = get().bridge;
		if (!bridge) return;
		beginSettingsRequest();
		try {
			set({ models: await bridge.listModels() });
		} catch (error) {
			set({ settingsError: errorMessage(error) });
			throw error;
		} finally {
			endSettingsRequest();
		}
	},

	async setModel(provider, id) {
		const bridge = get().bridge;
		if (!bridge) return;
		beginSettingsRequest();
		try {
			await bridge.setModel(provider, id);
		} catch (error) {
			set({ settingsError: errorMessage(error) });
			throw error;
		} finally {
			endSettingsRequest();
		}
	},

	async setThinkingLevel(level) {
		const bridge = get().bridge;
		if (!bridge) return;
		beginSettingsRequest();
		try {
			await bridge.setThinkingLevel(level);
		} catch (error) {
			set({ settingsError: errorMessage(error) });
			throw error;
		} finally {
			endSettingsRequest();
		}
	},

	async refreshProviderAuth() {
		const bridge = get().bridge;
		if (!bridge) return;
		beginSettingsRequest();
		try {
			set({ providerAuth: await bridge.listProviderAuth() });
		} catch (error) {
			set({ settingsError: errorMessage(error) });
			throw error;
		} finally {
			endSettingsRequest();
		}
	},

	async setProviderApiKey(provider, key) {
		const bridge = get().bridge;
		if (!bridge) return;
		beginSettingsRequest();
		try {
			await bridge.setProviderApiKey(provider, key.trim());
			await Promise.all([get().refreshProviderAuth(), get().refreshModels()]);
		} catch (error) {
			set({ settingsError: errorMessage(error) });
			throw error;
		} finally {
			endSettingsRequest();
		}
	},

	async removeProviderCredential(provider) {
		const bridge = get().bridge;
		if (!bridge) return;
		beginSettingsRequest();
		try {
			await bridge.removeProviderCredential(provider);
			await Promise.all([get().refreshProviderAuth(), get().refreshModels()]);
		} catch (error) {
			set({ settingsError: errorMessage(error) });
			throw error;
		} finally {
			endSettingsRequest();
		}
	},

	async switchSession(path) {
		const bridge = get().bridge;
		if (!bridge) return;
		try {
			await bridge.switchSession(path);
			await get().refreshSessions();
		} catch (error) {
			set({ error: errorMessage(error) });
			throw error;
		}
	},

	async send(text, behavior) {
		const { bridge, status } = get();
		const trimmed = text.trim();
		if (!bridge || !trimmed) return;
		if (status !== 'idle' && status !== 'busy') {
			const error = new Error('Agent 尚未就绪');
			set({ error: error.message });
			throw error;
		}
		set({ error: null });
		try {
			await bridge.prompt(trimmed, behavior ?? (status === 'busy' ? 'followUp' : undefined));
		} catch (error) {
			set({ error: errorMessage(error) });
			throw error;
		}
	},

	async abort() {
		try {
			await get().bridge?.abort();
		} catch (error) {
			set({ error: errorMessage(error) });
		}
	},

	async newSession() {
		try {
			await get().bridge?.newSession();
			await get().refreshSessions();
		} catch (error) {
			set({ error: errorMessage(error) });
			throw error;
		}
	},

	async pickWorkspace() {
		const bridge = get().bridge;
		if (!bridge) return;
		try {
			const cwd = await bridge.pickWorkspace();
			if (cwd) await bridge.initAgent(cwd);
		} catch (error) {
			set({ error: errorMessage(error) });
			throw error;
		}
	},
}));

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Convenience selector: is the agent currently producing output? */
export const selectBusy = (s: ChatState): boolean =>
	s.status === 'busy' || s.status === 'starting';
