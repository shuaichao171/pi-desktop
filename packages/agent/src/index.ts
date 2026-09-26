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
 * Uses the published @earendil-works/pi-coding-agent SDK runtime and
 * SessionManager APIs; no checked-out Pi source tree is required.
 */

import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, relative, resolve } from 'node:path';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';

import {
	type AgentSessionEvent,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionUIContext,
	type ResolvedResource,
	type SessionEntry,
	type SessionTreeNode,
	DefaultPackageManager,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	readStoredCredential,
	SessionManager,
	SettingsManager,
} from '@earendil-works/pi-coding-agent';
import type {
	AgentEventEnvelope,
	AgentSnapshot,
	AgentUiEvent,
	UiAttachment,
	UiContextSource,
	UiContextUsage,
	UiExtensionDialogRequest,
	UiExtensionSummary,
	UiFileChange,
	UiMessage,
	UiConversationRun,
	UiModelSummary,
	UiModelProvider,
	UiDiscoverProviderModelsRequest,
	UiProviderModelDiscovery,
	UiProviderApi,
	UiPluginCatalog,
	UiPluginMutation,
	UiPluginResourceKind,
	UiPluginResourcePreview,
	UiPluginScope,
	UiSaveCustomProviderRequest,
	UiProviderAuthStatus,
	UiHistoryPage,
	UiSessionStats,
	UiSessionTreeNode,
	UiQueuedAttachment,
	UiSessionSummary,
	UiSessionRuntimeState,
	UiSessionRuntimeSummary,
	UiSlashCommand,
	UiSlashCommandRequest,
	UiThinkingLevel,
	UiThinkingOutput,
	UiThinkingStatus,
	UiSaveInstructionRequest,
	UiToolActivity,
} from '@pidesktop/shared';
import { BUILTIN_SLASH_COMMANDS, expandSlashPrompt, validateSlashCommandRequest, validSlashCommandName } from './slashCommands.ts';
import { commitProviderDocument, CUSTOM_PROVIDER_APIS, getCachedDisabledModels, getBuiltinProviderIds, isEditableProvider, literalApiKey, loadModelPrefs, mergeProvider, readProviderDocument, safeProviderUrl, setModelDisabled, validateDiscoveryRequest, validateProviderId, validateProviderRequest, validateProviderWithSdk, type ProviderDocument } from './customProviders.ts';
import { discoverProviderModels } from './providerDiscovery.ts';
import { bindProviderNetwork, runWithProviderNetwork } from './providerNetwork.ts';
export { configureProviderNetwork } from './providerNetwork.ts';
import { applyPluginMutation, readPluginCatalog, readPluginResourcePreview } from './plugins.ts';
import { cloneQueuedMessage, reconcileQueuedMessages, type QueuedMessageRecord, type SdkQueueSnapshot } from './queuedMessages.ts';
import { SessionFileChanges } from './fileChanges.ts';
import { createPersonalizationService } from './personalization.ts';
import { AttachmentStore } from './attachmentStore.ts';
import { DurableInputQueue } from './inputQueue.ts';
import { ConversationRunTracker, isConversationRunEntry, latestUnassociatedRunId, readConversationRuns, selectConversationRuns } from './conversationRuns.ts';
import { requireInputQueueScope, type UiInputQueue, type UiInputQueueScope, type UiInputQueueMutation, type UiInputReceipt, type UiSubmitInput } from '../../shared/src/inputFeatures.ts';
import type { ModelTestRequest, ProjectDefaultsWrite } from '../../shared/src/managementFeatures.ts';
import { ModelTestService } from './modelTest.ts';
import { ProjectDefaultsService } from './projectDefaults.ts';
import { McpManager } from './mcpManager.ts';
import type { UiMcpSaveRequest, UiMcpTarget } from '../../shared/src/mcpFeatures.ts';
import type { PluginUpdateCheck } from '../../shared/src/pluginUpdates.ts';
import { checkPluginUpdate } from './pluginUpdates.ts';

export interface AgentInitOptions {
	cwd: string;
	sessionPath?: string;
	fresh?: boolean;
	/** Sessions currently owned by another worker must not be restored. */
	excludeSessionPaths?: string[];
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
const MAX_THINKING_CHARS = 48000;
const THINKING_UPDATE_INTERVAL_MS = 80;
/** Timeline entries sent in the ready payload; older history loads page-by-page. */
const READY_HISTORY_LIMIT = 400;
/** Bound attachment data in every history/snapshot payload, prioritizing recent messages. */
export const HISTORY_ATTACHMENT_BUDGET = 8 * 1024 * 1024;
const HISTORY_PAGE_MAX = 500;
const MAX_LOADED_CONTEXTS = 12;
const TEXT_ATTACHMENT_MARKER = '\n\n<!-- pi-desktop:attachments-v1 -->\n';

async function listWorkspaceSessions(cwd: string) {
	const sessions = await SessionManager.list(cwd);
	return sessions.filter((session) => typeof session.cwd === 'string' && session.cwd.length > 0
		&& relative(resolve(session.cwd), resolve(cwd)) === '');
}

/** Recreate cwd-bound services using pi's project-resource trust gate. */
function createRuntimeFactory(
	requestProjectTrust: RequestProjectTrust,
	projectTrustByCwd: Map<string, boolean>,
	trackFileChanges: (session: PiRuntime['session'], tracker: SessionFileChanges) => void,
	publishFileChanges: (sessionId: string, changes: UiFileChange[]) => void,
	mcp: McpManager,
): CreateAgentSessionRuntimeFactory {
	return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const nativeNeedsTrust = hasTrustRequiringProjectResources(cwd);
		const needsTrust = nativeNeedsTrust || existsSync(join(cwd, '.pi', 'mcp-servers.json'));
		const trustStore = new ProjectTrustStore(agentDir);
		const savedTrust = needsTrust ? trustStore.get(cwd) : null;
		const cachedTrust = projectTrustByCwd.get(cwd);
		const bootstrapSettings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		const defaultTrust = bootstrapSettings.getDefaultProjectTrust();
		const shouldPrompt = needsTrust && cachedTrust === undefined && savedTrust === null && defaultTrust === 'ask';
		let projectTrusted = !needsTrust || (cachedTrust ?? savedTrust ?? (defaultTrust === 'always'));
		// The SDK does not know our MCP-only resource file, so it would never invoke
		// the resource loader's trust resolver for this case.
		if (shouldPrompt && !nativeNeedsTrust) {
			const decision = await requestProjectTrust(cwd);
			projectTrusted = decision.trusted === true; projectTrustByCwd.set(cwd, projectTrusted);
			if (decision.remember) trustStore.set(cwd, projectTrusted);
		}
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
		const fileChanges = new SessionFileChanges(cwd, sessionManager, (changes) => publishFileChanges(sessionManager.getSessionId(), changes));
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager,
			resourceLoaderOptions: { extensionFactories: [
				{ name: 'desktop-file-changes', hidden: true, factory: fileChanges.extension },
				{ name: 'desktop-mcp', hidden: true, factory: mcp.extension(cwd, sessionManager.getSessionId()) },
			] },
			resourceLoaderReloadOptions: shouldPrompt && nativeNeedsTrust ? {
				resolveProjectTrust: async () => {
					const decision = await requestProjectTrust(cwd);
					const trusted = decision.trusted === true;
					projectTrustByCwd.set(cwd, trusted);
					if (decision.remember) trustStore.set(cwd, trusted);
					return trusted;
				},
			} : undefined,
		});
		bindProviderNetwork(services.modelRuntime, join(agentDir, 'models.json'));
		void loadModelPrefs(agentDir).catch(() => {});
		const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
		trackFileChanges(created.session, fileChanges);
		return {
			...created,
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
	private pendingThinking: Extract<AgentUiEvent, { type: 'assistant-thinking' }> | null = null;
	private thinkingTimer: ReturnType<typeof setTimeout> | null = null;
	private idCounter = 0;
	private timelineOrder = 0;
	private readonly toolTitles = new Map<string, string>();
	private readonly toolUpdateAt = new Map<string, number>();
	private sequence = 0;
	private activePromptCalls = 0;
	private activeConfigurationCalls = 0;
	private lifecycleOperation: Promise<unknown> | null = null;
	private closing = false;
	private runtimeModified = new Date().toISOString();
	private pluginReloadError: string | null = null;
	private pluginModelError: string | null = null;
	private contextRefreshSession: PiRuntime['session'] | null = null;
	private readonly projectTrustByCwd: Map<string, boolean>;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private readonly requestExtensionDialog: RequestExtensionDialog;
	private readonly reserveSessionSwitch: (path: string) => () => void;
	private readonly slashCommandExecution = new AsyncLocalStorage<{ name: string; error: string | null }>();
	private readonly queuedPrompt = new AsyncLocalStorage<{ text: string; behavior: 'steer' | 'followUp' | undefined; images: UiQueuedAttachment[]; claimed: boolean }>();
	private queuedMessages: QueuedMessageRecord[] = [];
	private queueMutationDepth = 0;
	private queueRefreshSession: PiRuntime['session'] | null = null;
	private readonly queuedPreviewIds = new WeakMap<object, string>();
	private deliveredEmptyQueued = { steer: 0, followUp: 0 };
	private inputQueue: DurableInputQueue | null = null;
	private inputQueueSession: PiRuntime['session'] | null = null;
	private readonly inputRequest = new AsyncLocalStorage<UiSubmitInput>();
	private readonly inputPending = new Map<string, Promise<UiInputReceipt>>();
	private queueResumePending = false;
	private readonly modelTests = new ModelTestService();
	private readonly projectDefaults = new ProjectDefaultsService();
	private readonly mcp: McpManager;
	private mcpOwnerId: string | null = null;
	private readonly fileChangeTrackers = new WeakMap<PiRuntime['session'], SessionFileChanges>();
	private conversationRuns: ConversationRunTracker | null = null;
	private state: Omit<AgentSnapshot, 'sequence'> = {
		status: 'uninitialized',
		model: '',
		modelName: null,
		modelProvider: '',
		thinkingLevel: 'off',
		availableThinkingLevels: ['off'],
		contextUsage: null,
		cwd: '',
		sessionId: null,
		sessionPath: null,
		messages: [],
		activities: [],
		runs: [],
		queuedCount: 0,
		queuedMessages: [],
		fileChanges: [],
		error: null,
	};

	cwd = '';

	constructor(
		requestProjectTrust: RequestProjectTrust,
		requestExtensionDialog: RequestExtensionDialog,
		projectTrustByCwd: Map<string, boolean>,
		reserveSessionSwitch: (path: string) => () => void,
		mcp: McpManager,
	) {
		this.mcp = mcp;
		this.projectTrustByCwd = projectTrustByCwd;
		this.createRuntime = createRuntimeFactory(requestProjectTrust, this.projectTrustByCwd,
			(session, tracker) => { this.fileChangeTrackers.set(session, tracker); },
			(sessionId, items) => { if (this.runtime?.session.sessionId === sessionId) this.fire({ type: 'file-changes', items }); }, mcp);
		this.requestExtensionDialog = requestExtensionDialog;
		this.reserveSessionSwitch = reserveSessionSwitch;
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
			this.state.queuedCount === 0 && (this.runtime?.session.isIdle ?? true);
	}

	/** Lightweight status projection; never copies transcript or attachment data. */
	getRuntimeSummary(waiting?: UiSessionRuntimeState): UiSessionRuntimeSummary | null {
		if (!this.state.sessionPath) return null;
		const failure = this.state.error;
		const runtime: UiSessionRuntimeState = waiting ?? (this.state.status === 'busy' || this.state.status === 'starting'
			? { phase: 'running' } : failure || this.state.status === 'error'
				? { phase: 'failed', message: failure || this.state.statusMessage } : { phase: 'idle' });
		return { cwd: this.cwd, path: this.state.sessionPath, runtime };
	}

	getLiveSidebarEntry(runtime: UiSessionRuntimeState): UiSessionSummary | null {
		if (!this.state.sessionPath || !this.state.sessionId || runtime.phase === 'idle') return null;
		return { path: this.state.sessionPath, id: this.state.sessionId, firstMessage: this.state.messages.find((message) => message.role === 'user')?.text ?? '',
			modified: this.runtimeModified, messageCount: this.state.messages.length, runtime };
	}

	getSnapshot(): AgentSnapshot {
		return {
			...this.state,
			sequence: this.sequence,
			availableThinkingLevels: [...this.state.availableThinkingLevels],
			contextUsage: this.state.contextUsage ? { ...this.state.contextUsage } : null,
			messages: limitHistoryAttachments(this.state.messages).map((message) => ({ ...message })),
			activities: this.state.activities.map((activity) => ({ ...activity })),
			runs: this.state.runs?.map(run => ({ ...run })),
			queuedMessages: this.state.queuedMessages.map(cloneQueuedMessage),
			fileChanges: this.state.fileChanges.map((file) => ({ ...file })),
		};
	}
	getSessionBranchHead(): { path: string; leafId: string | null } | null { const manager = this.runtime?.session.sessionManager; const path = this.runtime?.session.sessionFile; return manager && path ? { path, leafId: manager.getLeafId() } : null; }

	/** One oldest-first page of the loaded branch's timeline for long conversations. */
	getHistoryPage(offset: number, limit: number): UiHistoryPage {
		if (this.lifecycleOperation) throw new Error('会话正在切换，请稍后加载历史');
		const session = this.runtime?.session;
		if (!session) throw new Error('会话尚未初始化');
		if (!Number.isInteger(offset) || !Number.isInteger(limit) || offset < 0 || limit < 1 || limit > HISTORY_PAGE_MAX) {
			throw new Error('历史分页参数无效');
		}
		return historyPageSlice(historyTimeline(session.sessionManager.getBranch(), this.conversationRuns?.active), offset, limit);
	}

	/** Aggregate usage of the loaded session, matching Pi CLI /session. */
	getMessageAttachment(sessionPath: string, messageId: string, index: number): UiAttachment {
		if (this.lifecycleOperation || this.state.sessionPath !== sessionPath) throw new Error('会话已切换，请重新打开图片');
		if (!Number.isInteger(index) || index < 0 || index > 999) throw new Error('附件索引无效');
		const entry = this.runtime?.session.sessionManager.getBranch().find((item) => item.id === messageId);
		if (!entry || entry.type !== 'message' || entry.message.role !== 'user') throw new Error('当前分支未找到该附件');
		const attachment = userAttachments(entry.message)?.[index];
		if (!attachment) throw new Error('附件不存在');
		const size = attachment.kind === 'image' ? attachment.data.length : Buffer.byteLength(attachment.text, 'utf8');
		if (size > 20 * 1024 * 1024) throw new Error('图片超过单次预览的 20 MiB 限制');
		if (attachment.kind === 'image' && !/^image\/(?:png|jpeg|webp|gif|avif|bmp)$/i.test(attachment.mimeType)) throw new Error('不支持的图片类型');
		return { ...attachment };
	}

	getSessionStats(): UiSessionStats {
		const session = this.runtime?.session;
		if (!session) throw new Error('会话尚未初始化');
		const stats = session.getSessionStats();
		return {
			sessionId: stats.sessionId,
			userMessages: stats.userMessages,
			assistantMessages: stats.assistantMessages,
			toolCalls: stats.toolCalls,
			toolResults: stats.toolResults,
			totalMessages: stats.totalMessages,
			tokens: {
				input: stats.tokens.input, output: stats.tokens.output,
				cacheRead: stats.tokens.cacheRead, cacheWrite: stats.tokens.cacheWrite, total: stats.tokens.total,
			},
			cost: stats.cost,
		};
	}

	getFileCheckpoint() { const session = this.runtime?.session; return session ? this.fileChangeTrackers.get(session)?.getCheckpoint() ?? Promise.resolve(null) : Promise.resolve(null); }
	async rewindFileCheckpoint(request: { id: string; version: string }) {
		const session = this.requireIdleSession(), tracker = this.fileChangeTrackers.get(session);
		if (!tracker) throw new Error('此会话没有可回退的文件检查点');
		return this.runLifecycle(async () => { const result = await tracker.rewindCheckpoint(request);
			this.fire({ type: 'file-changes', items: tracker.restore() }); return result; });
	}

	/** Writes the visible branch to disk in the requested format. */
	async exportSession(outputPath: string, format: 'html' | 'jsonl'): Promise<string> {
		const session = this.runtime?.session;
		if (!session) throw new Error('会话尚未初始化');
		if (typeof outputPath !== 'string' || !outputPath.trim()) throw new Error('导出路径无效');
		return format === 'html' ? session.exportToHtml(outputPath) : session.exportToJsonl(outputPath);
	}

	/** Entry tree with the visible branch marked (3.5). */
	getSessionTree(): UiSessionTreeNode[] {
		const session = this.runtime?.session;
		if (!session) throw new Error('会话尚未初始化');
		const manager = session.sessionManager;
		const activeIds = new Set(manager.getBranch().map((entry) => entry.id));
		const firstLine = (text: string) => text.split(/\r?\n/)[0]!.slice(0, 90);
		const describe = (entry: SessionEntry): { kind: UiSessionTreeNode['kind']; label: string } => {
			if (entry.type !== 'message') {
				if (entry.type === 'compaction') return { kind: 'compaction', label: firstLine(entry.summary) };
				if (entry.type === 'branch_summary') return { kind: 'branch-summary', label: firstLine(entry.summary) };
				if (entry.type === 'custom_message' || entry.type === 'custom') return { kind: 'custom', label: entry.customType };
				return { kind: 'other', label: entry.type };
			}
			const message = entry.message;
			if (message.role === 'user') return { kind: 'user', label: firstLine(userText(message)) };
			if (message.role === 'assistant') {
				const text = assistantText(message);
				if (text.trim()) return { kind: 'assistant', label: firstLine(text) };
				const toolCall = Array.isArray(message.content) ? message.content.find((part) => part?.type === 'toolCall') : undefined;
				return { kind: 'assistant', label: toolCall && toolCall.type === 'toolCall' ? describeToolUse(toolCall.name, toolCall.arguments) : '…' };
			}
			if (message.role === 'toolResult') return { kind: 'tool', label: `tool: ${message.toolName}` };
			return { kind: 'other', label: message.role };
		};
		const mapNode = (node: SessionTreeNode): UiSessionTreeNode[] => {
			const children = node.children.flatMap(mapNode);
			if (isConversationRunEntry(node.entry)) return children;
			const { kind, label } = describe(node.entry);
			return [{
				id: node.entry.id,
				kind,
				label: node.label ?? label,
				childCount: children.length,
				children,
				active: activeIds.has(node.entry.id),
				timestamp: node.entry.timestamp,
			}];
		};
		return manager.getTree().flatMap(mapNode);
	}

	/** Move the visible branch leaf onto another entry (branch switch). */
	async switchSessionBranch(entryId: string): Promise<void> {
		const runtime = this.runtime;
		if (!runtime) throw new Error('会话尚未初始化');
		this.requireIdleSession();
		if (typeof entryId !== 'string' || !entryId.trim()) throw new Error('目标条目无效');
		const result = await this.runExtensionSessionAction(runtime, () => runtime.session.navigateTree(entryId));
		if (result.cancelled) return;
	}

	async listSessions(cwd = this.cwd): Promise<UiSessionSummary[]> {
		if (!cwd) return [];
		const sessions = await listWorkspaceSessions(cwd);
		return sessions.map((session) => ({
			path: session.path,
			id: session.id,
			name: session.name,
			firstMessage: session.firstMessage,
			modified: session.modified.toISOString(),
			messageCount: session.messageCount,
		}));
	}

	renameSession(path: string, name: string): void {
		if (this.closing || this.lifecycleOperation) throw new Error('会话正在切换，请稍后重命名');
		const session = this.runtime?.session;
		if (!session) throw new Error('会话尚未初始化');
		if (session.sessionFile !== path) throw new Error('目标会话已变化，请重试');
		session.setSessionName(name);
		// Pi normally waits for an assistant message before flushing a new file.
		// An explicit name should survive restarts even for an empty conversation.
		// Reopen through the public API so the next SDK append does not recreate it.
		if (!existsSync(path)) {
			const manager = session.sessionManager;
			const header = manager.getHeader();
			if (!header || !manager.isPersisted()) throw new Error('此会话无法保存名称');
			writeFileSync(path, [header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
			manager.setSessionFile(path);
		}
	}

	listSlashCommands(): UiSlashCommand[] {
		const session = this.runtime?.session;
		if (!session) return [];
		const commands = new Map(BUILTIN_SLASH_COMMANDS.map((command) => [command.name, { ...command }]));
		const add = (name: string, description: string | undefined, source: UiSlashCommand['source']) => {
			if (!validSlashCommandName(name) || commands.has(name)) return;
			commands.set(name, { name, description: (description ?? '').slice(0, 500), source, acceptsArguments: true, requiresIdle: false });
		};
		for (const command of session.extensionRunner.getRegisteredCommands()) add(command.invocationName, command.description, 'extension');
		// This precedence matches AgentSession.prompt: extension, skill, then template.
		for (const skill of session.resourceLoader.getSkills().skills) add(`skill:${skill.name}`, skill.description, 'skill');
		for (const template of session.promptTemplates) add(template.name, template.description, 'prompt');
		return [...commands.values()];
	}

	assertIdleSlashCommand(): void { this.requireIdleSession(); }

	async executeSlashCommand(request: UiSlashCommandRequest, command: UiSlashCommand): Promise<void> {
		const args = request.args?.trim() ?? '';
		const attachments = request.attachments ?? [];
		if (!command.acceptsArguments && args) throw new Error(`/${command.name} 不接受参数`);
		if ((command.source === 'builtin' || command.source === 'extension') && attachments.length) throw new Error('此指令不接受附件或上下文，请移除后重试');
		if (command.source !== 'builtin') {
			const session = this.runtime?.session;
			if (!session) throw new Error('Agent is not initialized');
			const behavior = request.behavior ?? (!session.isIdle ? 'followUp' : undefined);
			if (command.source === 'extension') {
				const execution = { name: command.name, error: null as string | null };
				await this.slashCommandExecution.run(execution, async () => {
					await this.prompt(`/${command.name}${args ? ` ${args}` : ''}`, behavior);
					// Pi reports command exceptions through onError but resolves prompt().
					// Only the matching command in this async call may reject this draft.
					if (execution.error) throw new Error(execution.error);
				});
			} else if (command.source === 'prompt' && attachments.length) {
				const template = session.promptTemplates.find((item) => item.name === command.name);
				if (!template) throw new Error('指令已不可用，请刷新后重试');
				await this.prompt(expandSlashPrompt(template.content, args), behavior, attachments, false);
			} else {
				// A separating space also keeps a skill without arguments recognizable
				// when the text-attachment frame begins with a newline.
				await this.prompt(`/${command.name}${args || attachments.length ? ` ${args}` : ''}`, behavior, attachments);
			}
			return;
		}
		const session = this.requireIdleSession();
		if (command.name === 'name') {
			if (!args || args.length > 200 || /[\r\n]/u.test(args)) throw new Error('请输入 1–200 字符的会话名称：/name <名称>');
			if (!session.sessionFile) throw new Error('此会话无法保存名称');
			this.renameSession(session.sessionFile, args);
			this.fire({ type: 'sessions-changed', cwd: this.cwd });
			return;
		}
		if (command.name !== 'compact' && command.name !== 'reload') throw new Error('不支持的指令');
		this.activeConfigurationCalls += 1;
		this.fire({ type: 'status', status: 'busy' });
		try {
			if (command.name === 'compact') await session.compact(args || undefined);
			else await session.reload();
			this.fireReady();
			this.fire({ type: 'sessions-changed', cwd: this.cwd });
		} finally {
			this.activeConfigurationCalls -= 1;
			if (this.runtime?.session === session) this.fire({ type: 'status', status: session.isIdle ? 'idle' : 'busy' });
		}
	}

	/** Return only display metadata for models with usable provider authentication. */
	listModels(): UiModelSummary[] {
		const session = this.runtime?.session;
		if (!session) return [];
		const disabledByProvider = getCachedDisabledModels();
		return session.modelRuntime.getAvailableSnapshot()
			.filter((model) => !disabledByProvider[model.provider]?.includes(model.id))
			.map((model) => ({
				provider: model.provider,
				id: model.id,
				name: model.name,
				reasoning: model.reasoning,
				input: [...model.input],
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				thinkingLevels: getSupportedThinkingLevels(model),
				...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
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

	get agentDirectory(): string {
		if (!this.runtime) throw new Error('Agent is not initialized');
		return this.runtime.services.agentDir;
	}

	usesExtensionProvider(provider: string): boolean {
		return this.runtime?.session.modelRuntime.getRegisteredProviderIds().includes(provider) ?? false;
	}

	listModelProviders(document: ProviderDocument, builtinIds: Set<string>): UiModelProvider[] {
		const runtime = this.runtime?.session.modelRuntime;
		if (!runtime) return [];
		const providers = new Map(runtime.getProviders().map((provider) => [provider.id, provider]));
		const ids = new Set([...providers.keys(), ...Object.keys(document.data.providers)]);
		const registered = new Set(runtime.getRegisteredProviderIds());
		const disabledByProvider = getCachedDisabledModels();
		return [...ids].map((id): UiModelProvider => {
			const config = Object.hasOwn(document.data.providers, id) ? document.data.providers[id] : undefined;
			const custom = config !== undefined;
			const credential = readStoredCredential(id, join(this.agentDirectory, 'auth.json'));
			return {
				provider: id, name: typeof config?.name === 'string' ? config.name : providers.get(id)?.name ?? id,
				custom, editable: custom && !builtinIds.has(id) && !registered.has(id) && isEditableProvider(config!) && (!credential || credential.type === 'api_key'),
				configured: runtime.getProviderAuthStatus(id).configured,
				baseUrl: safeProviderUrl(config?.baseUrl), api: typeof config?.api === 'string' ? config.api : null,
				headerNames: config?.headers && typeof config.headers === 'object' && !Array.isArray(config.headers) ? Object.keys(config.headers) : [],
				...(typeof config?.desktopUseSystemProxy === 'boolean' ? { useSystemProxy: config.desktopUseSystemProxy } : {}),
				models: runtime.getModels(id).map((model) => ({ provider: model.provider, id: model.id, name: model.name, reasoning: model.reasoning,
					input: [...model.input], contextWindow: model.contextWindow, maxTokens: model.maxTokens, thinkingLevels: getSupportedThinkingLevels(model),
					...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}) })),
				...(disabledByProvider[id]?.length ? { disabledModels: [...disabledByProvider[id]!] } : {}),
			};
		}).sort((a, b) => a.provider.localeCompare(b.provider));
	}

	async discoverModels(request: UiDiscoverProviderModelsRequest, document: ProviderDocument): Promise<UiProviderModelDiscovery> {
		const runtime = this.runtime?.session.modelRuntime;
		if (!runtime) throw new Error('Agent is not initialized');
		const provider = request.provider;
		const model = provider ? runtime.getModels(provider)[0] : undefined;
		if (provider && !runtime.getProvider(provider)) throw new Error('供应商不存在，请刷新后重试');
		const config = provider && Object.hasOwn(document.data.providers, provider) ? document.data.providers[provider] : undefined;
		const savedUrl = safeProviderUrl(config?.baseUrl) ?? safeProviderUrl(model?.baseUrl);
		const baseUrl = request.baseUrl ?? savedUrl;
		const api = request.api ?? config?.api ?? model?.api;
		if (!baseUrl || !CUSTOM_PROVIDER_APIS.includes(api as UiProviderApi)) throw new Error('此供应商不支持标准模型列表接口，请使用手动配置或添加自定义供应商');
		const sameOrigin = savedUrl && new URL(savedUrl).origin === new URL(baseUrl).origin;
		if (provider && !sameOrigin && (request.apiKey === undefined || Object.values(request.headers ?? {}).includes(null))) {
			throw new Error('供应商地址已改变，请重新输入密钥和请求头值后获取模型');
		}
		const useSystemProxy = request.useSystemProxy ?? (typeof config?.desktopUseSystemProxy === 'boolean' ? config.desktopUseSystemProxy : undefined);
		const discover = async () => {
			let key = request.apiKey;
			let headers = new Headers();
			if (model && sameOrigin) {
				try {
					const auth = await runtime.getAuth(model, { apiKey: key, signal: AbortSignal.timeout(15000) });
					key ??= auth?.auth.apiKey;
					const resolvedHeaders = auth?.auth.headers ?? runtime.getCompatibilityRequestConfig(model).headers;
					headers = new Headers(Object.entries(resolvedHeaders ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
				} catch { throw new Error('无法读取供应商凭据，请检查密钥或登录状态后重试'); }
			}
			if (request.headers !== undefined) {
				const saved = new Headers(headers);
				const storedNames = config?.headers && typeof config.headers === 'object' ? Object.keys(config.headers) : [];
				for (const name of storedNames) headers.delete(name);
				for (const [name, value] of Object.entries(request.headers)) {
					if (value === null) {
						if (!sameOrigin || !storedNames.some((item) => item.toLowerCase() === name.toLowerCase()) || !saved.has(name)) throw new Error('要保留的请求头已不存在，请刷新后重试');
						headers.set(name, saved.get(name)!);
					} else headers.set(name, value);
				}
			}
			return discoverProviderModels({ baseUrl, api: api as UiProviderApi, apiKey: key, headers: Object.fromEntries(headers) });
		};
		return useSystemProxy === undefined ? discover() : runWithProviderNetwork(useSystemProxy, discover);
	}

	lockProviderConfiguration(): () => void {
		if (this.closing || !this.canEvict) throw new Error('有会话仍在运行或更新设置，请等待全部会话空闲后修改供应商');
		this.activeConfigurationCalls += 1;
		return () => { this.activeConfigurationCalls -= 1; };
	}

	lockPluginConfiguration(): () => void {
		if (this.closing || !this.canEvict) throw new Error('有会话仍在运行或更新设置，请等待全部会话空闲后修改插件');
		this.activeConfigurationCalls += 1;
		return () => { this.activeConfigurationCalls -= 1; };
	}

	getPluginCatalog(): Promise<UiPluginCatalog> {
		if (!this.runtime) throw new Error('Agent is not initialized');
		return readPluginCatalog(this.runtime.services);
	}

	applyPluginMutation(input: UiPluginMutation): Promise<void> {
		if (!this.runtime) throw new Error('Agent is not initialized');
		return applyPluginMutation(this.runtime.services, input);
	}

	previewPluginResource(request: { cwd: string; path: string; kind: UiPluginResourceKind; scope: UiPluginScope }): Promise<UiPluginResourcePreview> {
		if (!this.runtime) throw new Error('Agent is not initialized');
		return readPluginResourcePreview(this.runtime.services, request);
	}

	/** Resolve without installing, including an installed npm version that no longer matches its specification. */
	async pluginReloadBlockers(): Promise<string[]> {
		if (!this.runtime) return [];
		const services = this.runtime.services;
		await services.settingsManager.reload();
		const manager = new DefaultPackageManager(services);
		const missing = new Set(manager.listConfiguredPackages().filter((item) => !item.installedPath).map((item) => item.source));
		await manager.resolve(async (source) => { missing.add(source); return 'skip'; });
		const errors = services.settingsManager.drainErrors().map((item) => item.error.message);
		return [...errors, ...[...missing].map((source) => `插件包缺失或版本不匹配：${source}`)];
	}

	async reloadPlugins(): Promise<string[]> {
		const session = this.runtime?.session;
		if (!session) return [];
		const previousModel = session.model;
		const previousModelError = this.pluginModelError;
		const registeredProviders = session.modelRuntime.getRegisteredProviderIds();
		try {
			// SDK reload preserves ModelRuntime, including extension registrations.
			// Remove them first so disabling an extension removes its providers too.
			for (const provider of registeredProviders) session.modelRuntime.unregisterProvider(provider);
			await session.reload();
			const result = await session.modelRuntime.refresh({ allowNetwork: false });
			this.pluginReloadError = null;
			this.pluginModelError = null;
			if (previousModel) {
				const model = session.modelRuntime.getModel(previousModel.provider, previousModel.id);
				if (model) session.agent.state.model = model;
				else if (registeredProviders.includes(previousModel.provider) || previousModelError) this.pluginModelError = '当前模型所属插件已停用，请选择其他可用模型后继续';
			}
			this.fireReady();
			return [
				...session.resourceLoader.getExtensions().errors.map((item) => `${item.path}：${item.error}`),
				...result.errors.values(),
				...(this.pluginModelError ? [this.pluginModelError] : []),
			].map((item) => typeof item === 'string' ? item : item.message);
		} catch (error) {
			this.pluginReloadError = `插件重载失败，请修复后重新加载：${errorMessage(error)}`;
			return [this.pluginReloadError];
		}
	}

	async refreshModelProvider(provider: string, rebind = true): Promise<void> {
		const session = this.runtime?.session;
		if (!session) return;
		const result = await session.modelRuntime.refresh({ providers: [provider], allowNetwork: false });
		if (result.aborted || result.errors.size || session.modelRuntime.getError()) throw new Error('Pi 无法刷新供应商配置');
		if (rebind && session.model?.provider === provider) {
			const updated = session.modelRuntime.getModel(provider, session.model.id);
			if (!updated) throw new Error('当前模型仍被会话使用，请先切换模型');
			if (JSON.stringify(updated) !== JSON.stringify(session.model)) await session.setModel(updated);
			this.fire({ type: 'model', ...modelSelection(session) });
		}
	}

	async writeProviderCredential(provider: string, encodedKey: string | undefined): Promise<void> {
		const session = this.runtime?.session;
		if (!session) throw new Error('Agent is not initialized');
		if (encodedKey === undefined) { await session.modelRuntime.logout(provider); return; }
		await session.modelRuntime.login(provider, 'api_key', {
			prompt: async (prompt) => { if (prompt.type !== 'secret') throw new Error('该供应商需要交互式登录'); return encodedKey; }, notify: () => {},
		});
	}

	/** Select the session model, optionally retaining the user's existing default. */
	async setModel(provider: string, id: string, persist = true): Promise<void> {
		const session = this.requireIdleSession();
		if (typeof provider !== 'string' || typeof id !== 'string') throw new Error('模型参数无效');
		const model = session.modelRuntime.getAvailableSnapshot().find((item) => item.provider === provider && item.id === id);
		if (!model) throw new Error(`模型不可用：${provider}/${id}`);
		this.activeConfigurationCalls += 1;
		try {
			await session.setModel(model, { persist });
			this.pluginModelError = null;
			this.fire({ type: 'model', ...modelSelection(session) });
		} finally {
			this.activeConfigurationCalls -= 1;
		}
	}

	/** Pi clamps the requested level to the selected model's supported levels. */
	async setThinkingLevel(level: UiThinkingLevel, persist = true): Promise<void> {
		const session = this.requireIdleSession();
		if (!THINKING_LEVELS.includes(level)) throw new Error('思考级别无效');
		session.setThinkingLevel(level, { persist });
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
					return literalApiKey(key.trim());
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

	/** Each Pi runtime caches availability even though its credential file is shared. */
	async refreshProviderAuth(provider: string): Promise<void> {
		const session = this.runtime?.session;
		if (!session?.modelRuntime.getProvider(provider)) return;
		this.activeConfigurationCalls += 1;
		try {
			const result = await session.modelRuntime.refresh({ providers: [provider], allowNetwork: false });
			const error = result.errors.get(provider);
			if (error) throw error;
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
			const restorePath = sessionPath ?? (fresh ? undefined : (await listWorkspaceSessions(cwd))[0]?.path);
			const sessionManager = restorePath
				? SessionManager.open(restorePath, undefined, cwd)
				: SessionManager.create(cwd);
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

	private inputQueueScope(requested?: UiInputQueueScope): UiInputQueueScope {
		const session = this.runtime?.session;
		if (!session || this.lifecycleOperation || this.closing) throw new Error('会话正在切换，请稍后访问队列');
		const current = { cwd: this.cwd, sessionPath: session.sessionFile ?? null, sessionId: session.sessionId };
		if (requested !== undefined) {
			const scope = requireInputQueueScope(requested);
			if (sessionPathKey(scope.cwd) !== sessionPathKey(current.cwd) || scope.sessionId !== current.sessionId
				|| (scope.sessionPath === null ? current.sessionPath !== null : current.sessionPath === null || sessionPathKey(scope.sessionPath) !== sessionPathKey(current.sessionPath))) throw new Error('输入队列所属会话已变化，请返回原会话后重试');
		}
		return current;
	}
	getInputQueue(requested?: UiInputQueueScope): UiInputQueue {
		const scope = this.inputQueueScope(requested);
		return { ...(this.inputQueue?.snapshot() ?? { version: 0, paused: false, items: [] }), scope };
	}
	checkPluginUpdate(request: PluginUpdateCheck) { if (!this.runtime) throw new Error('会话尚未初始化'); return checkPluginUpdate(this.runtime.services, request); }
	testProviderModel(request: ModelTestRequest) { if (!this.runtime) throw new Error('会话尚未初始化'); return this.modelTests.test(this.runtime.session.modelRuntime, request); }
	cancelProviderModelTest(id: string): void { this.modelTests.cancel(id); }
	getProjectDefaults() { if (!this.runtime) throw new Error('会话尚未初始化'); return this.projectDefaults.snapshot(this.cwd, this.agentDirectory, this.runtime.services.settingsManager.isProjectTrusted()); }
	saveProjectDefaults(request: ProjectDefaultsWrite) { if (!this.runtime) throw new Error('会话尚未初始化'); return this.projectDefaults.save(this.cwd, this.agentDirectory, this.runtime.services.settingsManager.isProjectTrusted(), request); }

	mutateInputQueue(request: UiInputQueueMutation): UiInputQueue {
		if (this.lifecycleOperation || this.closing) throw new Error('会话正在切换，请稍后修改队列');
		if (!this.inputQueue) throw new Error('输入队列尚未初始化');
		const scope = this.inputQueueScope(request?.scope);
		return { ...this.inputQueue.mutate(request), scope };
	}

	async submitInput(request: UiSubmitInput): Promise<UiInputReceipt> {
		if (!request || request.sessionId !== this.runtime?.session.sessionId || typeof request.text !== 'string' || request.text.length > 200_000) throw new Error('输入所属会话已变化或文字无效');
		const queue = this.inputQueue; if (!queue) throw new Error('输入队列尚未初始化');
		const raw = withTextAttachments(request.text, request.attachments ?? []); imageAttachments(request.attachments ?? []);
		const previous = queue.begin(request, raw);
		const existing = this.inputPending.get(request.id); if (existing) return existing;
		if (previous) { if (previous.state === 'failed') throw new Error(previous.message ?? '此输入之前未能接收'); return previous; }
		const operation = this.inputRequest.run(request, () => this.prompt(request.text, request.behavior, request.attachments).then(() => {
			queue.acknowledge(request.id); return queue.receipt(request.id)!;
		}, (error: unknown) => { queue.fail(request.id, error); throw error; }).finally(() => { this.inputPending.delete(request.id); }));
		this.inputPending.set(request.id, operation); return operation;
	}

	/** Acknowledge after pi accepts the prompt, while the run continues through events. */
	async prompt(text: string, behavior?: 'steer' | 'followUp', attachments: UiAttachment[] = [], expandPromptTemplates = true): Promise<void> {
		if (this.lifecycleOperation) throw new Error('会话正在切换，请稍后发送消息');
		if (this.pluginReloadError || this.pluginModelError) throw new Error(this.pluginReloadError ?? this.pluginModelError!);
		const session = this.runtime?.session;
		if (!session) throw new Error('Agent is not initialized');
		if (this.activeConfigurationCalls > 0) throw new Error('设置正在更新，请稍后发送消息');
		if (this.activePromptCalls > 0 && session.isIdle) {
			throw new Error('上一条消息仍在接收中，请稍后重试');
		}
		const promptText = withTextAttachments(text, attachments);
		const images = imageAttachments(attachments);
		const tracker = this.conversationRuns;
		const startedRun = session.isIdle && !tracker?.active ? tracker?.begin() : undefined;
		if (this.state.status === 'idle') this.fire({ type: 'status', status: 'busy' });
		this.activePromptCalls += 1;
		await new Promise<void>((resolve, reject) => {
			let acknowledged = false;
			void this.queuedPrompt.run({
				text: promptText, behavior, claimed: false,
				images: attachments.filter((attachment) => attachment.kind === 'image').map(({ kind, name, mimeType }) => ({ kind, name, mimeType })),
			}, () => session.prompt(promptText, {
				expandPromptTemplates,
				streamingBehavior: behavior,
				images,
				preflightResult: (accepted) => {
					// SDK abort only cancels an already-started agent loop. A request
					// cancelled during auth/hooks must not start a fresh loop afterward.
					if (accepted && startedRun && tracker?.wasCancelled(startedRun.id)) throw new Error('请求已取消');
					if (accepted && !acknowledged) {
						acknowledged = true;
						resolve();
					}
				},
			})).catch((error: unknown) => {
				if (session.isIdle) { this.finishInterruptedAssistant(errorMessage(error)); tracker?.finish('failed'); }
				this.fire({ type: 'error', message: errorMessage(error) });
				if (!acknowledged) {
					acknowledged = true;
					reject(error);
				}
			}).finally(() => {
				this.activePromptCalls -= 1;
				// Handled extension/input commands may never emit agent_start/settled.
				if (startedRun && tracker?.active?.id === startedRun.id && session.isIdle) tracker.finish(this.assistantId ? 'interrupted' : undefined);
				if (this.activePromptCalls === 0 && (this.runtime?.session ?? session).isIdle && this.state.status === 'busy') {
					this.finishInterruptedAssistant();
					this.fire({ type: 'status', status: 'idle' });
				}
			});
		});
	}

	/** Rewind the visible branch to just before a sent user message and resend the edited text. */
	async editUserMessage(entryId: string, text: string, attachments?: UiAttachment[]): Promise<void> {
		const runtime = this.runtime;
		if (!runtime) throw new Error('Agent is not initialized');
		this.requireIdleSession();
		// History previews may omit heavy attachments. Read the originals before
		// rewinding so an edit/regenerate never silently loses those attachments.
		const entry = runtime.session.sessionManager.getEntry(entryId);
		const preserved = attachments ?? (entry?.type === 'message' && entry.message.role === 'user' ? userAttachments(entry.message) : undefined);
		const result = await this.runExtensionSessionAction(runtime, () => runtime.session.navigateTree(entryId));
		if (result.cancelled) return;
		await this.prompt(text, undefined, preserved);
	}

	/** Fork the conversation in place: move the visible branch leaf to an assistant message so the next prompt grows a new branch. */
	async forkAssistantMessage(entryId: string): Promise<void> {
		const runtime = this.runtime;
		if (!runtime) throw new Error('Agent is not initialized');
		this.requireIdleSession();
		await this.runExtensionSessionAction(runtime, () => runtime.session.navigateTree(entryId));
	}

	/** Stable-ID transaction; never clears and asynchronously rebuilds SDK payloads. */
	async updateQueuedMessage(id: string, action: 'edit' | 'remove' | 'steer', text?: string): Promise<void> {
		this.mutateInputQueue({ requestId: randomUUID(), expectedVersion: this.getInputQueue().version, id, action, text });
	}
	/**
	 * Ask the current model for a commit message covering the given git context.
	 * Standalone LLM call: never touches the session transcript, so it is safe
	 * even while a conversation turn is streaming.
	 */
	async generateCommitMessage(context: string): Promise<string> {
		const runtime = this.runtime;
		if (!runtime) throw new Error('Agent is not initialized');
		const model = runtime.session.model;
		if (!model) throw new Error('未选择模型，无法生成提交消息');
		if (typeof context !== 'string' || !context.trim()) throw new Error('提交上下文为空');
		const systemPrompt = [
			'你是提交消息生成器。根据给定的 git 状态与差异生成一条提交消息。',
			'规则：',
			'- 使用 Conventional Commits 格式：type(scope?): subject，必要时可附空行 + 正文说明细节。',
			'- type 从 feat/fix/refactor/docs/style/test/chore/perf/build/ci 中选择。',
			'- subject 不超过 72 字符，祈使语气，结尾不加句号。',
			'- 语言：优先与提供的近期提交风格一致；无参考时使用中文。',
			'- 只输出提交消息本身，不要输出任何解释、引用块或代码围栏。',
		].join('\n');
		const message = await runtime.session.modelRuntime.completeSimple(model, {
			systemPrompt,
			messages: [{ role: 'user', content: context, timestamp: Date.now() }],
		});
		const text = message.content
			.filter((block): block is { type: 'text'; text: string } => block.type === 'text')
			.map((block) => block.text)
			.join('')
			.trim()
			// Models occasionally wrap the answer in a code fence; strip one layer.
			.replace(/^```[a-z]*\n?/i, '')
			.replace(/\n?```$/, '');
		if (!text) throw new Error('模型未返回提交消息');
		return text;
	}

	/** Abort the active run. */
	async abort(): Promise<void> {
		this.conversationRuns?.requestCancel();
		await this.runtime?.session.abort();
		this.finishInterruptedAssistant();
		this.conversationRuns?.finish('cancelled');
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

	private async runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
		if (this.closing) throw new Error('应用正在退出');
		if (this.lifecycleOperation) throw new Error('会话正在切换，请稍后再试');
		const current = Promise.resolve().then(() => {
			if (this.closing) throw new Error('应用正在退出');
			return operation();
		});
		this.lifecycleOperation = current;
		try {
			return await current;
		} finally {
			if (this.lifecycleOperation === current) this.lifecycleOperation = null;
		}
	}

	private requireIdleSession(): PiRuntime['session'] {
		if (this.closing) throw new Error('应用正在退出');
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
		if (this.conversationRuns?.manager !== runtime.session.sessionManager) {
			this.conversationRuns?.finish('interrupted');
			const manager = runtime.session.sessionManager;
			this.conversationRuns = new ConversationRunTracker(manager,
				run => { if (this.runtime?.session.sessionManager === manager) this.fire({ type: 'run', run }); },
				error => this.fire({ type: 'error', message: `流程时间记录无法保存：${errorMessage(error)}` }));
		}
		if (this.mcpOwnerId && this.mcpOwnerId !== runtime.session.sessionId) await this.mcp.disposeOwner(this.mcpOwnerId);
		this.mcpOwnerId = runtime.session.sessionId;
		this.unsubscribe?.();
		this.unsubscribe = null;
		await runtime.session.bindExtensions({
			uiContext: this.createExtensionUiContext(),
			mode: 'rpc',
			commandContextActions: {
				waitForIdle: () => runtime.session.waitForIdle(),
				newSession: (options) => this.runExtensionSessionAction(runtime, () => runtime.newSession(options)),
				fork: (id, options) => this.runExtensionSessionAction(runtime, () => runtime.fork(id, options)),
				navigateTree: (id, options) => this.runExtensionSessionAction(runtime, () => runtime.session.navigateTree(id, options)),
				switchSession: (path, options) => this.runExtensionSessionAction(runtime, async () => {
					const release = this.reserveSessionSwitch(path);
					try {
						if (!(await this.listSessions()).some((session) => session.path === path)) throw new Error('会话不属于当前工作区');
						if (runtime.session.sessionFile === path) return { cancelled: false };
						return await runtime.switchSession(path, { ...options, cwdOverride: this.cwd });
					} finally { release(); }
				}),
				reload: () => this.runExtensionSessionAction(runtime, () => runtime.session.reload()),
			},
			onError: ({ extensionPath, event, error }) => {
				const message = `Pi 扩展 ${extensionPath}：${error}`;
				const execution = this.slashCommandExecution.getStore();
				if (execution && event === 'command' && extensionPath === `command:${execution.name}`) execution.error = message;
				if (event === 'command') this.conversationRuns?.assistantEnd('error');
				this.fire({ type: 'error', message });
			},
		});
		if (this.inputQueueSession !== runtime.session) {
			this.inputQueue?.dispose();
			this.inputQueueSession = runtime.session;
			this.inputQueue = new DurableInputQueue(runtime.session, { cwd: this.cwd, sessionPath: runtime.session.sessionFile ?? null }, join(runtime.services.agentDir, 'desktop-inputs', 'queues'), new AttachmentStore(join(runtime.services.agentDir, 'desktop-inputs', 'attachments')), {
				currentInput: () => this.inputRequest.getStore(),
				preview: (message) => {
					const names = this.inputRequest.getStore()?.attachments?.filter((item) => item.kind === 'image') ?? this.queuedPrompt.getStore()?.images ?? [];
					let image = 0; return { text: userText(message as MessageLike), attachments: (userAttachments(message as MessageLike) ?? []).map(({ kind, name, mimeType }) => ({ kind, mimeType, name: kind === 'image' ? names[image++]?.name ?? name : name })) };
				},
				changed: () => { const snapshot = this.inputQueue?.snapshot(); if (snapshot) this.fire({ type: 'queue', count: snapshot.items.length, items: snapshot.items }); },
				error: (message) => this.fire({ type: 'error', message }),
				resume: () => this.scheduleQueueResume(),
			});
		}
		this.unsubscribe = runtime.session.subscribe((event) => this.onSessionEvent(event));
	}

	private scheduleQueueResume(): void {
		if (this.queueResumePending) return; this.queueResumePending = true;
		queueMicrotask(() => {
			this.queueResumePending = false;
			if (this.closing || this.lifecycleOperation || this.activePromptCalls || !this.runtime?.session.isIdle) return;
			void this.inputQueue?.resumeIdle().catch((error: unknown) => this.fire({ type: 'error', message: errorMessage(error) }));
		});
	}

	/** SDK command-context actions otherwise default to successful no-ops. Keep
	 * the replacement runtime, subscriptions and renderer snapshot in sync. */
	private async runExtensionSessionAction<T>(runtime: PiRuntime, action: () => Promise<T>): Promise<T> {
		if (this.runtime !== runtime) throw new Error('扩展指令的会话已失效');
		return this.runLifecycle(async () => {
			if (this.activeConfigurationCalls > 0 || this.activePromptCalls > 1 || !runtime.session.isIdle) throw new Error('当前会话仍在运行，请等待完成后执行此指令');
			let invalidated = false;
			let rebound = false;
			runtime.setBeforeSessionInvalidate(() => {
				invalidated = true;
				this.unsubscribe?.();
				this.unsubscribe = null;
			});
			runtime.setRebindSession(async () => {
				await this.bindSession();
				rebound = true;
				this.fireReady();
			});
			this.fire({ type: 'status', status: 'starting' });
			try {
				const result = await action();
				if (!rebound) this.fireReady();
				this.fire({ type: 'sessions-changed', cwd: this.cwd });
				return result;
			} catch (error) {
				if (invalidated && !rebound) {
					this.conversationRuns?.finish('failed');
					this.runtime = null;
					this.unsubscribe?.();
					this.unsubscribe = null;
					try { await runtime.dispose(); } catch { /* Preserve the replacement failure. */ }
					this.fire({ type: 'reset', cwd: this.cwd });
					this.fire({ type: 'status', status: 'error' });
				}
				throw error;
			} finally {
				runtime.setRebindSession(undefined);
				runtime.setBeforeSessionInvalidate(undefined);
				if (this.runtime === runtime) this.fire({ type: 'status', status: runtime.session.isIdle ? 'idle' : 'busy' });
			}
		});
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
		this.conversationRuns?.finish('interrupted'); this.conversationRuns = null;
		this.modelTests.dispose();
		if (this.mcpOwnerId) await this.mcp.disposeOwner(this.mcpOwnerId);
		this.mcpOwnerId = null;
		this.inputQueue?.dispose(); this.inputQueue = null; this.inputQueueSession = null;
		this.pluginReloadError = null;
		this.pluginModelError = null;
		this.clearPendingThinking();
		this.contextRefreshSession = null;
		this.queueRefreshSession = null;
		this.queuedMessages = [];
		this.deliveredEmptyQueued = { steer: 0, followUp: 0 };
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
		this.clearPendingThinking();
		this.assistantId = null;
		this.toolTitles.clear();
		this.toolUpdateAt.clear();
		const timeline = historyTimeline(session.sessionManager.getBranch(), this.conversationRuns?.active);
		// Long branches stream only the newest window; older entries load page-by-page.
		const recent = trimRecentTimeline(timeline, READY_HISTORY_LIMIT);
		this.timelineOrder = timeline.nextOrder;
		this.fire({
			type: 'ready',
			...modelSelection(session),
			cwd: this.cwd,
			sessionId: session.sessionId,
			sessionPath: session.sessionFile ?? null,
			messages: recent.messages,
			activities: recent.activities,
			runs: recent.runs,
			fileChanges: this.fileChangeTrackers.get(session)?.restore() ?? [],
			historyTotal: recent.historyTotal,
		});
		this.publishQueue({ steering: session.getSteeringMessages(), followUp: session.getFollowUpMessages() });
	}

	private publishQueue(queue: SdkQueueSnapshot): void {
		if (this.inputQueue) { const snapshot = this.inputQueue.snapshot(); this.fire({ type: 'queue', count: snapshot.items.length, items: snapshot.items }); return; }
		// A queue rebuild re-emits every intermediate snapshot; publish the final state once instead.
		if (this.queueMutationDepth > 0) return;
		const submitted = this.queuedPrompt.getStore();
		const pending = (values: readonly string[], behavior: 'steer' | 'followUp') => {
			// Pi 0.87 ignores empty text on delivery, leaving its display mirror
			// stale. Subtract only entries observed in the real next-turn preview
			// and subsequently confirmed by the SDK's message_start event.
			this.deliveredEmptyQueued[behavior] = Math.min(this.deliveredEmptyQueued[behavior], values.filter((value) => value === '').length);
			let consumed = this.deliveredEmptyQueued[behavior];
			return values.filter((value) => value !== '' || consumed-- <= 0);
		};
		this.queuedMessages = reconcileQueuedMessages(this.queuedMessages, {
			steering: pending(queue.steering, 'steer'), followUp: pending(queue.followUp, 'followUp'),
		}, (raw, behavior) => {
			const attachments: UiQueuedAttachment[] = (userAttachments({ role: 'user', content: raw }) ?? [])
				.map(({ kind, name, mimeType }) => ({ kind, name, mimeType }));
			// Associate submitted image labels only after the SDK confirms this exact
			// input entered the queue. Transformed/plugin inputs are read from Pi below.
			if (submitted && !submitted.claimed && submitted.text === raw && submitted.behavior === behavior) {
				submitted.claimed = true;
				attachments.unshift(...submitted.images);
			}
			return { id: randomUUID(), text: userText({ role: 'user', content: raw }), behavior, ...(attachments.length ? { attachments } : {}) };
		});
		this.fire({ type: 'queue', count: this.queuedMessages.length, items: this.queuedMessages.map(({ item }) => cloneQueuedMessage(item)) });
		this.scheduleQueueImageRefresh();
	}

	/** Pi's queue_update precedes low-level insertion. A microtask can inspect
	 * the public next-turn preview, including extension-supplied image attachments. */
	private scheduleQueueImageRefresh(): void {
		const session = this.runtime?.session;
		if (!session || this.queueRefreshSession === session || !this.queuedMessages.length) return;
		this.queueRefreshSession = session;
		queueMicrotask(() => {
			if (this.queueRefreshSession !== session) return;
			this.queueRefreshSession = null;
			if (this.runtime?.session !== session) return;
			const behavior = this.queuedMessages.some((record) => record.item.behavior === 'steer') ? 'steer' : 'followUp';
			const candidates = this.queuedMessages.filter((record) => record.item.behavior === behavior);
			let changed = false;
			for (const message of session.agent.peekQueuedMessages()) {
				if (message.role !== 'user') continue;
				const raw = queuedMessageText(message);
				const index = candidates.findIndex((record) => record.raw === raw);
				if (index < 0) continue;
				const [record] = candidates.splice(index, 1);
				this.queuedPreviewIds.set(message, record!.item.id);
				const images = (userAttachments(message) ?? []).filter((attachment) => attachment.kind === 'image');
				const existingImages = record!.item.attachments?.filter((attachment) => attachment.kind === 'image') ?? [];
				const attachments = [
					...images.map(({ kind, name, mimeType }, imageIndex) => ({ kind, name: existingImages[imageIndex]?.name ?? name, mimeType })),
					...(record!.item.attachments?.filter((attachment) => attachment.kind === 'text') ?? []),
				];
				if (JSON.stringify(record!.item.attachments ?? []) === JSON.stringify(attachments)) continue;
				record!.item = { ...record!.item, attachments: attachments.length ? attachments : undefined };
				changed = true;
			}
			if (changed) this.fire({ type: 'queue', count: this.queuedMessages.length, items: this.queuedMessages.map(({ item }) => cloneQueuedMessage(item)) });
		});
	}

	private scheduleContextUsageRefresh(): void {
		const session = this.runtime?.session;
		if (!session || this.contextRefreshSession === session) return;
		this.contextRefreshSession = session;
		// Pi emits message_end before persisting its message. Read in the next
		// microtask so assistant usage and tool results are included in its projection.
		queueMicrotask(() => {
			if (this.contextRefreshSession !== session) return;
			this.contextRefreshSession = null;
			if (this.runtime?.session !== session) return;
			const usage = contextUsage(session);
			const previous = this.state.contextUsage;
			if (previous?.tokens === usage?.tokens && previous?.contextWindow === usage?.contextWindow && previous?.percent === usage?.percent) return;
			this.fire({ type: 'context-usage', contextUsage: usage });
		});
	}

	private reduce(event: AgentUiEvent): void {
		switch (event.type) {
			case 'reset':
				this.queuedMessages = [];
				this.deliveredEmptyQueued = { steer: 0, followUp: 0 };
				this.state = {
					status: 'uninitialized',
					model: '',
					modelName: null,
					modelProvider: '',
					thinkingLevel: 'off',
					availableThinkingLevels: ['off'],
					contextUsage: null,
					cwd: event.cwd,
					sessionId: null,
					sessionPath: null,
					messages: [],
					activities: [],
					runs: [],
					queuedCount: 0,
					queuedMessages: [],
					fileChanges: [],
					error: null,
				};
				break;
			case 'status':
				this.state.status = event.status;
				this.runtimeModified = new Date().toISOString();
				if (event.status === 'busy') this.state.error = null;
				this.state.statusMessage = event.message;
				this.state.retryAttempt = event.attempt;
				this.state.retryMaxAttempts = event.maxAttempts;
				break;
			case 'ready':
				this.state = {
					...this.state,
					model: event.model,
					modelName: event.modelName ?? null,
					modelProvider: event.modelProvider,
					thinkingLevel: event.thinkingLevel,
					availableThinkingLevels: event.availableThinkingLevels,
					contextUsage: event.contextUsage ? { ...event.contextUsage } : null,
					cwd: event.cwd,
					sessionId: event.sessionId,
					sessionPath: event.sessionPath,
					messages: event.messages,
					activities: event.activities,
					runs: event.runs?.map(run => ({ ...run })) ?? [],
					queuedCount: 0,
					queuedMessages: [],
					fileChanges: event.fileChanges.map((file) => ({ ...file })),
					historyTotal: event.historyTotal ?? event.messages.length + event.activities.length,
					error: null,
				};
				break;
			case 'model':
				this.state.model = event.model;
				this.state.modelName = event.modelName ?? null;
				this.state.modelProvider = event.modelProvider;
				this.state.thinkingLevel = event.thinkingLevel;
				this.state.availableThinkingLevels = event.availableThinkingLevels;
				this.state.contextUsage = event.contextUsage ? { ...event.contextUsage } : null;
				break;
			case 'context-usage':
				this.state.contextUsage = event.contextUsage ? { ...event.contextUsage } : null;
				break;
			case 'thinking-level':
				this.state.thinkingLevel = event.level;
				break;
			case 'user-message':
				this.state.messages.push({ id: event.id, order: event.order, runId: event.runId, role: 'user', text: event.text, attachments: event.attachments, attachmentsOmitted: event.attachmentsOmitted, attachmentReferences: event.attachmentReferences, status: 'done' });
				this.state.historyTotal = (this.state.historyTotal ?? this.state.messages.length - 1) + 1;
				break;
			case 'assistant-start':
				this.state.messages.push({ id: event.id, order: event.order, runId: event.runId, role: 'assistant', text: '', status: 'streaming' });
				this.state.historyTotal = (this.state.historyTotal ?? this.state.messages.length - 1) + 1;
				this.state.error = null;
				break;
			case 'run': {
				const runs = this.state.runs ??= [];
				const index = runs.findIndex(run => run.id === event.run.id);
				if (index < 0) runs.push({ ...event.run }); else runs[index] = { ...event.run };
				break;
			}
			case 'assistant-delta': {
				const message = this.state.messages.find((item) => item.id === event.id);
				if (message) message.text += event.delta;
				break;
			}
			case 'assistant-thinking': {
				const message = this.state.messages.find((item) => item.id === event.id);
				if (message?.status === 'streaming') {
					message.thinking = event.thinking;
					message.thinkingStatus = event.thinkingStatus;
					message.thinkingTruncated = event.thinkingTruncated;
				}
				break;
			}
			case 'assistant-end': {
				const message = this.state.messages.find((item) => item.id === event.id);
				if (message) {
					message.text = event.text || message.text;
					message.thinking = event.thinking ?? message.thinking;
					message.thinkingTruncated = event.thinkingTruncated ?? message.thinkingTruncated;
					message.thinkingStatus = event.thinkingStatus ?? (message.thinkingStatus
						? event.errorMessage ? 'error' : event.aborted ? 'interrupted' : 'done'
						: undefined);
					message.status = event.aborted || event.errorMessage ? 'error' : 'done';
					message.errorMessage = event.errorMessage;
				}
				if (event.errorMessage) this.state.error = event.errorMessage;
				break;
			}
			case 'tool': {
				const index = this.state.activities.findIndex((item) => item.id === event.activity.id);
				if (index >= 0) this.state.activities[index] = event.activity;
				else {
					this.state.activities.push(event.activity);
					this.state.historyTotal = (this.state.historyTotal ?? this.state.activities.length - 1) + 1;
				}
				break;
			}
			case 'queue':
				this.state.queuedCount = event.count;
				this.state.queuedMessages = event.items.map(cloneQueuedMessage);
				break;
			case 'file-changes':
				this.state.fileChanges = event.items.map((file) => ({ ...file }));
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

	private clearPendingThinking(): void {
		if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
		this.thinkingTimer = null;
		this.pendingThinking = null;
	}

	/** Retain only a bounded, renderer-safe projection while coalescing token updates. */
	private publishThinking(thinking: UiThinkingOutput, immediate: boolean): void {
		if (!this.assistantId) return;
		const event: Extract<AgentUiEvent, { type: 'assistant-thinking' }> = { type: 'assistant-thinking', id: this.assistantId, ...thinking };
		if (immediate) {
			this.clearPendingThinking();
			this.fire(event);
			return;
		}
		// Snapshots must already include tokens waiting for the next IPC update.
		this.reduce(event);
		this.pendingThinking = event;
		if (this.thinkingTimer) return;
		this.thinkingTimer = setTimeout(() => {
			const pending = this.pendingThinking;
			this.clearPendingThinking();
			if (pending && pending.id === this.assistantId) this.fire(pending);
		}, THINKING_UPDATE_INTERVAL_MS);
	}

	private finishInterruptedAssistant(failure?: string): void {
		if (!this.assistantId) return;
		const id = this.assistantId;
		const message = this.state.messages.find((item) => item.id === id);
		this.assistantId = null;
		this.clearPendingThinking();
		this.fire({ type: 'assistant-end', id, text: message?.text ?? '', aborted: !failure, errorMessage: failure,
			...(message?.thinkingStatus ? {
				thinking: message.thinking ?? '', thinkingStatus: failure ? 'error' : 'interrupted',
				thinkingTruncated: message.thinkingTruncated ?? false,
			} : {}),
		});
	}

	private onSessionEvent(event: AgentSessionEvent): void {
		if (event.type === 'message_end' || event.type === 'tool_execution_end' ||
			event.type === 'entry_appended' || event.type === 'compaction_end' || event.type === 'agent_settled') {
			this.scheduleContextUsageRefresh();
		}
		switch (event.type) {
			case 'agent_start': {
				this.conversationRuns?.begin();
				this.fire({ type: 'status', status: 'busy' });
				return;
			}
			case 'agent_settled': {
				const hadPendingAssistant = this.assistantId !== null;
				this.finishInterruptedAssistant();
				this.conversationRuns?.finish(hadPendingAssistant ? 'interrupted' : undefined);
				// After a completed turn, re-sync the visible timeline from the transcript so
				// live-streamed messages carry real session entry ids (message edit/fork needs
				// them). Interrupted turns have no transcript entry for the partial reply, so
				// skip the resync to keep the interrupted row visible.
				if (!hadPendingAssistant) this.fireReady();
				this.fire({ type: 'status', status: 'idle' });
				return;
			}
			case 'auto_retry_start': {
			this.fire({
				type: 'status',
				status: 'busy',
				message: `自动重试 ${event.attempt}/${event.maxAttempts}`,
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				});
				return;
			}
			case 'queue_update': {
				this.publishQueue(event);
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
					const input = this.inputQueue?.describeInput(message, this.inputRequest.getStore()?.id);
					if (input?.queued && input.behavior === 'followUp' && this.conversationRuns?.active && this.conversationRuns.hasMessages) this.conversationRuns.finish();
					const run = this.conversationRuns?.begin();
					if (this.conversationRuns) this.conversationRuns.hasMessages = true;
					try { this.inputQueue?.consumed(message, this.inputRequest.getStore()?.id); } catch (error) { this.fire({ type: 'error', message: `输入消费回执无法保存：${errorMessage(error)}。重启后需核对再恢复。` }); }
					if (queuedMessageText(message) === '') {
						const deliveredId = this.queuedPreviewIds.get(message);
						const delivered = this.queuedMessages.find((record) => record.item.id === deliveredId);
						const session = this.runtime?.session;
						if (delivered && session) {
							this.deliveredEmptyQueued[delivered.item.behavior] += 1;
							this.publishQueue({ steering: session.getSteeringMessages(), followUp: session.getFollowUpMessages() });
						}
					}
					const preview = limitHistoryAttachments([{ id: this.nextId('user'), order: this.timelineOrder++, role: 'user', status: 'done', text: userText(message), attachments: userAttachments(message) }])[0]!;
					this.fire({ type: 'user-message', id: preview.id, order: preview.order, runId: run?.id, text: preview.text, attachments: preview.attachments, attachmentsOmitted: preview.attachmentsOmitted, attachmentReferences: preview.attachmentReferences });
				} else if (message.role === 'assistant') {
					this.finishInterruptedAssistant();
					this.assistantId = this.nextId('assistant');
					this.fire({ type: 'assistant-start', id: this.assistantId, order: this.timelineOrder++, runId: this.conversationRuns?.begin().id });
					if (this.conversationRuns) this.conversationRuns.hasMessages = true;
				}
				return;
			}
			case 'message_update': {
				const sub = event.assistantMessageEvent;
				if (sub.type === 'text_delta' && this.assistantId) {
					this.fire({ type: 'assistant-delta', id: this.assistantId, delta: sub.delta });
				} else if ((sub.type === 'thinking_start' || sub.type === 'thinking_delta' || sub.type === 'thinking_end') && this.assistantId) {
					const thinkingStatus = sub.type === 'thinking_end' ? 'done' : 'streaming';
					const thinking = assistantThinking(sub.partial, thinkingStatus);
					const block = sub.partial.content[sub.contentIndex];
					const redacted = block?.type === 'thinking' && block.redacted === true;
					if (thinking) this.publishThinking(thinking, sub.type !== 'thinking_delta' || redacted);
					else if (redacted && this.state.messages.find((message) => message.id === this.assistantId)?.thinkingStatus) {
						// A provider may redact a block only when ending it. Clear both
						// its visible projection and any pending token update immediately.
						this.publishThinking({ thinking: '', thinkingStatus, thinkingTruncated: false }, true);
					}
				}
				return;
			}
			case 'message_end': {
				if (event.message.role === 'assistant') this.conversationRuns?.assistantEnd(event.message.stopReason);
				if (event.message.role === 'assistant' && this.assistantId) {
					const id = this.assistantId;
					const thinkingStatus = event.message.stopReason === 'error' ? 'error' : event.message.stopReason === 'aborted' ? 'interrupted' : 'done';
					let thinking = assistantThinking(event.message, thinkingStatus);
					const previous = this.state.messages.find((message) => message.id === id);
					if (!thinking && previous?.thinkingStatus) {
						// Some providers omit already-streamed reasoning from the final payload.
						// Retain those exposed tokens, but honor an explicit final redaction.
						const redacted = event.message.content.some((part) => part.type === 'thinking' && part.redacted);
						thinking = { thinking: redacted ? '' : previous.thinking ?? '', thinkingStatus,
							thinkingTruncated: redacted ? false : previous.thinkingTruncated ?? false };
					}
					this.assistantId = null;
					this.clearPendingThinking();
					this.fire({
						type: 'assistant-end',
						id,
						text: assistantText(event.message),
						...thinking,
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
					activity: {
						id: event.toolCallId, order, runId: this.conversationRuns?.active?.id, tool: event.toolName, title, status: 'running',
						startedAt: Date.now(),
						...toolCallMeta(event.args),
					},
				});
				return;
			}
			case 'tool_execution_update': {
				const now = Date.now();
				if (now - (this.toolUpdateAt.get(event.toolCallId) ?? 0) < 120) return;
				this.toolUpdateAt.set(event.toolCallId, now);
				const title = this.toolTitles.get(event.toolCallId) ?? event.toolName;
				const previous = this.state.activities.find((item) => item.id === event.toolCallId);
				const order = previous?.order ?? this.timelineOrder++;
				this.fire({ type: 'tool', activity: {
					id: event.toolCallId,
					runId: previous?.runId ?? this.conversationRuns?.active?.id,
					order,
					tool: event.toolName,
					title,
					status: 'running',
					startedAt: previous?.startedAt ?? null,
					files: previous?.files ?? null,
					command: previous?.command ?? null,
					...toolResultText(event.partialResult),
				} });
				return;
			}
			case 'tool_execution_end': {
				const title = this.toolTitles.get(event.toolCallId) ?? event.toolName;
				const previous = this.state.activities.find((item) => item.id === event.toolCallId);
				const order = previous?.order ?? this.timelineOrder++;
				const rawText = toolResultRawText(event.result);
				this.toolTitles.delete(event.toolCallId);
				this.toolUpdateAt.delete(event.toolCallId);
				this.fire({
					type: 'tool',
					activity: {
						id: event.toolCallId,
						runId: previous?.runId ?? this.conversationRuns?.active?.id,
						order,
						tool: event.toolName,
						title,
						status: event.isError ? 'error' : 'done',
						startedAt: previous?.startedAt ?? null,
						endedAt: Date.now(),
						files: previous?.files ?? null,
						command: previous?.command ?? null,
						...toolResultText(event.result),
						...toolResultMeta(event.toolName, event.isError, rawText),
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
	private readonly personalization = createPersonalizationService({ userDirectory: homedir(), agentDirectory: getAgentDir() });
	private readonly contexts = new Map<string, SingleAgentService>();
	private readonly waitingContexts = new Map<SingleAgentService, Map<symbol, UiSessionRuntimeState>>();
	private readonly reservedSessionPaths = new Map<string, SingleAgentService>();
	/** Held across the main-process trash move, including cross-volume copies. */
	private readonly deletingSessionPaths = new Map<string, string>();
	private readonly projectTrustByCwd = new Map<string, boolean>();
	private readonly lastContextByCwd = new Map<string, string>();
	private active: SingleAgentService | null = null;
	private activeKey: string | null = null;
	private emit: EventEmitter = () => {};
	private backgroundActivity: (cwd: string, path: string) => void = () => {};
	private sequence = 0;
	private transition: Promise<void> | null = null;
	private trimOperation: Promise<void> | null = null;
	private credentialOperation: Promise<void> | null = null;
	private providerOperation: Promise<void> | null = null;
	private pluginOperation: Promise<UiPluginCatalog> | null = null;
	private pluginWarnings: string[] = [];
	private readonly mcp = new McpManager(getAgentDir());
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
	getPersonalization() { return this.personalization.list(); }
	saveInstruction(request: UiSaveInstructionRequest) { return this.personalization.save(request); }
	checkPluginUpdate(request: PluginUpdateCheck) { const service = this.requirePluginWorkspace(request.cwd); return service.checkPluginUpdate(request); }
	getMcpSnapshot() { const service = this.requireActive(); const id = service.getSnapshot().sessionId; if (!id) throw new Error('会话尚未初始化'); return this.mcp.snapshot(id); }
	saveMcpServer(request: UiMcpSaveRequest) { this.requireMcpTarget(request); return this.mcp.save(request); }
	removeMcpServer(request: UiMcpTarget) { this.requireMcpTarget(request); return this.mcp.remove(request); }
	connectMcpServer(request: UiMcpTarget) { this.requireMcpTarget(request); return this.mcp.connect(request); }
	disconnectMcpServer(request: UiMcpTarget) { this.requireMcpTarget(request); return this.mcp.disconnect(request); }
	testMcpServer(request: UiMcpTarget) { this.requireMcpTarget(request); return this.mcp.test(request); }
	private requireMcpTarget(request: UiMcpTarget | UiMcpSaveRequest): void {
		const service = this.requireActive();
		if (!request || request.cwd !== service.cwd || request.sessionId !== service.getSnapshot().sessionId) throw new Error('MCP 所属会话已改变，请刷新后重试');
	}

	onEvent(fn: EventEmitter): void { this.emit = fn; }
	onBackgroundActivity(fn: (cwd: string, path: string) => void): void { this.backgroundActivity = fn; }

	getSnapshot(): AgentSnapshot {
		const snapshot = this.active?.getSnapshot();
		const sessionRuntimes = [...this.contexts.values()].flatMap((service) => this.runtimeSummary(service) ?? []);
		return snapshot ? { ...snapshot, sequence: this.sequence, sessionRuntimes } : {
			sequence: this.sequence, status: 'uninitialized', model: '', modelName: null, modelProvider: '',
			thinkingLevel: 'off', availableThinkingLevels: ['off'], contextUsage: null, cwd: '', sessionId: null,
			sessionPath: null, messages: [], activities: [], queuedCount: 0, queuedMessages: [], fileChanges: [], error: null,
		};
	}

	/** Forwards to the active context; older timeline slices load on demand. */
	getHistoryPage(offset: number, limit: number): UiHistoryPage {
		return this.requireActive().getHistoryPage(offset, limit);
	}

	getMessageAttachment(sessionPath: string, messageId: string, index: number): UiAttachment {
		return this.requireActive().getMessageAttachment(sessionPath, messageId, index);
	}

	/** Forwards to the active context (3.1). */
	getSessionStats(): UiSessionStats {
		if (!this.active) throw new Error('会话尚未初始化');
		return this.active.getSessionStats();
	}

	/** Writes the visible branch to disk (3.2). */
	exportSession(outputPath: string, format: 'html' | 'jsonl'): Promise<string> {
		if (!this.active) throw new Error('会话尚未初始化');
		return this.active.exportSession(outputPath, format);
	}

	/** Entry tree of the active context (3.5). */
	getSessionTree(): UiSessionTreeNode[] {
		if (!this.active) throw new Error('会话尚未初始化');
		return this.active.getSessionTree();
	}

	/** Branch switch with the plugin guard and cache trim (3.5). */
	switchSessionBranch(entryId: string): Promise<void> {
		if (this.pluginOperation) return Promise.reject(new Error('插件设置正在更新，请稍后再试'));
		return this.requireActive().switchSessionBranch(entryId).finally(() => { void this.trimContexts(); });
	}

	async listSessions(cwd = this.cwd): Promise<UiSessionSummary[]> {
		if (!cwd) return [];
		const sessions = await listWorkspaceSessions(cwd);
		const runtimes = new Map([...this.contexts.values()].flatMap((service) => {
			const summary = this.runtimeSummary(service);
			return summary && summary.cwd === cwd ? [[summary.path, summary.runtime] as const] : [];
		}));
		const result: UiSessionSummary[] = sessions.map((session) => ({
			path: session.path, id: session.id, name: session.name,
			firstMessage: session.firstMessage, modified: session.modified.toISOString(),
			messageCount: session.messageCount,
			...(runtimes.has(session.path) ? { runtime: runtimes.get(session.path)! } : {}),
		}));
		// A runtime can run an extension command before Pi persists its first message.
		// Keep that conversation reachable while it runs or waits for user input.
		for (const service of this.contexts.values()) {
			if (service.cwd !== cwd) continue;
			const summary = this.runtimeSummary(service);
			const live = summary && service.getLiveSidebarEntry(summary.runtime);
			if (live && !result.some((entry) => entry.path === live.path)) result.push(live);
		}
		return result;
	}

	async init({ cwd, sessionPath, fresh, excludeSessionPaths }: AgentInitOptions): Promise<void> {
		if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('工作区路径无效');
		if (sessionPath && fresh) throw new Error('不能同时指定已有会话和新会话');
		if (!sessionPath && !fresh) return this.switchWorkspace(cwd, excludeSessionPaths);
		await this.runTransition(async () => {
			if (sessionPath) {
				if (this.isSessionReserved(sessionPath)) throw new Error(this.reservedSessionPaths.has(sessionPath) ? '扩展正在切换此会话，请稍后重试' : '会话正在删除，请稍后重试');
				const sessions = await this.listSessions(cwd);
				if (!sessions.some((session) => session.path === sessionPath)) throw new Error('会话不属于指定工作区');
				const existing = [...this.contexts.entries()].find(([, service]) =>
					service.cwd === cwd && service.getSnapshot().sessionPath === sessionPath);
				if (existing) {
					this.activate(existing[0], existing[1]);
					return;
				}
			}
			await this.openContext({ cwd, sessionPath, fresh });
			this.fire({ type: 'sessions-changed', cwd });
		});
	}

	async switchWorkspace(cwd: string, excludeSessionPaths: string[] = []): Promise<void> {
		if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('工作区路径无效');
		await this.runTransition(async () => {
			const previous = this.active;
			const previousKey = this.activeKey;
			const remembered = this.lastContextByCwd.get(cwd);
			const existing = remembered ? this.contexts.get(remembered) : undefined;
			if (existing?.hasSession && !excludeSessionPaths.includes(existing.getSnapshot().sessionPath ?? '')) {
				this.activate(remembered!, existing);
				return;
			}
			const sessionPath = (await this.listSessions(cwd)).find((session) => !excludeSessionPaths.includes(session.path))?.path;
			if (sessionPath && this.isSessionReserved(sessionPath)) throw new Error('会话正在切换或删除，请稍后重试');
			const loaded = sessionPath ? [...this.contexts.entries()].find(([, context]) =>
				context.hasSession && context.cwd === cwd && context.getSnapshot().sessionPath === sessionPath) : undefined;
			if (loaded) {
				this.activate(loaded[0], loaded[1]);
				return;
			}
			const key = existing ? remembered! : randomUUID();
			const service = existing ?? this.newContext(key);
			this.active = service;
			this.activeKey = key;
			try {
				await service.init({ cwd, sessionPath, fresh: !sessionPath });
				this.lastContextByCwd.set(cwd, key);
				await this.trimContexts();
			} catch (error) {
				if (!existing) this.contexts.delete(key);
				this.active = previous;
				this.activeKey = previousKey;
				if (previous && previousKey) this.activate(previousKey, previous);
				throw error;
			}
		});
	}

	/** Dispose every idle runtime belonging to a project removed from the desktop workspace list. */
	async forgetWorkspace(cwd: string): Promise<void> {
		const value = typeof cwd === 'string' ? cwd.trim() : '';
		if (!value || value.length > 32768 || value.includes('\0')) throw new Error('工作区路径无效');
		if (this.trimOperation || this.credentialOperation) throw new Error('会话或设置正在更新，请稍后移除项目');
		const keyOf = (path: string) => {
			const key = resolve(path);
			return process.platform === 'win32' ? key.toLowerCase() : key;
		};
		const target = keyOf(value);
		await this.runTransition(async () => {
			if (this.active && keyOf(this.active.cwd) === target) throw new Error('无法移除当前项目，请先切换到其他项目');
			const entries = [...this.contexts.entries()].filter(([, service]) => keyOf(service.cwd) === target);
			if (entries.some(([, service]) => !service.canEvict)
				|| [...this.reservedSessionPaths.values()].some((service) => keyOf(service.cwd) === target)
				|| [...this.deletingSessionPaths.values()].some((deletingCwd) => keyOf(deletingCwd) === target)) {
				throw new Error('项目中仍有会话或扩展正在运行，请结束后再移除');
			}
			const keys = new Set(entries.map(([key]) => key));
			for (const [key] of entries) this.contexts.delete(key);
			for (const [rememberedCwd, key] of this.lastContextByCwd) {
				if (keyOf(rememberedCwd) === target || keys.has(key)) this.lastContextByCwd.delete(rememberedCwd);
			}
			for (const trustedCwd of this.projectTrustByCwd.keys()) {
				if (keyOf(trustedCwd) === target) this.projectTrustByCwd.delete(trustedCwd);
			}
			await Promise.all(entries.map(([, service]) => service.dispose()));
		});
	}

	async switchSession(path: string): Promise<void> {
		const cwd = this.cwd;
		if (!cwd) throw new Error('请先打开工作区');
		await this.runTransition(async () => {
			if (this.isSessionReserved(path)) throw new Error('会话正在切换或删除，请稍后重试');
			if (this.active?.getSnapshot().sessionPath === path) return;
			const existing = [...this.contexts.entries()].find(([, service]) =>
				service.cwd === cwd && service.getSnapshot().sessionPath === path);
			if (existing) {
				this.activate(existing[0], existing[1]);
				return;
			}
			const sessions = await this.listSessions(cwd);
			if (!sessions.some((session) => session.path === path)) throw new Error('会话不属于当前工作区');
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
		const assertAvailable = () => {
			if (this.closing || this.transition || this.isSessionReserved(path)) throw new Error('会话正在切换或删除，请稍后重命名');
		};
		const findLoaded = () => [...this.contexts.values()].find((service) => service.cwd === cwd && service.getSnapshot().sessionPath === path);
		assertAvailable();
		let loaded = findLoaded();
		if (!loaded) {
			const sessions = await this.listSessions(cwd);
			if (!sessions.some((session) => session.path === path)) throw new Error('会话不属于当前工作区');
			assertAvailable();
			loaded = findLoaded();
		}
		if (loaded) loaded.renameSession(path, name);
		else SessionManager.open(path, undefined, cwd).appendSessionInfo(name);
		this.fire({ type: 'sessions-changed', cwd });
	}

	/** Release idle cached writers, then reserve the path until the desktop has moved the file. */
	async prepareSessionDeletion(path: string, cwd: string): Promise<void> {
		if (typeof path !== 'string' || !path || path.length > 32768 || /[\u0000-\u001f\u007f]/.test(path)) throw new Error('会话路径无效');
		if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('工作区路径无效');
		if (this.trimOperation || this.credentialOperation) throw new Error('会话或设置正在更新，请稍后删除');
		await this.runTransition(async () => {
			if (this.isSessionReserved(path)) throw new Error('会话正在切换或删除，请稍后重试');
			const key = sessionPathKey(path);
			const sessions = await this.listSessions(cwd);
			if (!sessions.some((session) => sessionPathKey(session.path) === key)) throw new Error('会话不属于指定工作区');
			const entries = [...this.contexts.entries()].filter(([, context]) => {
				const loadedPath = context.getSnapshot().sessionPath;
				return loadedPath != null && sessionPathKey(loadedPath) === key;
			});
			if (entries.some(([, context]) => context === this.active)) throw new Error('请先切换到其他会话再删除');
			if (entries.some(([, context]) => !context.canEvict)) throw new Error('会话仍在后台运行，请等待完成或停止后再删除');
			this.deletingSessionPaths.set(key, cwd);
			try {
				for (const [contextKey, context] of entries) {
					this.contexts.delete(contextKey);
					if (this.lastContextByCwd.get(context.cwd) === contextKey) this.lastContextByCwd.delete(context.cwd);
				}
				await Promise.all(entries.map(([, context]) => context.dispose()));
			} catch (error) {
				this.deletingSessionPaths.delete(key);
				throw error;
			}
		});
	}

	releaseSessionDeletion(path: string): void {
		this.deletingSessionPaths.delete(sessionPathKey(path));
	}

	listModels(): UiModelSummary[] { return this.active?.listModels() ?? []; }
	async listModelProviders(): Promise<UiModelProvider[]> {
		if (this.providerOperation) { try { await this.providerOperation; } catch { /* Read restored state after an unsuccessful edit. */ } }
		const service = this.requireActive();
		const [document, builtinIds] = await Promise.all([readProviderDocument(join(service.agentDirectory, 'models.json')), getBuiltinProviderIds(), loadModelPrefs(service.agentDirectory)]);
		return service.listModelProviders(document, builtinIds);
	}
	async setModelEnabled(provider: string, modelId: string, enabled: boolean): Promise<void> {
		const providerId = validateProviderId(provider);
		const id = typeof modelId === 'string' ? modelId.trim() : '';
		if (!id || id.length > 200 || /[\u0000-\u001f\u007f]/u.test(id)) throw new Error('模型 ID 无效');
		if (typeof enabled !== 'boolean') throw new Error('模型启用参数无效');
		const service = this.requireActive();
		if (this.credentialOperation || this.trimOperation) throw new Error('会话或设置正在更新，请稍后再修改模型');
		const contexts = [...this.contexts.values()];
		const releases: (() => void)[] = [];
		try { for (const context of contexts) releases.push(context.lockProviderConfiguration()); }
		catch (error) { for (const release of releases) release(); throw error; }
		const operation = Promise.resolve().then(async () => {
			if (!enabled && contexts.some((context) => {
				const snapshot = context.getSnapshot();
				return snapshot.modelProvider === providerId && snapshot.model === id;
			})) throw new Error('当前或后台会话正在使用此模型，不能从选择器隐藏');
			await setModelDisabled(service.agentDirectory, providerId, id, !enabled);
		});
		this.providerOperation = operation;
		try { await operation; }
		finally {
			for (const release of releases) release();
			if (this.providerOperation === operation) this.providerOperation = null;
		}
	}
	async saveCustomProvider(input: UiSaveCustomProviderRequest): Promise<void> {
		const request = validateProviderRequest(input);
		await this.updateCustomProvider(request.provider, request);
	}
	async discoverProviderModels(input: UiDiscoverProviderModelsRequest): Promise<UiProviderModelDiscovery> {
		const request = validateDiscoveryRequest(input);
		const service = this.requireActive();
		const document = await readProviderDocument(join(service.agentDirectory, 'models.json'));
		return service.discoverModels(request, document);
	}
	async removeCustomProvider(provider: string): Promise<void> {
		await this.updateCustomProvider(validateProviderId(provider));
	}
	listSlashCommands(): UiSlashCommand[] { return this.active?.listSlashCommands() ?? []; }
	async executeSlashCommand(request: UiSlashCommandRequest): Promise<void> {
		validateSlashCommandRequest(request);
		if (this.transition) throw new Error('会话正在切换，请稍后再试');
		const service = this.requireActive();
		const snapshot = service.getSnapshot();
		if (snapshot.cwd !== request.cwd || snapshot.sessionId !== request.sessionId) throw new Error('当前会话已变化，请在目标会话中重试指令');
		const command = service.listSlashCommands().find((item) => item.name === request.name);
		if (!command) throw new Error(`未知或不可用的指令：/${request.name}`);
		if (command.source === 'builtin' && command.name === 'reload') {
			if (request.args?.trim()) throw new Error('/reload 不接受参数');
			if (request.attachments?.length) throw new Error('此指令不接受附件或上下文，请移除后重试');
			const catalog = await this.mutatePlugin({ cwd: request.cwd, action: 'reload' });
			if (catalog.warnings.length) this.fire({ type: 'error', message: catalog.warnings.join('\n') });
			return;
		}
		if (command.source === 'builtin' && command.name === 'new') {
			if (request.args?.trim()) throw new Error('/new 不接受参数');
			if (request.attachments?.length) throw new Error('此指令不接受附件或上下文，请移除后重试');
			service.assertIdleSlashCommand();
			await this.runTransition(async () => {
				if (this.active !== service || service.getSnapshot().sessionId !== request.sessionId) throw new Error('当前会话已变化，请重试指令');
				service.assertIdleSlashCommand();
				await this.openContext({ cwd: request.cwd, fresh: true });
			});
			this.fire({ type: 'sessions-changed', cwd: request.cwd });
			return;
		}
		await service.executeSlashCommand(request, command);
	}
	listProviderAuth(): UiProviderAuthStatus[] { return this.active?.listProviderAuth() ?? []; }
	setModel(provider: string, id: string, persist = true): Promise<void> {
		if (this.pluginOperation) return Promise.reject(new Error('插件设置正在更新，请稍后再试'));
		return this.requireActive().setModel(provider, id, persist);
	}
	setThinkingLevel(level: UiThinkingLevel, persist = true): Promise<void> {
		if (this.pluginOperation) return Promise.reject(new Error('插件设置正在更新，请稍后再试'));
		return this.requireActive().setThinkingLevel(level, persist);
	}
	setProviderApiKey(provider: string, key: string): Promise<void> {
		return this.updateProviderCredential(provider, (service) => service.setProviderApiKey(provider, key));
	}
	removeProviderCredential(provider: string): Promise<void> {
		return this.updateProviderCredential(provider, (service) => service.removeProviderCredential(provider));
	}
	listExtensions(): Promise<UiExtensionSummary[]> { return this.requireActive().listExtensions(); }
	async setExtensionEnabled(path: string, enabled: boolean): Promise<void> {
		if (typeof path !== 'string' || typeof enabled !== 'boolean') throw new Error('扩展参数无效');
		const service = this.requireActive();
		await this.runPluginMutation(service.cwd, async () => {
			const item = (await service.listExtensions()).find((entry) => entry.path === path);
			if (!item) throw new Error('未找到 Pi 扩展');
			return { cwd: service.cwd, action: 'set-enabled', path, kind: 'extensions', scope: item.scope, enabled };
		});
	}
	async getPluginCatalog(cwd: string): Promise<UiPluginCatalog> {
		const service = this.requirePluginWorkspace(cwd);
		const catalog = await service.getPluginCatalog();
		return { ...catalog, warnings: [...new Set([...catalog.warnings, ...this.pluginWarnings])] };
	}
	mutatePlugin(input: UiPluginMutation): Promise<UiPluginCatalog> {
		return this.runPluginMutation(input?.cwd, async () => input);
	}
	async previewPluginResource(request: { cwd: string; path: string; kind: UiPluginResourceKind; scope: UiPluginScope }): Promise<UiPluginResourcePreview> {
		return this.requirePluginWorkspace(request?.cwd).previewPluginResource(request);
	}
	prompt(text: string, behavior?: 'steer' | 'followUp', attachments?: UiAttachment[]): Promise<void> {
		if (this.pluginOperation) return Promise.reject(new Error('插件设置正在更新，请稍后发送消息'));
		return this.requireActive().prompt(text, behavior, attachments).finally(() => { void this.trimContexts(); });
	}
	submitInput(request: UiSubmitInput): Promise<UiInputReceipt> { return this.requireActive().submitInput(request).finally(() => { void this.trimContexts(); }); }
	testProviderModel(request: ModelTestRequest) { return this.requireActive().testProviderModel(request); }
	cancelProviderModelTest(id: string): void { for (const context of this.contexts.values()) context.cancelProviderModelTest(id); }
	getProjectDefaults() { return this.requireActive().getProjectDefaults(); }
	saveProjectDefaults(request: ProjectDefaultsWrite) { return this.requireActive().saveProjectDefaults(request); }
	getInputQueue(scope?: UiInputQueueScope): UiInputQueue { return this.requireActive().getInputQueue(scope); }
	getSessionBranchHeads(): Record<string, string | null> { return Object.fromEntries([...this.contexts.values()].flatMap((context) => { const head = context.getSessionBranchHead(); return head ? [[head.path, head.leafId]] : []; })); }
	mutateInputQueue(request: UiInputQueueMutation): UiInputQueue { return this.requireActive().mutateInputQueue(request); }
	getFileCheckpoint() { return this.requireActive().getFileCheckpoint(); }
	rewindFileCheckpoint(request: { id: string; version: string }) { return this.requireActive().rewindFileCheckpoint(request); }
	editUserMessage(entryId: string, text: string, attachments?: UiAttachment[]): Promise<void> {
		if (this.pluginOperation) return Promise.reject(new Error('插件设置正在更新，请稍后发送消息'));
		return this.requireActive().editUserMessage(entryId, text, attachments).finally(() => { void this.trimContexts(); });
	}

	forkAssistantMessage(entryId: string): Promise<void> {
		if (this.pluginOperation) return Promise.reject(new Error('插件设置正在更新，请稍后再试'));
		return this.requireActive().forkAssistantMessage(entryId).finally(() => { void this.trimContexts(); });
	}

	updateQueuedMessage(id: string, action: 'edit' | 'remove' | 'steer', text?: string): Promise<void> {
		if (this.pluginOperation) return Promise.reject(new Error('插件设置正在更新，请稍后再试'));
		return this.requireActive().updateQueuedMessage(id, action, text);
	}

	generateCommitMessage(context: string): Promise<string> {
		if (this.pluginOperation) return Promise.reject(new Error('插件设置正在更新，请稍后再试'));
		return this.requireActive().generateCommitMessage(context);
	}
	abort(): Promise<void> { return this.active?.abort() ?? Promise.resolve(); }

	async dispose(): Promise<void> {
		this.closing = true;
		try { await this.transition; } catch { /* Failed transition has already cleaned up. */ }
		try { await this.credentialOperation; } catch { /* Credential errors are reported to the caller. */ }
		try { await this.providerOperation; } catch { /* Provider errors are reported to the caller. */ }
		try { await this.pluginOperation; } catch { /* Plugin errors are reported to the caller. */ }
		await Promise.allSettled([...this.contexts.values()].map((service) => service.dispose()));
		await this.mcp.dispose();
		this.contexts.clear();
		this.deletingSessionPaths.clear();
		this.active = null;
	}

	private requireActive(): SingleAgentService {
		if (this.closing) throw new Error('应用正在退出');
		if (this.transition) throw new Error('会话正在切换，请稍后再试');
		if (this.providerOperation) throw new Error('供应商配置正在更新，请稍后再试');
		if (this.pluginOperation) throw new Error('插件设置正在更新，当前会话仍在运行，请稍后再试');
		if (!this.active) throw new Error('Agent is not initialized');
		return this.active;
	}

	private requirePluginWorkspace(cwd: string): SingleAgentService {
		const service = this.requireActive();
		if (typeof cwd !== 'string' || cwd !== service.cwd) throw new Error('当前工作区已变化，请返回目标工作区后重试');
		return service;
	}

	private async runPluginMutation(cwd: string, request: () => Promise<UiPluginMutation>): Promise<UiPluginCatalog> {
		const service = this.requirePluginWorkspace(cwd);
		if (this.credentialOperation || this.trimOperation) throw new Error('会话或设置正在更新，请稍后再修改插件');
		const contexts = [...this.contexts.values()];
		const releases: (() => void)[] = [];
		try { for (const context of contexts) releases.push(context.lockPluginConfiguration()); }
		catch (error) { for (const release of releases) release(); throw error; }
		// Reserve before the first await, including request resolution in the legacy API.
		const operation = Promise.resolve().then(async () => {
			const input = await request();
			await service.applyPluginMutation(input);
			this.pluginWarnings = [];
			// Reload touches process-wide extension caches and compatibility providers,
			// so all loaded contexts participate even for a project-scoped mutation.
			for (const context of contexts) {
				try {
					for (const problem of await context.pluginReloadBlockers()) this.pluginWarnings.push(`${context.cwd}：${problem}`);
				} catch (error) { this.pluginWarnings.push(`${context.cwd}：${errorMessage(error)}`); }
			}
			if (this.pluginWarnings.length) {
				this.pluginWarnings.unshift('配置已保存，但未重载任何会话。请先安装或移除缺失包，再重新加载插件；不会自动下载其他包。');
			} else {
				for (const context of contexts) {
					for (const problem of await context.reloadPlugins()) this.pluginWarnings.push(`${context.cwd}：${problem}`);
				}
			}
			const catalog = await service.getPluginCatalog();
			return { ...catalog, warnings: [...new Set([...catalog.warnings, ...this.pluginWarnings])] };
		});
		this.pluginOperation = operation;
		try { return await operation; }
		finally {
			for (const release of releases) release();
			if (this.pluginOperation === operation) this.pluginOperation = null;
		}
	}

	private async updateProviderCredential(provider: string, update: (service: SingleAgentService) => Promise<void>): Promise<void> {
		if (this.credentialOperation) throw new Error('登录信息正在更新，请稍后再试');
		const service = this.requireActive();
		const operation = (async () => {
			await update(service);
			const results = await Promise.allSettled([...this.contexts.values()]
				.filter((context) => context !== service)
				.map((context) => context.refreshProviderAuth(provider)));
			const failure = results.find((result) => result.status === 'rejected');
			if (failure?.status === 'rejected') throw failure.reason;
		})();
		this.credentialOperation = operation;
		try { await operation; } finally {
			if (this.credentialOperation === operation) this.credentialOperation = null;
		}
	}

	private async updateCustomProvider(provider: string, request?: UiSaveCustomProviderRequest): Promise<void> {
		const service = this.requireActive();
		if (this.transition || this.credentialOperation || this.trimOperation) throw new Error('会话或设置正在更新，请稍后再试');
		const contexts = [...this.contexts.values()];
		const releases: (() => void)[] = [];
		try { for (const context of contexts) releases.push(context.lockProviderConfiguration()); }
		catch (error) { for (const release of releases) release(); throw error; }
		const operation = Promise.resolve().then(async () => {
			const directory = service.agentDirectory;
			const path = join(directory, 'models.json');
			const [document, builtinIds] = await Promise.all([readProviderDocument(path), getBuiltinProviderIds()]);
			if (contexts.some((context) => context.usesExtensionProvider(provider))) throw new Error('此供应商 ID 已由已打开工作区的扩展管理，请使用其他 ID');
			const listed = service.listModelProviders(document, builtinIds);
			const existing = listed.find((entry) => entry.provider === provider);
			if (request?.mode === 'create' && existing) throw new Error('供应商 ID 已存在，请使用其他 ID');
			if (request?.mode === 'update' && !existing?.custom) throw new Error('自定义供应商不存在，请刷新后重试');
			if (existing && !existing.editable) throw new Error('此供应商由内置、扩展或高级外部配置管理，不能在此修改');
			if (!request && !existing?.custom) throw new Error('自定义供应商不存在');
			for (const context of contexts) {
				const selected = context.getSnapshot();
				if (selected.modelProvider === provider && (!request || !request.models.some((model) => model.id === selected.model))) {
					throw new Error('供应商或模型仍被已打开的会话使用，请先为这些会话切换模型');
				}
			}
			const next = request ? mergeProvider(document, request) : { ...document.data, providers: { ...document.data.providers } };
			if (!request) delete next.providers[provider];
			else await validateProviderWithSdk(directory, provider, next.providers[provider]!);
			const previousCredential = readStoredCredential(provider, join(directory, 'auth.json'));
			let rollback: (() => Promise<void>) | undefined;
			let credentialChanged = false;
			try {
				if (!request && previousCredential) {
					credentialChanged = true;
					await service.writeProviderCredential(provider, undefined);
				}
				rollback = await commitProviderDocument(path, document, next);
				await this.refreshCustomProviderContexts(contexts, provider, false);
				if (request?.apiKey !== undefined) {
					credentialChanged = true;
					await service.writeProviderCredential(provider, literalApiKey(request.apiKey));
				}
				await this.refreshCustomProviderContexts(contexts, provider);
			} catch {
				let recovered = true;
				const restoreCredential = async () => {
					try { await service.writeProviderCredential(provider, previousCredential?.type === 'api_key' ? previousCredential.key : undefined); }
					catch { recovered = false; }
				};
				// A newly created provider still exists here, so its failed credential
				// can be removed before rolling the catalog back to a missing provider.
				if (request && credentialChanged) await restoreCredential();
				if (rollback) { try { await rollback(); } catch { recovered = false; } }
				try { await this.refreshCustomProviderContexts(contexts, provider, false); } catch { recovered = false; }
				if (!request && credentialChanged) await restoreCredential();
				try { await this.refreshCustomProviderContexts(contexts, provider); } catch { recovered = false; }
				throw new Error(recovered ? '供应商保存失败，原配置已恢复；请检查 URL、协议和凭据存储' : '供应商保存失败，部分配置未能恢复；请检查 models.json 及其 pi-desktop-backup 备份');
			}
		});
		this.providerOperation = operation;
		try { await operation; }
		finally { for (const release of releases) release(); if (this.providerOperation === operation) this.providerOperation = null; }
	}

	private async refreshCustomProviderContexts(contexts: SingleAgentService[], provider: string, rebind = true): Promise<void> {
		const results = await Promise.allSettled(contexts.map((context) => context.refreshModelProvider(provider, rebind)));
		if (results.some((result) => result.status === 'rejected')) throw new Error('Pi 无法同步供应商配置');
	}

	private newContext(key: string): SingleAgentService {
		const service: SingleAgentService = new SingleAgentService(
			(cwd) => this.withRuntimeWait(service, { phase: 'waiting-approval' }, () => this.requestProjectTrust(cwd)),
			(request, signal) => request.kind === 'notify' ? this.requestExtensionDialog(request, signal)
				: this.withRuntimeWait(service, { phase: request.kind === 'confirm' ? 'waiting-approval' : 'waiting-input', message: request.title }, () => this.requestExtensionDialog(request, signal)),
			this.projectTrustByCwd, (path) => {
			if (this.transition || this.isSessionReserved(path)) throw new Error('会话正在切换或删除，请稍后重试');
			if ([...this.contexts.values()].some((context) => context !== service && context.getSnapshot().sessionPath === path)) {
				throw new Error('此会话已在桌面端加载，请通过侧栏切换，避免重复打开');
			}
			this.reservedSessionPaths.set(path, service);
			return () => { if (this.reservedSessionPaths.get(path) === service) this.reservedSessionPaths.delete(path); };
		}, this.mcp);
		service.onEvent(({ event }) => {
			if (this.active === service) this.fire(event);
			else if (event.type === 'assistant-end' || (event.type === 'tool' && event.activity.status === 'done')) {
				const snapshot = service.getSnapshot();
				if (snapshot.sessionPath) {
					this.backgroundActivity(service.cwd, snapshot.sessionPath);
					this.fire({ type: 'sessions-changed', cwd: service.cwd });
				}
			}
			if (event.type === 'status' || event.type === 'ready' || event.type === 'error' || event.type === 'assistant-end') this.publishRuntime(service);
		});
		this.contexts.set(key, service);
		return service;
	}

	private runtimeSummary(service: SingleAgentService): UiSessionRuntimeSummary | null {
		const waits = this.waitingContexts.get(service);
		return service.getRuntimeSummary(waits?.values().next().value);
	}

	private publishRuntime(service: SingleAgentService): void {
		const summary = this.runtimeSummary(service);
		if (summary) this.fire({ type: 'session-runtime', ...summary });
	}

	private async withRuntimeWait<T>(service: SingleAgentService, state: UiSessionRuntimeState, action: () => Promise<T>): Promise<T> {
		const token = Symbol();
		const waits = this.waitingContexts.get(service) ?? new Map<symbol, UiSessionRuntimeState>();
		waits.set(token, state); this.waitingContexts.set(service, waits); this.publishRuntime(service);
		try { return await action(); }
		finally {
			waits.delete(token);
			if (!waits.size) this.waitingContexts.delete(service);
			this.publishRuntime(service);
		}
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
			type: 'ready', model: snapshot.model, modelName: snapshot.modelName ?? null, modelProvider: snapshot.modelProvider,
			thinkingLevel: snapshot.thinkingLevel, availableThinkingLevels: snapshot.availableThinkingLevels,
			contextUsage: snapshot.contextUsage,
			cwd: snapshot.cwd, sessionId: snapshot.sessionId, sessionPath: snapshot.sessionPath,
			messages: snapshot.messages, activities: snapshot.activities,
			runs: snapshot.runs,
			fileChanges: snapshot.fileChanges,
			historyTotal: snapshot.historyTotal,
		});
		this.fire({ type: 'status', status: snapshot.status, message: snapshot.statusMessage });
		this.fire({ type: 'queue', count: snapshot.queuedCount, items: snapshot.queuedMessages });
		if (snapshot.error) this.fire({ type: 'error', message: snapshot.error });
	}

	private fire(event: AgentUiEvent): void { this.emit({ sequence: ++this.sequence, event }); }

	private isSessionReserved(path: string): boolean {
		return this.reservedSessionPaths.has(path) || this.deletingSessionPaths.has(sessionPathKey(path));
	}

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
		if (this.pluginOperation) throw new Error('插件设置正在更新，请稍后再切换会话');
		if (this.providerOperation) throw new Error('供应商配置正在更新，请稍后再切换会话');
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

function modelSelection(session: PiRuntime['session']): Pick<AgentSnapshot, 'model' | 'modelName' | 'modelProvider' | 'thinkingLevel' | 'availableThinkingLevels' | 'contextUsage'> {
	return {
		model: session.model?.id ?? 'unknown',
		modelName: session.model?.name?.trim() || null,
		modelProvider: session.model?.provider ?? '',
		thinkingLevel: session.thinkingLevel,
		availableThinkingLevels: [...session.getAvailableThinkingLevels()],
		contextUsage: contextUsage(session),
	};
}

function contextUsage(session: PiRuntime['session']): UiContextUsage | null {
	const usage = session.getContextUsage();
	if (!usage || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return null;
	const tokens = usage.tokens !== null && Number.isFinite(usage.tokens) && usage.tokens >= 0 ? usage.tokens : null;
	return {
		tokens,
		contextWindow: usage.contextWindow,
		percent: tokens !== null && usage.percent !== null && Number.isFinite(usage.percent) && usage.percent >= 0 ? usage.percent : null,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Match the SDK's queue keys, which concatenate text blocks without a separator. */
function queuedMessageText(message: MessageLike): string {
	return typeof message.content === 'string' ? message.content : (Array.isArray(message.content) ? message.content : [])
		.filter((part): part is { type: 'text'; text: string } => part?.type === 'text' && typeof part.text === 'string')
		.map((part) => part.text).join('');
}

function sessionPathKey(path: string): string {
	const value = resolve(path);
	return process.platform === 'win32' ? value.toLowerCase() : value;
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
		const match = /^<attached-file name="([^"]*)" mime="([^"]*)" length="(\d+)"(?: source="([^"]*)")?>$/.exec(header);
		if (!match || headerEnd < 0) break;
		const length = Number(match[3]);
		if (!Number.isSafeInteger(length) || length > 200_000) break;
		const contentStart = headerEnd + 1;
		const content = remaining.slice(contentStart, contentStart + length);
		const close = remaining.slice(contentStart + length);
		if (!close.startsWith('\n</attached-file>\n')) break;
		try {
			const mimeType = decodeURIComponent(match[2]!);
			const source = match[4] === undefined ? undefined : attachmentContextSource(JSON.parse(decodeURIComponent(match[4])), mimeType);
			files.push({ kind: 'text', name: decodeURIComponent(match[1]!), mimeType, text: content, ...(source ? { source } : {}) });
		} catch { break; }
		remaining = close.slice('\n</attached-file>\n'.length);
	}
	const attachments = [...images, ...files];
	return attachments.length ? attachments : undefined;
}

/** Context metadata is display-only; never trust it as permission to read a path. */
function attachmentContextSource(value: unknown, mimeType: string): UiContextSource {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('上下文来源无效');
	const source = value as Record<string, unknown>;
	if (Object.keys(source).some((key) => !['kind', 'workspace', 'path', 'truncated'].includes(key)) ||
		(source.kind !== 'file' && source.kind !== 'directory' && source.kind !== 'session') ||
		typeof source.workspace !== 'string' || !source.workspace.trim() || source.workspace.length > 32_768 ||
		typeof source.path !== 'string' || !source.path.trim() || source.path.length > 32_768 ||
		/[\u0000-\u001f\u007f]/.test(`${source.workspace}${source.path}`) ||
		(source.truncated !== undefined && typeof source.truncated !== 'boolean')) throw new Error('上下文来源无效');
	const kind = source.kind as UiContextSource['kind'];
	const expectedMime = kind === 'session' ? 'text/x-pi-session-context' : `text/x-pi-${kind}-reference`;
	if (mimeType !== expectedMime) throw new Error('上下文来源类型不匹配');
	return { kind, workspace: source.workspace, path: source.path, ...(source.truncated !== undefined ? { truncated: source.truncated } : {}) };
}

function withTextAttachments(text: string, attachments: UiAttachment[]): string {
	if (!Array.isArray(attachments) || attachments.length > 12) throw new Error('附件数量超出限制');
	const files = attachments.filter((item): item is Extract<UiAttachment, { kind: 'text' }> => item.kind === 'text');
	if (!files.length) return text;
	let result = `${text}${TEXT_ATTACHMENT_MARKER}`;
	for (const file of files) {
		if (typeof file.name !== 'string' || typeof file.text !== 'string' || file.text.length > 200_000 ||
			(file.mimeType !== undefined && typeof file.mimeType !== 'string')) {
			throw new Error('文本附件无效或过大');
		}
		const safeName = Array.from(file.name.replace(/[\r\n]/g, ' ')).slice(0, 180).join('');
		const mimeType = file.mimeType || 'text/plain';
		const source = file.source === undefined ? undefined : attachmentContextSource(file.source, mimeType);
		const sourceAttribute = source ? ` source="${encodeURIComponent(JSON.stringify(source))}"` : '';
		result += `<attached-file name="${encodeURIComponent(safeName)}" mime="${encodeURIComponent(mimeType)}" length="${file.text.length}"${sourceAttribute}>\n${file.text}\n</attached-file>\n`;
	}
	return result;
}

function imageAttachments(attachments: UiAttachment[]): { type: 'image'; data: string; mimeType: string }[] {
	return attachments.filter((item): item is Extract<UiAttachment, { kind: 'image' }> => item.kind === 'image').map((image) => {
		if (!/^image\/(png|jpeg|gif|webp)$/.test(image.mimeType) ||
			typeof image.data !== 'string' || image.data.length === 0 || image.data.length > 14_000_000 ||
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

function assistantThinking(message: MessageLike, thinkingStatus: UiThinkingStatus): UiThinkingOutput | undefined {
	if (!Array.isArray(message.content)) return undefined;
	let thinking = '';
	let found = false;
	let thinkingTruncated = false;
	for (const part of message.content) {
		// Opaque signatures and provider-redacted blocks are never renderer content.
		if (part?.type !== 'thinking' || part.redacted || typeof part.thinking !== 'string') continue;
		found = true;
		const separator = thinking && part.thinking ? '\n\n' : '';
		const available = MAX_THINKING_CHARS - thinking.length;
		if (separator.length + part.thinking.length > available) {
			const prefix = (separator + part.thinking.slice(0, available)).slice(0, available);
			thinking += prefix;
			// Avoid leaving a cut UTF-16 surrogate in IPC text.
			if (/[\uD800-\uDBFF]$/.test(thinking)) thinking = thinking.slice(0, -1);
			thinkingTruncated = true;
			break;
		}
		thinking += separator + part.thinking;
	}
	return found ? { thinking, thinkingStatus, thinkingTruncated } : undefined;
}

function historyTimeline(entries: SessionEntry[], liveRun?: UiConversationRun | null): { messages: UiMessage[]; activities: UiToolActivity[]; nextOrder: number; runs: UiConversationRun[] } {
	const { runs, entryRuns } = readConversationRuns(entries, liveRun);
	const messages: UiMessage[] = [];
	const activities = new Map<string, UiToolActivity>();
	let nextOrder = 0;
	for (const entry of entries) {
		const runId = entryRuns.get(entry.id);
		// Project compaction/branch summaries and visible extension notices into system rows (3.6).
		if (entry.type === 'compaction' || entry.type === 'branch_summary' || (entry.type === 'custom_message' && entry.display)) {
			const text = entry.type === 'custom_message'
				? (typeof entry.content === 'string' ? entry.content : '')
				: entry.summary;
			if (text.trim()) messages.push({
				id: entry.id,
				runId,
				order: nextOrder++,
				role: 'system',
				systemKind: entry.type === 'compaction' ? 'compaction' : entry.type === 'branch_summary' ? 'branch-summary' : 'custom',
				text,
				status: 'done',
			});
			continue;
		}
		if (entry.type !== 'message') continue;
		const message = entry.message;
		if (message.role === 'user') {
			messages.push({ id: entry.id, order: nextOrder++, runId, role: 'user', text: userText(message), attachments: userAttachments(message), status: 'done' });
		} else if (message.role === 'assistant') {
			const text = assistantText(message);
			const errorMessage = message.stopReason === 'error' ? message.errorMessage || '模型调用失败' : undefined;
			const thinking = assistantThinking(message, errorMessage ? 'error' : message.stopReason === 'aborted' ? 'interrupted' : 'done');
			if (text || thinking?.thinking || errorMessage) {
				messages.push({
					id: entry.id,
					runId,
					order: nextOrder++,
					role: 'assistant',
					text,
					...thinking,
					status: message.stopReason === 'aborted' || errorMessage ? 'error' : 'done',
					errorMessage,
				});
			}
			const startedAt = timestampOf(entry.timestamp);
			if (Array.isArray(message.content)) for (const part of message.content) {
				if (part.type !== 'toolCall') continue;
				activities.set(part.id, {
					id: part.id,
					runId,
					order: nextOrder++,
					tool: part.name,
					title: describeToolUse(part.name, part.arguments),
					status: 'running',
					startedAt,
					...toolCallMeta(part.arguments),
				});
			}
		} else if (message.role === 'toolResult') {
			const previous = activities.get(message.toolCallId);
			const rawText = toolResultRawText(message);
			activities.set(message.toolCallId, {
				id: message.toolCallId,
				runId: previous?.runId ?? runId,
				order: previous?.order ?? nextOrder++,
				tool: message.toolName,
				title: previous?.title ?? message.toolName,
				status: message.isError ? 'error' : 'done',
				startedAt: previous?.startedAt ?? null,
				endedAt: timestampOf(entry.timestamp),
				files: previous?.files ?? null,
				command: previous?.command ?? null,
				...toolResultText(message),
				...toolResultMeta(message.toolName, message.isError, rawText),
			});
		}
	}
	return {
		messages,
		runs,
		activities: [...activities.values()].map((activity) =>
			activity.status === 'running' ? { ...activity, status: 'interrupted' } : activity),
		nextOrder,
	};
}

/** Combined timeline entries (messages plus activities) sorted by order. */
function timelineEntries(timeline: { messages: UiMessage[]; activities: UiToolActivity[] }): { order: number; message?: UiMessage; activity?: UiToolActivity }[] {
	return [
		...timeline.messages.map((message) => ({ order: message.order, message })),
		...timeline.activities.map((activity) => ({ order: activity.order, activity })),
	].sort((a, b) => a.order - b.order);
}

/**
 * Keep the newest `limit` timeline entries (by order) for the ready payload.
 * `historyTotal` reports the full count so the renderer can page older slices.
 */
export function trimRecentTimeline(timeline: { messages: UiMessage[]; activities: UiToolActivity[]; runs?: UiConversationRun[] }, limit: number): { messages: UiMessage[]; activities: UiToolActivity[]; historyTotal: number; runs?: UiConversationRun[] } {
	const combined = timelineEntries(timeline);
	const unassociated = latestUnassociatedRunId(timeline);
	if (combined.length <= limit) return { messages: limitHistoryAttachments(timeline.messages), activities: timeline.activities, historyTotal: combined.length,
		...(timeline.runs ? { runs: selectConversationRuns(timeline.runs, timeline.messages, timeline.activities, unassociated) } : {}) };
	const cutoff = combined[combined.length - limit]!.order;
	const messages = limitHistoryAttachments(timeline.messages.filter((message) => message.order >= cutoff));
	const activities = timeline.activities.filter((activity) => activity.order >= cutoff);
	return {
		messages,
		activities,
		...(timeline.runs ? { runs: selectConversationRuns(timeline.runs, messages, activities, unassociated) } : {}),
		historyTotal: combined.length,
	};
}

/** Slice one oldest-first page from a built timeline. */
export function historyPageSlice(timeline: { messages: UiMessage[]; activities: UiToolActivity[]; runs?: UiConversationRun[] }, offset: number, limit: number): UiHistoryPage {
	const combined = timelineEntries(timeline);
	const slice = combined.slice(offset, offset + limit);
	const messages = limitHistoryAttachments(slice.flatMap((entry) => (entry.message ? [entry.message] : [])));
	const activities = slice.flatMap((entry) => (entry.activity ? [entry.activity] : []));
	const unassociated = offset + limit >= combined.length ? latestUnassociatedRunId(timeline) : undefined;
	return {
		offset,
		limit,
		total: combined.length,
		messages,
		activities,
		...(timeline.runs ? { runs: selectConversationRuns(timeline.runs, messages, activities, unassociated) } : {}),
	};
}

/** Omit whole attachments, keeping session data intact and previews visibly incomplete. */
export function limitHistoryAttachments(messages: UiMessage[], budget = HISTORY_ATTACHMENT_BUDGET): UiMessage[] {
	let remaining = budget;
	const previews = new Map<UiMessage, UiMessage>();
	for (const message of [...messages].sort((a, b) => b.order - a.order)) {
		if (!message.attachments?.length) continue;
		const references = [...(message.attachmentReferences ?? [])];
		const omittedIndices = new Set(references.map((reference) => reference.index));
		let originalIndex = 0;
		const attachments = message.attachments.filter((attachment) => {
			while (omittedIndices.has(originalIndex)) originalIndex++;
			const index = originalIndex++;
			const size = attachment.kind === 'image' ? attachment.data.length : Buffer.byteLength(attachment.text, 'utf8');
			if (size > remaining) { references.push({ index, kind: attachment.kind, name: attachment.name.slice(0, 200), mimeType: attachment.mimeType, size }); return false; }
			remaining -= size;
			return true;
		});
		const omitted = message.attachments.length - attachments.length;
		if (omitted) previews.set(message, { ...message, attachments, attachmentReferences: references, attachmentsOmitted: (message.attachmentsOmitted ?? 0) + omitted });
	}
	return messages.map((message) => previews.get(message) ?? message);
}

function toolResultRawText(value: unknown): string {
	if (!value || typeof value !== 'object') return '';
	const content = (value as { content?: unknown }).content;
	if (!Array.isArray(content)) return '';
	return content
		.filter((part): part is { type: string; text: string } => part?.type === 'text' && typeof part.text === 'string')
		.map((part) => part.text)
		.join('\n');
}

function toolResultText(value: unknown): Pick<UiToolActivity, 'detail' | 'detailTruncated'> {
	const text = toolResultRawText(value);
	return text ? {
		detail: text.slice(0, MAX_TOOL_DETAIL_CHARS),
		detailTruncated: text.length > MAX_TOOL_DETAIL_CHARS,
	} : {};
}

/** Parse persisted entry timestamps; null keeps legacy history renderable. */
function timestampOf(value: string | undefined): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/** Structured activity-card metadata: touched paths and the shell command line. Kept IPC-small. */
export function toolCallMeta(args: unknown): Pick<UiToolActivity, 'files' | 'command'> {
	if (!args || typeof args !== 'object') return { files: null, command: null };
	const record = args as Record<string, unknown>;
	const files = new Set<string>();
	const add = (value: unknown) => {
		if (typeof value === 'string' && value.trim()) files.add(value.trim());
	};
	add(record.file);
	add(record.path);
	if (Array.isArray(record.files)) for (const item of record.files) add(item);
	if (Array.isArray(record.paths)) for (const item of record.paths) add(item);
	return {
		files: files.size > 0 ? [...files].slice(0, 12) : null,
		command: typeof record.command === 'string' && record.command.trim() ? record.command.trim() : null,
	};
}

const EXIT_CODE_PATTERN = /Command exited with code (\d+)/;

/**
 * Best-effort shell exit status. Successful Pi bash calls report zero; failures
 * carry the status in the trailing error text ("Command exited with code N").
 */
export function toolExitCode(tool: string, isError: boolean, text: string): number | null {
	if (tool !== 'bash') return null;
	if (!isError) return 0;
	const match = EXIT_CODE_PATTERN.exec(text.slice(-400));
	return match ? Number(match[1]) : null;
}

/**
 * Pi's edit tool returns its diff as `+3 added`, `-2 removed`, ` 1 context`
 * and ` ...` elision rows (dist/core/tools/edit-diff.js). Recognizing that
 * shape lets activity cards render line-numbered diffs instead of raw text.
 */
export function isEditDiffText(tool: string, isError: boolean, text: string): boolean {
	if (tool !== 'edit' || isError) return false;
	const lines = text.split('\n');
	if (lines.at(-1) === '') lines.pop();
	if (lines.length === 0) return false;
	let changed = 0;
	for (const line of lines) {
		if (/^[+-] *\d+(?: |$)/.test(line)) { changed += 1; continue; }
		if (/^  *\d+(?: |$)/.test(line) || /^ +\.\.\.$/.test(line)) continue;
		return false;
	}
	return changed > 0;
}

/** Structured fields for finished calls: exit status and capped edit diffs. */
export function toolResultMeta(tool: string, isError: boolean, rawText: string): Pick<UiToolActivity, 'exitCode' | 'diff'> {
	return {
		exitCode: toolExitCode(tool, isError, rawText),
		diff: isEditDiffText(tool, isError, rawText)
			? rawText.length > MAX_TOOL_DETAIL_CHARS ? rawText.slice(0, MAX_TOOL_DETAIL_CHARS) : rawText
			: null,
	};
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
