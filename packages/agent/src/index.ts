/**
 * @pidesktop/agent — pi SDK service layer for the desktop host.
 *
 * Runs inside the Electron main process (Node). Wraps the pi coding-agent SDK
 * in a small service that:
 *   - owns the AgentSessionRuntime (create / switch / new sessions),
 *   - maps raw pi session events into the normalized AgentUiEvent stream
 *     defined in @pidesktop/shared,
 *   - exposes prompt / abort for the IPC layer.
 *
 * Reference: reference/pi/packages/coding-agent/examples/sdk/13-session-runtime.ts
 */

import {
	type AgentSessionEvent,
	type CreateAgentSessionRuntimeFactory,
	type SessionEntry,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	SessionManager,
	SettingsManager,
} from '@earendil-works/pi-coding-agent';
import type {
	AgentEventEnvelope,
	AgentSnapshot,
	AgentUiEvent,
	UiMessage,
	UiModelSummary,
	UiProviderAuthStatus,
	UiSessionSummary,
	UiThinkingLevel,
	UiToolActivity,
} from '@pidesktop/shared';

export interface AgentInitOptions {
	cwd: string;
}

export interface ProjectTrustDecision {
	trusted: boolean;
	remember: boolean;
}

export type RequestProjectTrust = (cwd: string) => Promise<ProjectTrustDecision>;

type EventEmitter = (event: AgentEventEnvelope) => void;

type PiRuntime = Awaited<ReturnType<typeof createAgentSessionRuntime>>;
const THINKING_LEVELS: readonly UiThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const MAX_RECENT_ACTIVITIES = 50;
const MAX_TOOL_DETAIL_CHARS = 48000;

/** Recreate cwd-bound services using pi's project-resource trust gate. */
function createRuntimeFactory(
	requestProjectTrust: RequestProjectTrust,
	projectTrustByCwd: Map<string, boolean>,
): CreateAgentSessionRuntimeFactory {
	return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const needsTrust = hasTrustRequiringProjectResources(cwd);
		const trustStore = new ProjectTrustStore(agentDir);
		const savedTrust = needsTrust ? trustStore.get(cwd) : null;
		const cachedTrust = projectTrustByCwd.get(cwd);
		const bootstrapSettings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		const defaultTrust = bootstrapSettings.getDefaultProjectTrust();
		const shouldPrompt = needsTrust && cachedTrust === undefined && savedTrust === null && defaultTrust === 'ask';
		const projectTrusted = !needsTrust || (cachedTrust ?? savedTrust ?? (defaultTrust === 'always'));
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager,
			resourceLoaderReloadOptions: shouldPrompt ? {
				resolveProjectTrust: async () => {
					const decision = await requestProjectTrust(cwd);
					const trusted = decision.trusted === true;
					projectTrustByCwd.set(cwd, trusted);
					if (decision.remember) trustStore.set(cwd, trusted);
					return trusted;
				},
			} : undefined,
		});
		return {
			...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
			services,
			diagnostics: services.diagnostics,
		};
	};
}

export class AgentService {
	private runtime: PiRuntime | null = null;
	private unsubscribe: (() => void) | null = null;
	private emit: EventEmitter = () => {};
	private assistantId: string | null = null;
	private idCounter = 0;
	private readonly toolTitles = new Map<string, string>();
	private readonly toolUpdateAt = new Map<string, number>();
	private sequence = 0;
	private activePromptCalls = 0;
	private activeConfigurationCalls = 0;
	private lifecycleOperation: Promise<void> | null = null;
	private closing = false;
	private readonly projectTrustByCwd = new Map<string, boolean>();
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private state: Omit<AgentSnapshot, 'sequence'> = {
		status: 'uninitialized',
		model: '',
		modelProvider: '',
		thinkingLevel: 'off',
		availableThinkingLevels: ['off'],
		cwd: '',
		sessionId: null,
		sessionPath: null,
		messages: [],
		activities: [],
		queuedCount: 0,
		error: null,
	};

	cwd = '';

	constructor(requestProjectTrust: RequestProjectTrust = async () => ({ trusted: false, remember: false })) {
		this.createRuntime = createRuntimeFactory(requestProjectTrust, this.projectTrustByCwd);
	}

	/** Install the event sink (the desktop IPC layer forwards these to the renderer). */
	onEvent(fn: EventEmitter): void {
		this.emit = fn;
	}

	get hasSession(): boolean {
		return this.runtime !== null;
	}

	getSnapshot(): AgentSnapshot {
		return {
			...this.state,
			sequence: this.sequence,
			availableThinkingLevels: [...this.state.availableThinkingLevels],
			messages: this.state.messages.map((message) => ({ ...message })),
			activities: this.state.activities.map((activity) => ({ ...activity })),
		};
	}

	async listSessions(): Promise<UiSessionSummary[]> {
		if (!this.runtime) return [];
		const sessions = await SessionManager.list(this.cwd);
		return sessions.map((session) => ({
			path: session.path,
			id: session.id,
			name: session.name,
			firstMessage: session.firstMessage,
			modified: session.modified.toISOString(),
			messageCount: session.messageCount,
		}));
	}

	/** Return only display metadata for models with usable provider authentication. */
	listModels(): UiModelSummary[] {
		const session = this.runtime?.session;
		if (!session) return [];
		return session.modelRuntime.getAvailableSnapshot().map((model) => ({
			provider: model.provider,
			id: model.id,
			name: model.name,
			reasoning: model.reasoning,
			input: [...model.input],
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		}));
	}

	/** Provider IDs and configuration state only; never expose auth objects or keys. */
	listProviderAuth(): UiProviderAuthStatus[] {
		const session = this.runtime?.session;
		if (!session) return [];
		return session.modelRuntime.getProviders().map((provider) => {
			const auth = session.modelRuntime.getProviderAuthStatus(provider.id);
			return {
				provider: provider.id,
				configured: auth.configured,
				source: auth.source,
				supportsApiKey: Boolean(provider.auth.apiKey?.login),
			};
		});
	}

	/** Select and persist the default model using pi's own validation and transcript logic. */
	async setModel(provider: string, id: string): Promise<void> {
		const session = this.requireIdleSession();
		if (typeof provider !== 'string' || typeof id !== 'string') throw new Error('模型参数无效');
		const model = session.modelRuntime.getAvailableSnapshot().find((item) => item.provider === provider && item.id === id);
		if (!model) throw new Error(`模型不可用：${provider}/${id}`);
		this.activeConfigurationCalls += 1;
		try {
			await session.setModel(model, { persist: true });
			this.fire({ type: 'model', ...modelSelection(session) });
		} finally {
			this.activeConfigurationCalls -= 1;
		}
	}

	/** Pi clamps the requested level to the selected model's supported levels. */
	async setThinkingLevel(level: UiThinkingLevel): Promise<void> {
		const session = this.requireIdleSession();
		if (!THINKING_LEVELS.includes(level)) throw new Error('思考级别无效');
		session.setThinkingLevel(level, { persist: true });
		if (this.state.thinkingLevel !== session.thinkingLevel) {
			this.fire({ type: 'thinking-level', level: session.thinkingLevel });
		}
	}

	/** Store one API key through pi's persistent credential store. */
	async setProviderApiKey(provider: string, key: string): Promise<void> {
		const session = this.requireIdleSession();
		if (typeof provider !== 'string' || typeof key !== 'string' || !key.trim()) throw new Error('Provider 或 API Key 无效');
		const method = session.modelRuntime.getProvider(provider)?.auth.apiKey;
		if (!method?.login) throw new Error('该 Provider 不支持 API Key 登录');
		this.activeConfigurationCalls += 1;
		try {
			let prompted = false;
			await session.modelRuntime.login(provider, 'api_key', {
				prompt: async (prompt) => {
					if (prompt.type !== 'secret' || prompted) throw new Error('该 Provider 需要交互式登录，当前设置页不支持');
					prompted = true;
					return key.trim();
				},
				notify: () => {},
			});
		} finally {
			this.activeConfigurationCalls -= 1;
		}
	}

	/** Delete pi's stored credential; environment-based auth remains intact. */
	async removeProviderCredential(provider: string): Promise<void> {
		const session = this.requireIdleSession();
		if (typeof provider !== 'string' || !session.modelRuntime.getProvider(provider)) throw new Error('Provider 无效');
		this.activeConfigurationCalls += 1;
		try {
			await session.modelRuntime.logout(provider);
		} finally {
			this.activeConfigurationCalls -= 1;
		}
	}

	/** Create (or re-create) the agent session bound to a working directory. */
	async init({ cwd }: AgentInitOptions): Promise<void> {
		await this.runLifecycle(() => this.initSession(cwd));
	}

	private async initSession(cwd: string): Promise<void> {
		if (this.runtime && (this.activePromptCalls > 0 || this.activeConfigurationCalls > 0 || !this.runtime.session.isIdle)) {
			throw new Error('当前会话仍在运行，请先停止后再切换工作区');
		}
		this.cwd = cwd;
		this.fire({ type: 'reset', cwd });
		this.fire({ type: 'status', status: 'starting' });

		try {
			await this.teardown();
			const runtime = await createAgentSessionRuntime(this.createRuntime, {
				cwd,
				agentDir: getAgentDir(),
				sessionManager: SessionManager.continueRecent(cwd),
			});
			this.runtime = runtime;
			await this.bindSession();
			this.fireReady();
			this.fire({ type: 'status', status: 'idle', message: runtime.modelFallbackMessage });
		} catch (error) {
			const failedRuntime = this.runtime;
			this.runtime = null;
			this.unsubscribe?.();
			this.unsubscribe = null;
			if (failedRuntime) {
				try {
					await failedRuntime.dispose();
				} catch {
					// Preserve the original initialization error for the user.
				}
			}
			this.fire({ type: 'error', message: errorMessage(error) });
			this.fire({ type: 'status', status: 'error', message: errorMessage(error) });
			throw error;
		}
	}

	/** Acknowledge after pi accepts the prompt, while the run continues through events. */
	async prompt(text: string, behavior?: 'steer' | 'followUp'): Promise<void> {
		if (this.lifecycleOperation) throw new Error('会话正在切换，请稍后发送消息');
		const session = this.runtime?.session;
		if (!session) throw new Error('Agent is not initialized');
		if (this.activeConfigurationCalls > 0) throw new Error('设置正在更新，请稍后发送消息');
		if (this.activePromptCalls > 0 && session.isIdle) {
			throw new Error('上一条消息仍在接收中，请稍后重试');
		}
		this.activePromptCalls += 1;
		await new Promise<void>((resolve, reject) => {
			let acknowledged = false;
			void session.prompt(text, {
				streamingBehavior: behavior,
				preflightResult: (accepted) => {
					if (accepted && !acknowledged) {
						acknowledged = true;
						resolve();
					}
				},
			}).catch((error: unknown) => {
				this.fire({ type: 'error', message: errorMessage(error) });
				if (!acknowledged) {
					acknowledged = true;
					reject(error);
				}
			}).finally(() => {
				this.activePromptCalls -= 1;
			});
		});
	}

	/** Abort the active run. */
	async abort(): Promise<void> {
		await this.runtime?.session.abort();
	}

	/** Start a fresh conversation in the same working directory. */
	async newSession(): Promise<void> {
		await this.runLifecycle(() => this.startNewSession());
	}

	private async startNewSession(): Promise<void> {
		const runtime = this.runtime;
		if (!runtime) throw new Error('Agent is not initialized');
		if (this.activePromptCalls > 0 || this.activeConfigurationCalls > 0 || !runtime.session.isIdle) throw new Error('当前会话仍在运行，请先停止后再新建会话');
		this.fire({ type: 'status', status: 'starting' });
		try {
			const result = await runtime.newSession();
			if (!result.cancelled) {
				await this.bindSession();
				this.fireReady();
			}
			this.fire({ type: 'status', status: 'idle', message: runtime.modelFallbackMessage });
		} catch (error) {
			this.unsubscribe?.();
			this.unsubscribe = null;
			this.runtime = null;
			try {
				await runtime.dispose();
			} catch {
				// Keep the original error.
			}
			this.fire({ type: 'reset', cwd: this.cwd });
			this.fire({ type: 'error', message: errorMessage(error) });
			this.fire({ type: 'status', status: 'error' });
			throw error;
		}
	}

	async switchSession(path: string): Promise<void> {
		await this.runLifecycle(() => this.openSession(path));
	}

	private async openSession(path: string): Promise<void> {
		const runtime = this.runtime;
		if (!runtime) throw new Error('Agent is not initialized');
		if (this.activePromptCalls > 0 || this.activeConfigurationCalls > 0 || !runtime.session.isIdle) throw new Error('当前会话仍在运行，请先停止后再切换会话');
		if (runtime.session.sessionFile === path) return;
		const sessions = await this.listSessions();
		if (!sessions.some((session) => session.path === path)) {
			throw new Error('会话不属于当前工作区');
		}
		this.fire({ type: 'status', status: 'starting' });
		try {
			const result = await runtime.switchSession(path);
			if (!result.cancelled) {
				await this.bindSession();
				this.fireReady();
			}
			this.fire({ type: 'status', status: 'idle', message: runtime.modelFallbackMessage });
		} catch (error) {
			this.unsubscribe?.();
			this.unsubscribe = null;
			this.runtime = null;
			try {
				await runtime.dispose();
			} catch {
				// Keep the original error.
			}
			this.fire({ type: 'reset', cwd: this.cwd });
			this.fire({ type: 'error', message: errorMessage(error) });
			this.fire({ type: 'status', status: 'error' });
			throw error;
		}
	}

	/** Dispose everything (aborts active work, invalidates extensions). */
	async dispose(): Promise<void> {
		this.closing = true;
		try {
			await this.lifecycleOperation;
		} catch {
			// A failed transition still needs its normal cleanup before final teardown.
		}
		await this.teardown();
	}

	/* ---------------------------------------------------------------- */
	/* internals                                                          */
	/* ---------------------------------------------------------------- */

	private async runLifecycle(operation: () => Promise<void>): Promise<void> {
		if (this.closing) throw new Error('应用正在退出');
		if (this.lifecycleOperation) throw new Error('会话正在切换，请稍后再试');
		const current = Promise.resolve().then(() => {
			if (this.closing) throw new Error('应用正在退出');
			return operation();
		});
		this.lifecycleOperation = current;
		try {
			await current;
		} finally {
			if (this.lifecycleOperation === current) this.lifecycleOperation = null;
		}
	}

	private requireIdleSession(): PiRuntime['session'] {
		if (this.lifecycleOperation) throw new Error('会话正在切换，请稍后再修改设置');
		const session = this.runtime?.session;
		if (!session) throw new Error('Agent is not initialized');
		if (this.activePromptCalls > 0 || this.activeConfigurationCalls > 0 || !session.isIdle) {
			throw new Error('当前会话仍在运行，请等待完成后修改设置');
		}
		return session;
	}

	private async bindSession(): Promise<void> {
		const runtime = this.runtime;
		if (!runtime) return;
		this.unsubscribe?.();
		this.unsubscribe = null;
		await runtime.session.bindExtensions({});
		this.unsubscribe = runtime.session.subscribe((event) => this.onSessionEvent(event));
	}

	private async teardown(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.assistantId = null;
		this.toolTitles.clear();
		this.toolUpdateAt.clear();
		const runtime = this.runtime;
		this.runtime = null;
		if (runtime) {
			await runtime.session.abort();
			await runtime.dispose();
		}
	}

	private fire(event: AgentUiEvent): void {
		this.reduce(event);
		this.emit({ sequence: ++this.sequence, event });
	}

	private fireReady(): void {
		const session = this.runtime?.session;
		if (!session) return;
		this.assistantId = null;
		this.toolTitles.clear();
		this.toolUpdateAt.clear();
		this.fire({
			type: 'ready',
			...modelSelection(session),
			cwd: this.cwd,
			sessionId: session.sessionId,
			sessionPath: session.sessionFile ?? null,
			messages: historyMessages(session.sessionManager.getBranch()),
			activities: historyActivities(session.sessionManager.getBranch()),
		});
	}

	private reduce(event: AgentUiEvent): void {
		switch (event.type) {
			case 'reset':
				this.state = {
					status: 'uninitialized',
					model: '',
					modelProvider: '',
					thinkingLevel: 'off',
					availableThinkingLevels: ['off'],
					cwd: event.cwd,
					sessionId: null,
					sessionPath: null,
					messages: [],
					activities: [],
					queuedCount: 0,
					error: null,
				};
				break;
			case 'status':
				this.state.status = event.status;
				this.state.statusMessage = event.message;
				break;
			case 'ready':
				this.state = {
					...this.state,
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
				};
				break;
			case 'model':
				this.state.model = event.model;
				this.state.modelProvider = event.modelProvider;
				this.state.thinkingLevel = event.thinkingLevel;
				this.state.availableThinkingLevels = event.availableThinkingLevels;
				break;
			case 'thinking-level':
				this.state.thinkingLevel = event.level;
				break;
			case 'user-message':
				this.state.messages.push({ id: event.id, role: 'user', text: event.text, status: 'done' });
				break;
			case 'assistant-start':
				this.state.messages.push({ id: event.id, role: 'assistant', text: '', status: 'streaming' });
				this.state.error = null;
				break;
			case 'assistant-delta': {
				const message = this.state.messages.find((item) => item.id === event.id);
				if (message) message.text += event.delta;
				break;
			}
			case 'assistant-end': {
				const message = this.state.messages.find((item) => item.id === event.id);
				if (message) {
					message.text = event.text || message.text;
					message.status = event.aborted || event.errorMessage ? 'error' : 'done';
					message.errorMessage = event.errorMessage;
				}
				if (event.errorMessage) this.state.error = event.errorMessage;
				break;
			}
			case 'tool': {
				const index = this.state.activities.findIndex((item) => item.id === event.activity.id);
				if (index >= 0) this.state.activities[index] = event.activity;
				else this.state.activities.push(event.activity);
				if (this.state.activities.length > MAX_RECENT_ACTIVITIES) {
					this.state.activities.splice(0, this.state.activities.length - MAX_RECENT_ACTIVITIES);
				}
				break;
			}
			case 'queue':
				this.state.queuedCount = event.count;
				break;
			case 'error':
				this.state.error = event.message;
				break;
		}
	}

	private nextId(prefix: string): string {
		this.idCounter += 1;
		return `${prefix}-${this.idCounter}`;
	}

	private onSessionEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case 'agent_start': {
				this.fire({ type: 'status', status: 'busy' });
				return;
			}
			case 'agent_settled': {
				this.fire({ type: 'status', status: 'idle' });
				return;
			}
			case 'auto_retry_start': {
				this.fire({
					type: 'status',
					status: 'busy',
					message: `auto retry ${event.attempt}/${event.maxAttempts}`,
				});
				return;
			}
			case 'queue_update': {
				this.fire({ type: 'queue', count: event.steering.length + event.followUp.length });
				return;
			}
			case 'entry_appended': {
				if (event.entry.type === 'model_change') {
					const session = this.runtime?.session;
					if (session) this.fire({ type: 'model', ...modelSelection(session) });
				}
				return;
			}
			case 'thinking_level_changed': {
				this.fire({ type: 'thinking-level', level: event.level });
				return;
			}
			case 'message_start': {
				const message = event.message;
				if (message.role === 'user') {
					this.fire({ type: 'user-message', id: this.nextId('user'), text: userText(message) });
				} else if (message.role === 'assistant') {
					this.assistantId = this.nextId('assistant');
					this.fire({ type: 'assistant-start', id: this.assistantId });
				}
				return;
			}
			case 'message_update': {
				const sub = event.assistantMessageEvent;
				if (sub.type === 'text_delta' && this.assistantId) {
					this.fire({ type: 'assistant-delta', id: this.assistantId, delta: sub.delta });
				}
				return;
			}
			case 'message_end': {
				if (event.message.role === 'assistant' && this.assistantId) {
					const id = this.assistantId;
					this.assistantId = null;
					this.fire({
						type: 'assistant-end',
						id,
						text: assistantText(event.message),
						aborted: event.message.stopReason === 'aborted',
						errorMessage: event.message.stopReason === 'error' ? event.message.errorMessage || '模型调用失败' : undefined,
					});
				}
				return;
			}
			case 'tool_execution_start': {
				const title = describeToolUse(event.toolName, event.args);
				this.toolTitles.set(event.toolCallId, title);
				this.fire({
					type: 'tool',
					activity: { id: event.toolCallId, tool: event.toolName, title, status: 'running' },
				});
				return;
			}
			case 'tool_execution_update': {
				const now = Date.now();
				if (now - (this.toolUpdateAt.get(event.toolCallId) ?? 0) < 120) return;
				this.toolUpdateAt.set(event.toolCallId, now);
				const title = this.toolTitles.get(event.toolCallId) ?? event.toolName;
				this.fire({ type: 'tool', activity: {
					id: event.toolCallId,
					tool: event.toolName,
					title,
					status: 'running',
					...toolResultText(event.partialResult),
				} });
				return;
			}
			case 'tool_execution_end': {
				const title = this.toolTitles.get(event.toolCallId) ?? event.toolName;
				this.toolTitles.delete(event.toolCallId);
				this.toolUpdateAt.delete(event.toolCallId);
				this.fire({
					type: 'tool',
					activity: {
						id: event.toolCallId,
						tool: event.toolName,
						title,
						status: event.isError ? 'error' : 'done',
						...toolResultText(event.result),
					},
				});
				return;
			}
			default:
				return;
		}
	}
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

type MessageLike = {
	role: string;
	content: unknown;
};

function modelSelection(session: PiRuntime['session']): Pick<AgentSnapshot, 'model' | 'modelProvider' | 'thinkingLevel' | 'availableThinkingLevels'> {
	return {
		model: session.model?.id ?? 'unknown',
		modelProvider: session.model?.provider ?? '',
		thinkingLevel: session.thinkingLevel,
		availableThinkingLevels: [...session.getAvailableThinkingLevels()],
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function userText(message: MessageLike): string {
	const content = message.content;
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.filter((part): part is { type: string; text?: string } => part?.type === 'text')
			.map((part) => part.text ?? '')
			.join('\n');
	}
	return '';
}

function assistantText(message: MessageLike): string {
	const content = message.content;
	if (!Array.isArray(content)) return '';
	return content
		.filter((part): part is { type: string; text?: string } => part?.type === 'text')
		.map((part) => part.text ?? '')
		.join('');
}

function historyMessages(entries: SessionEntry[]): UiMessage[] {
	const messages: UiMessage[] = [];
	for (const entry of entries) {
		if (entry.type !== 'message') continue;
		const message = entry.message;
		if (message.role === 'user') {
			messages.push({ id: entry.id, role: 'user', text: userText(message), status: 'done' });
		} else if (message.role === 'assistant') {
			const text = assistantText(message);
			const errorMessage = message.stopReason === 'error' ? message.errorMessage || '模型调用失败' : undefined;
			if (text || errorMessage) {
				messages.push({
					id: entry.id,
					role: 'assistant',
					text,
					status: message.stopReason === 'aborted' || errorMessage ? 'error' : 'done',
					errorMessage,
				});
			}
		}
	}
	return messages;
}

function historyActivities(entries: SessionEntry[]): UiToolActivity[] {
	const activities = new Map<string, UiToolActivity>();
	for (const entry of entries) {
		if (entry.type !== 'message') continue;
		const message = entry.message;
		if (message.role === 'assistant' && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part.type !== 'toolCall') continue;
				activities.set(part.id, {
					id: part.id,
					tool: part.name,
					title: describeToolUse(part.name, part.arguments),
					status: 'running',
				});
				if (activities.size > MAX_RECENT_ACTIVITIES) activities.delete(activities.keys().next().value!);
			}
		} else if (message.role === 'toolResult') {
			const previous = activities.get(message.toolCallId);
			activities.set(message.toolCallId, {
				id: message.toolCallId,
				tool: message.toolName,
				title: previous?.title ?? message.toolName,
				status: message.isError ? 'error' : 'done',
				...toolResultText(message),
			});
			if (activities.size > MAX_RECENT_ACTIVITIES) activities.delete(activities.keys().next().value!);
		}
	}
	return [...activities.values()].slice(-MAX_RECENT_ACTIVITIES).map((activity) =>
		activity.status === 'running' ? { ...activity, status: 'error' } : activity,
	);
}

function toolResultText(value: unknown): Pick<UiToolActivity, 'detail' | 'detailTruncated'> {
	if (!value || typeof value !== 'object') return {};
	const content = (value as { content?: unknown }).content;
	if (!Array.isArray(content)) return {};
	const text = content
		.filter((part): part is { type: string; text: string } => part?.type === 'text' && typeof part.text === 'string')
		.map((part) => part.text)
		.join('\n');
	return text ? {
		detail: text.slice(0, MAX_TOOL_DETAIL_CHARS),
		detailTruncated: text.length > MAX_TOOL_DETAIL_CHARS,
	} : {};
}

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Best-effort one-line description of a tool call, e.g. `bash(npm run build)`. */
function describeToolUse(tool: string, args: unknown): string {
	const record = (args ?? {}) as Record<string, unknown>;
	const firstString = (...keys: string[]): string | undefined => {
		for (const key of keys) {
			const value = record[key];
			if (typeof value === 'string' && value.trim()) return value.trim();
		}
		return undefined;
	};
	const detail =
		firstString('file', 'path', 'command', 'pattern', 'url', 'prompt') ??
		safeJson(args, 56);
	return detail ? `${tool}(${truncate(detail, 72)})` : tool;
}

function safeJson(value: unknown, max: number): string | undefined {
	try {
		return truncate(JSON.stringify(value) ?? '', max);
	} catch {
		return undefined;
	}
}
