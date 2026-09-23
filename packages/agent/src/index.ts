/**
 * @pidesktop/agent — pi SDK service layer for the desktop host.
 *
 * Runs inside an Electron utility process (Node). Wraps the pi coding-agent SDK
 * in a small service that:
 *   - owns the AgentSessionRuntime (create / switch / new sessions),
 *   - maps raw pi session events into the normalized AgentUiEvent stream
 *     defined in @pidesktop/shared,
 *   - exposes prompt / abort for the IPC layer.
 *
 * Reference: reference/pi/packages/coding-agent/examples/sdk/13-session-runtime.ts
 */

import { randomUUID } from 'node:crypto';
import { basename, extname, join, relative } from 'node:path';

import {
	type AgentSessionEvent,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionUIContext,
	type ResolvedResource,
	type SessionEntry,
	DefaultPackageManager,
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
	UiAttachment,
	UiExtensionDialogRequest,
	UiExtensionSummary,
	UiMessage,
	UiModelSummary,
	UiProviderAuthStatus,
	UiSessionSummary,
	UiThinkingLevel,
	UiToolActivity,
} from '@pidesktop/shared';

export interface AgentInitOptions {
	cwd: string;
	sessionPath?: string;
	fresh?: boolean;
}

export interface ProjectTrustDecision {
	trusted: boolean;
	remember: boolean;
}

export type RequestProjectTrust = (cwd: string) => Promise<ProjectTrustDecision>;
export type RequestExtensionDialog = (request: UiExtensionDialogRequest, signal?: AbortSignal) => Promise<string | boolean | null>;

type EventEmitter = (event: AgentEventEnvelope) => void;

type PiRuntime = Awaited<ReturnType<typeof createAgentSessionRuntime>>;
const THINKING_LEVELS: readonly UiThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const MAX_TOOL_DETAIL_CHARS = 48000;
const MAX_LOADED_CONTEXTS = 12;
const TEXT_ATTACHMENT_MARKER = '\n\n<!-- pi-desktop:attachments-v1 -->\n';

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

class SingleAgentService {
	private runtime: PiRuntime | null = null;
	private unsubscribe: (() => void) | null = null;
	private emit: EventEmitter = () => {};
	private assistantId: string | null = null;
	private idCounter = 0;
	private timelineOrder = 0;
	private readonly toolTitles = new Map<string, string>();
	private readonly toolUpdateAt = new Map<string, number>();
	private sequence = 0;
	private activePromptCalls = 0;
	private activeConfigurationCalls = 0;
	private lifecycleOperation: Promise<void> | null = null;
	private closing = false;
	private readonly projectTrustByCwd: Map<string, boolean>;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private readonly requestExtensionDialog: RequestExtensionDialog;
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

	constructor(
		requestProjectTrust: RequestProjectTrust,
		requestExtensionDialog: RequestExtensionDialog,
		projectTrustByCwd: Map<string, boolean>,
	) {
		this.projectTrustByCwd = projectTrustByCwd;
		this.createRuntime = createRuntimeFactory(requestProjectTrust, this.projectTrustByCwd);
		this.requestExtensionDialog = requestExtensionDialog;
	}

	/** Install the event sink (the desktop IPC layer forwards these to the renderer). */
	onEvent(fn: EventEmitter): void {
		this.emit = fn;
	}

	get hasSession(): boolean {
		return this.runtime !== null;
	}

	get canEvict(): boolean {
		return this.activePromptCalls === 0 && this.activeConfigurationCalls === 0 && !this.lifecycleOperation &&
			(this.runtime?.session.isIdle ?? true);
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

	async listSessions(cwd = this.cwd): Promise<UiSessionSummary[]> {
		if (!cwd) return [];
		const sessions = await SessionManager.list(cwd);
		return sessions.map((session) => ({
			path: session.path,
			id: session.id,
			name: session.name,
			firstMessage: session.firstMessage,
			modified: session.modified.toISOString(),
			messageCount: session.messageCount,
		}));
	}

	renameSession(name: string): void {
		const session = this.runtime?.session;
		if (!session) throw new Error('会话尚未初始化');
		session.setSessionName(name);
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

	private async resolveExtensions(): Promise<ResolvedResource[]> {
		const services = this.runtime?.services;
		if (!services) return [];
		const manager = new DefaultPackageManager({
			cwd: services.cwd,
			agentDir: services.agentDir,
			settingsManager: services.settingsManager,
		});
		const resources = await manager.resolve(async () => 'skip');
		return resources.extensions;
	}

	async listExtensions(): Promise<UiExtensionSummary[]> {
		return (await this.resolveExtensions()).map((item) => ({
			path: item.path,
			name: basename(item.path, extname(item.path)),
			enabled: item.enabled,
			scope: item.metadata.scope === 'project' ? 'project' : 'user',
			origin: item.metadata.origin,
			source: item.metadata.source,
		}));
	}

	async setExtensionEnabled(path: string, enabled: boolean): Promise<void> {
		const session = this.requireIdleSession();
		if (typeof path !== 'string' || typeof enabled !== 'boolean') throw new Error('扩展参数无效');
		const item = (await this.resolveExtensions()).find((entry) => entry.path === path);
		if (!item) throw new Error('未找到 Pi 扩展');
		if (item.enabled === enabled) return;
		const services = this.runtime!.services;
		const settings = services.settingsManager;
		const project = item.metadata.scope === 'project';
		const baseDir = item.metadata.baseDir ?? (project ? join(this.cwd, '.pi') : services.agentDir);
		const pattern = relative(baseDir, item.path);
		if (!pattern || pattern.startsWith('..')) throw new Error('扩展路径无效');
		const applyPattern = (current: string[]): string[] => [
			...current.filter((entry) => entry.replace(/^[!+-]/, '') !== pattern),
			`${enabled ? '+' : '-'}${pattern}`,
		];
		let rollback: () => void;
		if (item.metadata.origin === 'package') {
			const packages = [...(project ? settings.getProjectSettings().packages ?? [] : settings.getGlobalSettings().packages ?? [])];
			const index = packages.findIndex((entry) => (typeof entry === 'string' ? entry : entry.source) === item.metadata.source);
			if (index < 0) throw new Error('未找到扩展所属的 Pi 包');
			const original = packages[index]!;
			const entry = typeof original === 'string' ? { source: original } : original;
			packages[index] = { ...entry, extensions: applyPattern(entry.extensions ?? []) };
			if (project) settings.setProjectPackages(packages);
			else settings.setPackages(packages);
			rollback = () => {
				packages[index] = original;
				if (project) settings.setProjectPackages(packages);
				else settings.setPackages(packages);
			};
		} else {
			const original = [...(project ? settings.getProjectSettings().extensions ?? [] : settings.getGlobalSettings().extensions ?? [])];
			if (project) settings.setProjectExtensionPaths(applyPattern(original));
			else settings.setExtensionPaths(applyPattern(original));
			rollback = () => {
				if (project) settings.setProjectExtensionPaths(original);
				else settings.setExtensionPaths(original);
			};
		}
		this.activeConfigurationCalls += 1;
		try {
			try { await session.reload(); }
			catch (error) {
				rollback();
				try { await session.reload(); } catch { /* Preserve the first reload error. */ }
				throw error;
			}
			this.fireReady();
		} finally {
			this.activeConfigurationCalls -= 1;
		}
	}

	/** Create (or re-create) the agent session bound to a working directory. */
	async init({ cwd, sessionPath, fresh }: AgentInitOptions): Promise<void> {
		await this.runLifecycle(() => this.initSession(cwd, sessionPath, fresh));
	}

	private async initSession(cwd: string, sessionPath?: string, fresh?: boolean): Promise<void> {
		if (this.runtime && (this.activePromptCalls > 0 || this.activeConfigurationCalls > 0 || !this.runtime.session.isIdle)) {
			throw new Error('当前会话仍在运行，请先停止后再切换工作区');
		}
		this.cwd = cwd;
		this.fire({ type: 'reset', cwd });
		this.fire({ type: 'status', status: 'starting' });

		try {
			await this.teardown();
			const sessionManager = sessionPath
				? SessionManager.open(sessionPath, undefined, cwd)
				: fresh ? SessionManager.create(cwd) : SessionManager.continueRecent(cwd);
			const runtime = await createAgentSessionRuntime(this.createRuntime, {
				cwd,
				agentDir: getAgentDir(),
				sessionManager,
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
	async prompt(text: string, behavior?: 'steer' | 'followUp', attachments: UiAttachment[] = []): Promise<void> {
		if (this.lifecycleOperation) throw new Error('会话正在切换，请稍后发送消息');
		const session = this.runtime?.session;
		if (!session) throw new Error('Agent is not initialized');
		if (this.activeConfigurationCalls > 0) throw new Error('设置正在更新，请稍后发送消息');
		if (this.activePromptCalls > 0 && session.isIdle) {
			throw new Error('上一条消息仍在接收中，请稍后重试');
		}
		const promptText = withTextAttachments(text, attachments);
		const images = imageAttachments(attachments);
		if (this.state.status === 'idle') this.fire({ type: 'status', status: 'busy' });
		this.activePromptCalls += 1;
		await new Promise<void>((resolve, reject) => {
			let acknowledged = false;
		void session.prompt(promptText, {
				streamingBehavior: behavior,
				images,
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
				if (this.activePromptCalls === 0 && session.isIdle && this.state.status === 'busy') {
					this.fire({ type: 'status', status: 'idle' });
				}
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
		await runtime.session.bindExtensions({ uiContext: this.createExtensionUiContext(), mode: 'rpc' });
		this.unsubscribe = runtime.session.subscribe((event) => this.onSessionEvent(event));
	}

	private createExtensionUiContext(): ExtensionUIContext {
		const request = this.requestExtensionDialog;
		return {
			select: async (title, options, opts) => {
				const value = await request({ id: randomUUID(), kind: 'select', title, options, timeout: opts?.timeout }, opts?.signal);
				return typeof value === 'string' && options.includes(value) ? value : undefined;
			},
			confirm: async (title, message, opts) =>
				(await request({ id: randomUUID(), kind: 'confirm', title, message, timeout: opts?.timeout }, opts?.signal)) === true,
			input: async (title, placeholder, opts) => {
				const value = await request({ id: randomUUID(), kind: 'input', title, placeholder, timeout: opts?.timeout }, opts?.signal);
				return typeof value === 'string' ? value : undefined;
			},
			notify: (message, type = 'info') => {
				void request({ id: randomUUID(), kind: 'notify', title: message, notificationType: type });
			},
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget: () => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			custom: async () => undefined as never,
			pasteToEditor: () => {},
			setEditorText: () => {},
			getEditorText: () => '',
			editor: async (title, prefill) => {
				const value = await request({ id: randomUUID(), kind: 'editor', title, defaultValue: prefill });
				return typeof value === 'string' ? value : undefined;
			},
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			get theme() { return undefined as never; },
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: '桌面界面不支持终端主题' }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		};
	}

	private async teardown(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.assistantId = null;
		this.toolTitles.clear();
		this.toolUpdateAt.clear();
		this.timelineOrder = 0;
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
		const timeline = historyTimeline(session.sessionManager.getBranch());
		this.timelineOrder = timeline.nextOrder;
		this.fire({
			type: 'ready',
			...modelSelection(session),
			cwd: this.cwd,
			sessionId: session.sessionId,
			sessionPath: session.sessionFile ?? null,
			messages: timeline.messages,
			activities: timeline.activities,
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
				this.state.messages.push({ id: event.id, order: event.order, role: 'user', text: event.text, attachments: event.attachments, status: 'done' });
				break;
			case 'assistant-start':
				this.state.messages.push({ id: event.id, order: event.order, role: 'assistant', text: '', status: 'streaming' });
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
					this.fire({ type: 'user-message', id: this.nextId('user'), order: this.timelineOrder++, text: userText(message), attachments: userAttachments(message) });
				} else if (message.role === 'assistant') {
					this.assistantId = this.nextId('assistant');
					this.fire({ type: 'assistant-start', id: this.assistantId, order: this.timelineOrder++ });
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
				const order = this.timelineOrder++;
				this.fire({
					type: 'tool',
					activity: { id: event.toolCallId, order, tool: event.toolName, title, status: 'running' },
				});
				return;
			}
			case 'tool_execution_update': {
				const now = Date.now();
				if (now - (this.toolUpdateAt.get(event.toolCallId) ?? 0) < 120) return;
				this.toolUpdateAt.set(event.toolCallId, now);
				const title = this.toolTitles.get(event.toolCallId) ?? event.toolName;
				const order = this.state.activities.find((item) => item.id === event.toolCallId)?.order ?? this.timelineOrder++;
				this.fire({ type: 'tool', activity: {
					id: event.toolCallId,
					order,
					tool: event.toolName,
					title,
					status: 'running',
					...toolResultText(event.partialResult),
				} });
				return;
			}
			case 'tool_execution_end': {
				const title = this.toolTitles.get(event.toolCallId) ?? event.toolName;
				const order = this.state.activities.find((item) => item.id === event.toolCallId)?.order ?? this.timelineOrder++;
				this.toolTitles.delete(event.toolCallId);
				this.toolUpdateAt.delete(event.toolCallId);
				this.fire({
					type: 'tool',
					activity: {
						id: event.toolCallId,
						order,
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

/** Keep independent Pi runtimes alive while the user moves between conversations. */
export class AgentService {
	private readonly contexts = new Map<string, SingleAgentService>();
	private readonly projectTrustByCwd = new Map<string, boolean>();
	private readonly lastContextByCwd = new Map<string, string>();
	private active: SingleAgentService | null = null;
	private activeKey: string | null = null;
	private emit: EventEmitter = () => {};
	private backgroundActivity: (cwd: string, path: string) => void = () => {};
	private sequence = 0;
	private transition: Promise<void> | null = null;
	private trimOperation: Promise<void> | null = null;
	private closing = false;
	private readonly requestProjectTrust: RequestProjectTrust;
	private readonly requestExtensionDialog: RequestExtensionDialog;

	constructor(
		requestProjectTrust: RequestProjectTrust = async () => ({ trusted: false, remember: false }),
		requestExtensionDialog: RequestExtensionDialog = async () => null,
	) {
		this.requestProjectTrust = requestProjectTrust;
		this.requestExtensionDialog = requestExtensionDialog;
	}

	get cwd(): string { return this.active?.cwd ?? ''; }
	get hasSession(): boolean { return this.active?.hasSession ?? false; }

	onEvent(fn: EventEmitter): void { this.emit = fn; }
	onBackgroundActivity(fn: (cwd: string, path: string) => void): void { this.backgroundActivity = fn; }

	getSnapshot(): AgentSnapshot {
		const snapshot = this.active?.getSnapshot();
		return snapshot ? { ...snapshot, sequence: this.sequence } : {
			sequence: this.sequence, status: 'uninitialized', model: '', modelProvider: '',
			thinkingLevel: 'off', availableThinkingLevels: ['off'], cwd: '', sessionId: null,
			sessionPath: null, messages: [], activities: [], queuedCount: 0, error: null,
		};
	}

	async listSessions(cwd = this.cwd): Promise<UiSessionSummary[]> {
		if (!cwd) return [];
		const sessions = await SessionManager.list(cwd);
		return sessions.map((session) => ({
			path: session.path, id: session.id, name: session.name,
			firstMessage: session.firstMessage, modified: session.modified.toISOString(),
			messageCount: session.messageCount,
		}));
	}

	async init({ cwd }: AgentInitOptions): Promise<void> { await this.switchWorkspace(cwd); }

	async switchWorkspace(cwd: string): Promise<void> {
		if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('工作区路径无效');
		await this.runTransition(async () => {
			const previous = this.active;
			const previousKey = this.activeKey;
			const remembered = this.lastContextByCwd.get(cwd);
			const existing = remembered ? this.contexts.get(remembered) : undefined;
			if (existing) {
				this.activate(remembered!, existing);
				return;
			}
			const key = randomUUID();
			const service = this.newContext(key);
			this.active = service;
			this.activeKey = key;
			try {
				await service.init({ cwd });
				this.lastContextByCwd.set(cwd, key);
				await this.trimContexts();
			} catch (error) {
				this.contexts.delete(key);
				this.active = previous;
				this.activeKey = previousKey;
				if (previous && previousKey) this.activate(previousKey, previous);
				throw error;
			}
		});
	}

	async switchSession(path: string): Promise<void> {
		const cwd = this.cwd;
		if (!cwd) throw new Error('请先打开工作区');
		await this.runTransition(async () => {
			const sessions = await this.listSessions(cwd);
			if (!sessions.some((session) => session.path === path)) throw new Error('会话不属于当前工作区');
			if (this.active?.getSnapshot().sessionPath === path) return;
			const existing = [...this.contexts.entries()].find(([, service]) =>
				service.cwd === cwd && service.getSnapshot().sessionPath === path);
			if (existing) {
				this.activate(existing[0], existing[1]);
				return;
			}
			await this.openContext({ cwd, sessionPath: path });
			this.fire({ type: 'sessions-changed', cwd });
		});
	}

	async newSession(): Promise<void> {
		const cwd = this.cwd;
		if (!cwd) throw new Error('请先打开工作区');
		await this.runTransition(() => this.openContext({ cwd, fresh: true }));
		this.fire({ type: 'sessions-changed', cwd });
	}

	async renameSession(path: string, name: string, cwd = this.cwd): Promise<void> {
		if (typeof name !== 'string' || name.length > 200) throw new Error('会话名称无效');
		const sessions = await this.listSessions(cwd);
		if (!sessions.some((session) => session.path === path)) throw new Error('会话不属于当前工作区');
		const loaded = [...this.contexts.values()].find((service) => service.getSnapshot().sessionPath === path);
		if (loaded) loaded.renameSession(name);
		else SessionManager.open(path, undefined, cwd).appendSessionInfo(name);
		this.fire({ type: 'sessions-changed', cwd });
	}

	listModels(): UiModelSummary[] { return this.active?.listModels() ?? []; }
	listProviderAuth(): UiProviderAuthStatus[] { return this.active?.listProviderAuth() ?? []; }
	setModel(provider: string, id: string): Promise<void> { return this.requireActive().setModel(provider, id); }
	setThinkingLevel(level: UiThinkingLevel): Promise<void> { return this.requireActive().setThinkingLevel(level); }
	setProviderApiKey(provider: string, key: string): Promise<void> { return this.requireActive().setProviderApiKey(provider, key); }
	removeProviderCredential(provider: string): Promise<void> { return this.requireActive().removeProviderCredential(provider); }
	listExtensions(): Promise<UiExtensionSummary[]> { return this.requireActive().listExtensions(); }
	setExtensionEnabled(path: string, enabled: boolean): Promise<void> { return this.requireActive().setExtensionEnabled(path, enabled); }
	prompt(text: string, behavior?: 'steer' | 'followUp', attachments?: UiAttachment[]): Promise<void> {
		return this.requireActive().prompt(text, behavior, attachments).finally(() => { void this.trimContexts(); });
	}
	abort(): Promise<void> { return this.active?.abort() ?? Promise.resolve(); }

	async dispose(): Promise<void> {
		this.closing = true;
		try { await this.transition; } catch { /* Failed transition has already cleaned up. */ }
		await Promise.allSettled([...this.contexts.values()].map((service) => service.dispose()));
		this.contexts.clear();
		this.active = null;
	}

	private requireActive(): SingleAgentService {
		if (!this.active) throw new Error('Agent is not initialized');
		return this.active;
	}

	private newContext(key: string): SingleAgentService {
		const service = new SingleAgentService(this.requestProjectTrust, this.requestExtensionDialog, this.projectTrustByCwd);
		service.onEvent(({ event }) => {
			if (this.active === service) this.fire(event);
			else if (event.type === 'assistant-end' || (event.type === 'tool' && event.activity.status === 'done')) {
				const snapshot = service.getSnapshot();
				if (snapshot.sessionPath) {
					this.backgroundActivity(service.cwd, snapshot.sessionPath);
					this.fire({ type: 'sessions-changed', cwd: service.cwd });
				}
			}
		});
		this.contexts.set(key, service);
		return service;
	}

	private async openContext(options: AgentInitOptions): Promise<void> {
		const previous = this.active;
		const previousKey = this.activeKey;
		const key = randomUUID();
		const service = this.newContext(key);
		this.active = service;
		this.activeKey = key;
		try {
			await service.init(options);
			this.lastContextByCwd.set(options.cwd, key);
			await this.trimContexts();
		} catch (error) {
			this.contexts.delete(key);
			this.active = previous;
			this.activeKey = previousKey;
			if (previous && previousKey) this.activate(previousKey, previous);
			throw error;
		}
	}

	private activate(key: string, service: SingleAgentService): void {
		this.contexts.delete(key);
		this.contexts.set(key, service);
		this.active = service;
		this.activeKey = key;
		this.lastContextByCwd.set(service.cwd, key);
		const snapshot = service.getSnapshot();
		this.fire({ type: 'reset', cwd: snapshot.cwd });
		if (snapshot.sessionId) this.fire({
			type: 'ready', model: snapshot.model, modelProvider: snapshot.modelProvider,
			thinkingLevel: snapshot.thinkingLevel, availableThinkingLevels: snapshot.availableThinkingLevels,
			cwd: snapshot.cwd, sessionId: snapshot.sessionId, sessionPath: snapshot.sessionPath,
			messages: snapshot.messages, activities: snapshot.activities,
		});
		this.fire({ type: 'status', status: snapshot.status, message: snapshot.statusMessage });
		if (snapshot.queuedCount) this.fire({ type: 'queue', count: snapshot.queuedCount });
		if (snapshot.error) this.fire({ type: 'error', message: snapshot.error });
	}

	private fire(event: AgentUiEvent): void { this.emit({ sequence: ++this.sequence, event }); }

	private async trimContexts(): Promise<void> {
		if (this.trimOperation) return this.trimOperation;
		const work = (async () => {
			for (const [key, service] of this.contexts) {
				if (this.contexts.size <= MAX_LOADED_CONTEXTS) break;
				if (service === this.active || !service.canEvict) continue;
				this.contexts.delete(key);
				if (this.lastContextByCwd.get(service.cwd) === key) this.lastContextByCwd.delete(service.cwd);
				await service.dispose();
			}
		})();
		this.trimOperation = work;
		try { await work; } finally { if (this.trimOperation === work) this.trimOperation = null; }
	}

	private async runTransition(operation: () => Promise<void>): Promise<void> {
		if (this.closing) throw new Error('应用正在退出');
		if (this.transition) throw new Error('会话正在切换，请稍后再试');
		const promise = Promise.resolve().then(operation);
		this.transition = promise;
		try { await promise; } finally { if (this.transition === promise) this.transition = null; }
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
	if (typeof content === 'string') return content.split(TEXT_ATTACHMENT_MARKER, 1)[0] ?? '';
	if (Array.isArray(content)) {
		const text = content
			.filter((part): part is { type: string; text?: string } => part?.type === 'text')
			.map((part) => part.text ?? '')
			.join('\n');
		return text.split(TEXT_ATTACHMENT_MARKER, 1)[0] ?? '';
	}
	return '';
}

function userAttachments(message: MessageLike): UiAttachment[] | undefined {
	const contents = Array.isArray(message.content) ? message.content : [];
	const images = contents
		.filter((part): part is { type: 'image'; data: string; mimeType: string } =>
			part?.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string')
		.map((part, index): UiAttachment => ({ kind: 'image', name: `图片 ${index + 1}`, mimeType: part.mimeType, data: part.data }));
	const rawText = typeof message.content === 'string' ? message.content : contents
		.filter((part): part is { type: 'text'; text: string } => part?.type === 'text' && typeof part.text === 'string')
		.map((part) => part.text).join('\n');
	const markerIndex = rawText.indexOf(TEXT_ATTACHMENT_MARKER);
	if (markerIndex < 0) return images.length ? images : undefined;
	let remaining = rawText.slice(markerIndex + TEXT_ATTACHMENT_MARKER.length);
	const files: UiAttachment[] = [];
	while (remaining.startsWith('<attached-file ') && files.length < 12) {
		const headerEnd = remaining.indexOf('\n');
		const header = remaining.slice(0, headerEnd);
		const match = /^<attached-file name="([^"]*)" mime="([^"]*)" length="(\d+)">$/.exec(header);
		if (!match || headerEnd < 0) break;
		const length = Number(match[3]);
		if (!Number.isSafeInteger(length) || length > 200_000) break;
		const contentStart = headerEnd + 1;
		const content = remaining.slice(contentStart, contentStart + length);
		const close = remaining.slice(contentStart + length);
		if (!close.startsWith('\n</attached-file>\n')) break;
		try {
			files.push({ kind: 'text', name: decodeURIComponent(match[1]!), mimeType: decodeURIComponent(match[2]!), text: content });
		} catch { break; }
		remaining = close.slice('\n</attached-file>\n'.length);
	}
	const attachments = [...images, ...files];
	return attachments.length ? attachments : undefined;
}

function withTextAttachments(text: string, attachments: UiAttachment[]): string {
	if (!Array.isArray(attachments) || attachments.length > 12) throw new Error('附件数量超出限制');
	const files = attachments.filter((item): item is Extract<UiAttachment, { kind: 'text' }> => item.kind === 'text');
	if (!files.length) return text;
	let result = `${text}${TEXT_ATTACHMENT_MARKER}`;
	for (const file of files) {
		if (typeof file.name !== 'string' || typeof file.text !== 'string' || file.text.length > 200_000) {
			throw new Error('文本附件无效或过大');
		}
		const safeName = file.name.replace(/[\r\n]/g, ' ').slice(0, 180);
		result += `<attached-file name="${encodeURIComponent(safeName)}" mime="${encodeURIComponent(file.mimeType || 'text/plain')}" length="${file.text.length}">\n${file.text}\n</attached-file>\n`;
	}
	return result;
}

function imageAttachments(attachments: UiAttachment[]): { type: 'image'; data: string; mimeType: string }[] {
	return attachments.filter((item): item is Extract<UiAttachment, { kind: 'image' }> => item.kind === 'image').map((image) => {
		if (!/^image\/(png|jpeg|gif|webp)$/.test(image.mimeType) ||
			typeof image.data !== 'string' || image.data.length > 14_000_000 ||
			!/^[-A-Za-z0-9+/]*={0,2}$/.test(image.data)) {
			throw new Error('图片附件格式无效或过大');
		}
		return { type: 'image', data: image.data, mimeType: image.mimeType };
	});
}

function assistantText(message: MessageLike): string {
	const content = message.content;
	if (!Array.isArray(content)) return '';
	return content
		.filter((part): part is { type: string; text?: string } => part?.type === 'text')
		.map((part) => part.text ?? '')
		.join('');
}

function historyTimeline(entries: SessionEntry[]): { messages: UiMessage[]; activities: UiToolActivity[]; nextOrder: number } {
	const messages: UiMessage[] = [];
	const activities = new Map<string, UiToolActivity>();
	let nextOrder = 0;
	for (const entry of entries) {
		if (entry.type !== 'message') continue;
		const message = entry.message;
		if (message.role === 'user') {
			messages.push({ id: entry.id, order: nextOrder++, role: 'user', text: userText(message), attachments: userAttachments(message), status: 'done' });
		} else if (message.role === 'assistant') {
			const text = assistantText(message);
			const errorMessage = message.stopReason === 'error' ? message.errorMessage || '模型调用失败' : undefined;
			if (text || errorMessage) {
				messages.push({
					id: entry.id,
					order: nextOrder++,
					role: 'assistant',
					text,
					status: message.stopReason === 'aborted' || errorMessage ? 'error' : 'done',
					errorMessage,
				});
			}
			if (Array.isArray(message.content)) for (const part of message.content) {
				if (part.type !== 'toolCall') continue;
				activities.set(part.id, {
					id: part.id,
					order: nextOrder++,
					tool: part.name,
					title: describeToolUse(part.name, part.arguments),
					status: 'running',
				});
			}
		} else if (message.role === 'toolResult') {
			const previous = activities.get(message.toolCallId);
			activities.set(message.toolCallId, {
				id: message.toolCallId,
				order: previous?.order ?? nextOrder++,
				tool: message.toolName,
				title: previous?.title ?? message.toolName,
				status: message.isError ? 'error' : 'done',
				...toolResultText(message),
			});
		}
	}
	return {
		messages,
		activities: [...activities.values()].map((activity) =>
			activity.status === 'running' ? { ...activity, status: 'error' } : activity),
		nextOrder,
	};
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
