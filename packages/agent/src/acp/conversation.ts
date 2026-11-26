import type { UiAgentConfig, UiAgentModel, UiAgentOption } from '@pidesktop/shared';
import { agentProxyProbeUrl, resolveAgentSystemProxy } from './agentProxy.ts';
import { AcpConnection } from './connection.ts';
import { parseElicitationForm, type AcpElicitationResponse, type AcpFormRequest } from './elicitation.ts';
import {
	ACP_AUTH_REQUIRED, ACP_PROTOCOL_VERSION, AcpRequestError,
	type AcpAvailableCommand, type AcpConfigOption, type AcpContentBlock, type AcpInitializeResult, type AcpNewSessionResult, type AcpPlanEntry,
	type AcpPromptResult, type AcpRequestPermissionOutcome, type AcpRequestPermissionParams, type AcpSessionNotification, type AcpSteeringResult, type AcpStopReason,
} from './protocol.ts';
import { AcpTurnAssembler, type PiImageContent, type PiMessage, type PiShapedEvent } from './turnAssembler.ts';

export interface AcpConversationHooks {
	/** Pi-shaped events for the desktop's session event handler. */
	emit(event: PiShapedEvent): void;
	/** Transcript messages to append to the session file. */
	persist(message: PiMessage): void;
	requestPermission(params: AcpRequestPermissionParams, signal: AbortSignal): Promise<AcpRequestPermissionOutcome>;
	requestElicitation(params: AcpFormRequest, signal: AbortSignal): Promise<AcpElicitationResponse>;
	onPlan(entries: AcpPlanEntry[]): void;
	onCommands(commands: AcpAvailableCommand[]): void;
	onModels(models: UiAgentModel[], currentModelId: string | null): void;
	/** Session settings other than the model (reasoning effort, mode, speed, ...). */
	onConfigOptions(options: UiAgentOption[]): void;
	onNativeSession(sessionId: string): void;
	/** The agent process ended outside a turn. */
	onExit(message: string): void;
	/** Rendered transcript used when the agent cannot resume its own session. */
	historyContext(): string | null;
	/** Settings the user chose earlier, applied again to a resumed session (agents reset them). */
	savedSettings?(): { model?: string; options: Record<string, string> } | null;
}

export interface AcpTurnInput {
	text: string;
	images?: PiImageContent[];
	/** Context sent ahead of the user's text (handoff), never shown in the transcript. */
	contextPrefix?: string | null;
	/** Called once the user message is in the transcript and the turn is running. */
	onStarted?(): void;
	/** Called once the agent has accepted the prompt (its session now holds the context). */
	onDelivered?(): void;
	/** Called before a steer the agent could not take starts a normal turn. */
	onSteerFallback?(): void;
}

export interface AcpTurnResult {
	stopReason: AcpStopReason | 'error';
	error?: Error;
	/** Input sent mid-turn took this turn over; the newer turn reports the outcome. */
	superseded?: boolean;
}

/**
 * One desktop conversation driven by an ACP agent. Starts on demand, resumes
 * its native session when the agent supports `session/load`, and serializes turns.
 * Some agents can also take input while a turn runs (see `steer`).
 */
export class AcpConversation {
	readonly config: UiAgentConfig;
	private readonly cwd: string;
	private readonly hooks: AcpConversationHooks;
	private connection: AcpConnection | null = null;
	private initialize: AcpInitializeResult | null = null;
	private sessionId: string | null = null;
	private nativeSessionId: string | null;
	private starting: Promise<void> | null = null;
	/** Updates replayed by `session/load` describe history we already hold. */
	private replaying = false;
	private contextLost = false;
	private readonly assembler: AcpTurnAssembler;
	private turn: Promise<unknown> = Promise.resolve();
	private nativeSteering: Promise<unknown> = Promise.resolve();
	private activeTurns = 0;
	/** The turn whose prompt the agent is working on (sent, not answered yet). */
	private running: { superseded: boolean } | null = null;
	private permissionAbort: AbortController | null = null;
	/** Set when the agent exposes its model as a config option (then `session/set_model` is not used). */
	private modelOptionId: string | null = null;
	private models: UiAgentModel[] = [];
	private currentModel: string | null = null;
	private options: UiAgentOption[] = [];
	/** Legacy `modes` shown as an option when the agent has no mode config option. */
	private legacyMode: UiAgentOption | null = null;
	private disposed = false;
	/** Bumped by `cancel()`: every turn queued before it, running or waiting, is cancelled. */
	private generation = 0;

	constructor(config: UiAgentConfig, cwd: string, nativeSessionId: string | null, hooks: AcpConversationHooks) {
		this.config = config;
		this.cwd = cwd;
		this.nativeSessionId = nativeSessionId;
		this.hooks = hooks;
		this.assembler = new AcpTurnAssembler({ cwd, provider: `acp:${config.id}`, model: config.displayName });
	}

	get busy(): boolean { return this.activeTurns > 0; }
	get supportsImages(): boolean { return this.initialize?.agentCapabilities?.promptCapabilities?.image === true; }
	get supportsSteering(): boolean { return this.config.steer === true || this.supportsNativeSteering; }

	private get supportsNativeSteering(): boolean {
		const init = this.initialize;
		if (init?._meta?.steering?.supported !== true || init.agentInfo?.name !== '@agentclientprotocol/codex-acp') return false;
		// Codex 2.4 added host-owned fallback. Older releases can start a detached turn on an idle race.
		const version = /^(\d+)\.(\d+)\.\d+/.exec(init.agentInfo.version ?? '');
		return !!version && (Number(version[1]) > 2 || (Number(version[1]) === 2 && Number(version[2]) >= 4));
	}

	/** Queue a turn behind any running one; resolves when the turn ends. */
	prompt(input: AcpTurnInput): Promise<AcpTurnResult> {
		if (this.disposed) return Promise.reject(new Error('会话已关闭'));
		this.activeTurns += 1;
		const generation = this.generation;
		const run = this.turn.then(() => this.runTurn(input, generation)).finally(() => { this.activeTurns -= 1; });
		this.turn = run.catch(() => {});
		return run;
	}

	/** Cancel the running turn and the ones queued behind it; pending permission questions resolve as cancelled. */
	cancel(): void {
		if (!this.busy) return;
		this.generation += 1;
		this.permissionAbort?.abort();
		if (this.sessionId) this.connection?.notify('session/cancel', { sessionId: this.sessionId });
	}

	/** Start the agent and its session ahead of the first turn. */
	warmup(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		return this.ensureSession();
	}

	async setModel(modelId: string): Promise<void> {
		await this.ensureSession();
		await this.writeModel(modelId);
	}

	/** Change one session setting; the agent answers with the full, updated list. */
	async setConfigOption(configId: string, value: string): Promise<void> {
		await this.ensureSession();
		await this.writeConfigOption(configId, value);
	}

	private async writeModel(modelId: string): Promise<void> {
		if (this.modelOptionId) { await this.writeConfigOption(this.modelOptionId, modelId); return; }
		await this.connection!.request('session/set_model', { sessionId: this.sessionId, modelId });
		this.assembler.model = modelId;
		this.currentModel = modelId;
		this.hooks.onModels(this.models, modelId);
	}

	private async writeConfigOption(configId: string, value: string): Promise<void> {
		if (configId === LEGACY_MODE_OPTION && this.legacyMode) {
			await this.connection!.request('session/set_mode', { sessionId: this.sessionId, modeId: value });
			this.setLegacyMode(value);
			return;
		}
		const result = await this.connection!.request<{ configOptions?: unknown } | null>('session/set_config_option', { sessionId: this.sessionId, configId, value });
		if (Array.isArray(result?.configOptions)) { this.applyConfigOptions(result.configOptions); return; }
		// An agent that does not echo the list: reflect the accepted value locally.
		if (configId === this.modelOptionId) { this.assembler.model = value; this.currentModel = value; return; }
		this.options = this.options.map((option) => option.id === configId ? { ...option, currentValue: value } : option);
		this.hooks.onConfigOptions(this.options);
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.permissionAbort?.abort();
		const connection = this.connection;
		this.connection = null;
		await connection?.close();
	}

	/** Whether the live session can accept an additional input. */
	get canSteer(): boolean {
		return this.connection?.alive === true && this.sessionId !== null
			&& (this.supportsNativeSteering || (this.config.steer === true && this.running !== null));
	}

	/**
	 * Send input into the running turn. Codex keeps its original prompt active;
	 * Antigravity ends that prompt and continues under a second `session/prompt`.
	 */
	steer(input: AcpTurnInput): Promise<AcpTurnResult> {
		if (!this.canSteer || this.disposed) return this.prompt(input);
		if (this.supportsNativeSteering) return this.steerNative(input);
		const current = this.running!;
		current.superseded = true;
		// A question still open for the superseded turn is answered as cancelled.
		this.permissionAbort?.abort();
		this.activeTurns += 1;
		const cancelled = this.cancelledSince(this.generation);
		this.apply(this.assembler.split());
		this.apply(this.assembler.userMessage(input.text, input.images ?? []));
		input.onStarted?.();
		const run = this.sendPrompt(input, cancelled, false).finally(() => { this.activeTurns -= 1; });
		// Later prompts queue behind both the superseded turn and this one.
		this.turn = Promise.allSettled([this.turn, run]);
		return run;
	}

	private steerNative(input: AcpTurnInput): Promise<AcpTurnResult> {
		const previous = this.turn;
		const generation = this.generation;
		const assertActive = () => {
			if (generation !== this.generation || this.disposed) throw new Error('追加消息已取消');
		};
		this.activeTurns += 1;
		const dispatch = this.nativeSteering.then(async (): Promise<{ turn: AcpTurnResult | Promise<AcpTurnResult> }> => {
			assertActive();
			if (this.running && this.connection?.alive && this.sessionId) {
				const result = await this.connection.request<AcpSteeringResult>('_session/steering', {
					sessionId: this.sessionId,
					prompt: this.promptBlocks(input, input.contextPrefix),
					_meta: { steering: { idleBehavior: 'promptRequired' } },
				}, { onResult: (reply) => {
					if (reply?.outcome !== 'injected') return;
					this.apply(this.assembler.split());
					this.apply(this.assembler.userMessage(input.text, input.images ?? []));
					input.onStarted?.();
					input.onDelivered?.();
				} });
				// The original session/prompt still owns this turn's completion.
				if (result?.outcome === 'injected') return { turn: { stopReason: 'end_turn', superseded: true } };
				if (result?.outcome !== 'promptRequired') throw new Error(`${this.config.displayName} 未能追加消息`);
			}
			await previous;
			assertActive();
			input.onSteerFallback?.();
			return { turn: this.runTurn(input, generation) };
		});
		this.nativeSteering = dispatch.catch(() => {});
		const run = dispatch.then(({ turn }) => turn).finally(() => { this.activeTurns -= 1; });
		this.turn = Promise.allSettled([previous, run]);
		return run;
	}

	private cancelledSince(generation: number): () => boolean {
		return () => generation !== this.generation;
	}

	private async runTurn(input: AcpTurnInput, generation: number): Promise<AcpTurnResult> {
		const cancelled = this.cancelledSince(generation);
		const user = this.assembler.userMessage(input.text, input.images ?? []);
		this.apply(user);
		input.onStarted?.();
		// Stopped while waiting behind another turn: kept in the transcript, never sent.
		if (cancelled()) return this.finish('cancelled');
		try {
			await this.ensureSession();
		} catch (error) {
			return this.failTurn(error, cancelled);
		}
		if (cancelled()) return this.finish('cancelled');
		return this.sendPrompt(input, cancelled, true);
	}

	/** `withHistory`: a turn that starts the conversation again carries the transcript when the agent lost it. */
	private async sendPrompt(input: AcpTurnInput, cancelled: () => boolean, withHistory: boolean): Promise<AcpTurnResult> {
		const turn = { superseded: false };
		const permission = new AbortController();
		try {
			const sessionId = this.sessionId!;
			const prefix = [withHistory && this.contextLost ? this.hooks.historyContext() : null, input.contextPrefix].filter(Boolean).join('\n\n');
			this.running = turn;
			this.permissionAbort = permission;
			const result = await this.connection!.request<AcpPromptResult>('session/prompt', { sessionId, prompt: this.promptBlocks(input, prefix) });
			if (withHistory && this.contextLost) {
				this.contextLost = false;
				this.nativeSessionId = sessionId;
				this.hooks.onNativeSession(sessionId);
			}
			input.onDelivered?.();
			// Input sent into this turn took over: that turn reports the outcome.
			if (turn.superseded) return { stopReason: result?.stopReason ?? 'end_turn', superseded: true };
			return this.finish(cancelled() ? 'cancelled' : result?.stopReason ?? 'end_turn');
		} catch (error) {
			if (turn.superseded) return { stopReason: cancelled() ? 'cancelled' : 'end_turn', superseded: true };
			return this.failTurn(error, cancelled);
		} finally {
			permission.abort();
			if (this.running === turn) this.running = null;
			if (this.permissionAbort === permission) this.permissionAbort = null;
		}
	}

	private promptBlocks(input: AcpTurnInput, prefix?: string | null): AcpContentBlock[] {
		const blocks: AcpContentBlock[] = [];
		if (prefix) blocks.push({ type: 'text', text: prefix });
		blocks.push({ type: 'text', text: input.text });
		if (this.supportsImages) for (const image of input.images ?? []) blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType });
		return blocks;
	}

	private failTurn(error: unknown, cancelled: () => boolean): AcpTurnResult {
		const normalized = this.describeError(error);
		if (cancelled()) return this.finish('cancelled');
		this.finish('error', normalized.message);
		return { stopReason: 'error', error: normalized };
	}

	private finish(stopReason: AcpStopReason | 'error', message?: string): AcpTurnResult {
		this.apply(this.assembler.finish(stopReason, message));
		return { stopReason };
	}

	private apply(output: ReturnType<AcpTurnAssembler['update']>): void {
		for (const message of output.persist) this.hooks.persist(message);
		for (const event of output.events) this.hooks.emit(event);
		if (output.plan) this.hooks.onPlan(output.plan);
		if (output.commands) this.hooks.onCommands(output.commands);
	}

	private describeError(error: unknown): Error {
		if (error instanceof AcpRequestError && error.code === ACP_AUTH_REQUIRED) {
			const methods = (this.initialize?.authMethods ?? []).map((method) => method.name).filter(Boolean);
			const how = this.config.loginHint ? `：${this.config.loginHint}` : `。请先在终端用它自己的命令完成登录${methods.length ? `（可用方式：${methods.join('、')}）` : ''}`;
			return new Error(`${this.config.displayName} 需要登录${how}，然后重试。`);
		}
		return error instanceof Error ? error : new Error(String(error));
	}

	private ensureSession(): Promise<void> {
		if (this.starting) return this.starting;
		if (this.connection?.alive && this.sessionId) return Promise.resolve();
		this.starting = this.startSession().finally(() => { this.starting = null; });
		return this.starting;
	}

	private async startSession(): Promise<void> {
		if (this.disposed) throw new Error('会话已关闭');
		// The user may have switched the system proxy since the last start.
		const probe = agentProxyProbeUrl(this.config);
		const proxy = probe ? await resolveAgentSystemProxy(probe) : null;
		if (this.disposed) throw new Error('会话已关闭');
		const connection = AcpConnection.start({
			command: this.config.command,
			args: this.config.args,
			cwd: this.cwd,
			env: { ...this.config.env, PI_DESKTOP_AGENT: this.config.id },
			proxy,
			onNotification: (method, params) => this.onNotification(method, params),
			onRequest: (method, params, signal) => this.onRequest(method, params, signal),
			onExit: ({ expected, code, stderr }) => {
				if (this.connection === connection) { this.connection = null; this.sessionId = null; }
				if (!expected && !this.disposed && !this.busy) this.hooks.onExit(`${this.config.displayName} 进程已退出（${code ?? '未知'}）${stderr ? `：${stderr.split('\n').at(-1)}` : ''}`);
			},
		});
		this.connection = connection;
		try {
			this.initialize = await connection.request<AcpInitializeResult>('initialize', {
				protocolVersion: ACP_PROTOCOL_VERSION,
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
				clientInfo: { name: 'pi-desktop', title: 'Pi Desktop' },
			});
			let session: AcpNewSessionResult | null = null;
			if (this.nativeSessionId && this.initialize?.agentCapabilities?.loadSession) {
				this.replaying = true;
				try {
					session = await connection.request<AcpNewSessionResult>('session/load', { sessionId: this.nativeSessionId, cwd: this.cwd, mcpServers: [] });
					session = { ...(session ?? {}), sessionId: this.nativeSessionId } as AcpNewSessionResult;
				} catch { session = null; } finally { this.replaying = false; }
			}
			this.contextLost = this.nativeSessionId !== null && !session;
			if (!session) {
				session = await connection.request<AcpNewSessionResult>('session/new', { cwd: this.cwd, mcpServers: [] });
				if (!session || typeof session.sessionId !== 'string') throw new Error(`${this.config.displayName} 没有返回会话 ID`);
				// Keep the old binding until a prompt has delivered its history to the replacement.
				if (!this.contextLost) {
					this.nativeSessionId = session.sessionId;
					this.hooks.onNativeSession(session.sessionId);
				}
			}
			this.sessionId = session.sessionId;
			this.applySessionSettings(session);
			await this.restoreSettings();
		} catch (error) {
			this.connection = null;
			this.sessionId = null;
			await connection.close();
			throw this.describeError(error);
		}
	}

	/**
	 * Model and settings of a new or loaded session. `configOptions` (model, reasoning
	 * effort, mode, ...) supersede the older `models` list, which agents such as
	 * codex-acp flatten into one entry per model and effort.
	 */
	private applySessionSettings(session: AcpNewSessionResult): void {
		const modes = session.modes;
		this.legacyMode = modes && Array.isArray(modes.availableModes) && modes.availableModes.length > 1 && typeof modes.currentModeId === 'string' ? {
			id: LEGACY_MODE_OPTION, name: 'Mode', category: 'mode', currentValue: modes.currentModeId,
			values: modes.availableModes.filter((mode) => mode && typeof mode.id === 'string').slice(0, 50)
				.map((mode) => ({ value: mode.id, name: mode.name || mode.id, ...(mode.description ? { description: mode.description } : {}) })),
		} : null;
		if (Array.isArray(session.configOptions) && this.applyConfigOptions(session.configOptions)) return;
		this.modelOptionId = null;
		const models = session.models;
		if (models && Array.isArray(models.availableModels)) {
			const list = models.availableModels.filter((model) => model && typeof model.modelId === 'string')
				.map((model) => ({ id: model.modelId, name: model.name || model.modelId, ...(model.description ? { description: model.description } : {}) }));
			const current = typeof models.currentModelId === 'string' ? models.currentModelId : null;
			if (current) this.assembler.model = current;
			this.models = list;
			this.currentModel = current;
			this.hooks.onModels(list, current);
		}
		this.publishOptions([]);
	}

	/**
	 * Apply the user's earlier choices to a new or resumed session: agents start a
	 * loaded session with their defaults. The model goes first, since changing it
	 * can reset other settings. A choice the agent no longer offers is skipped.
	 * Without a choice, the permission mode starts at "accept edits" where offered.
	 */
	private async restoreSettings(): Promise<void> {
		const saved = this.hooks.savedSettings?.() ?? { options: {} };
		const model = saved.model;
		if (model && model !== this.currentModel && this.models.some((item) => item.id === model)) {
			await this.writeModel(model).catch(() => {});
		}
		const wanted = new Map(Object.entries(saved.options));
		for (const option of this.options) {
			if (option.category !== 'mode' || wanted.has(option.id)) continue;
			const acceptEdits = option.values.find((item) => ACCEPT_EDITS_MODE.test(item.value));
			if (acceptEdits) wanted.set(option.id, acceptEdits.value);
		}
		for (const [id, value] of wanted) {
			const option = this.options.find((item) => item.id === id);
			if (!option || option.currentValue === value || !option.values.some((item) => item.value === value)) continue;
			await this.writeConfigOption(id, value).catch(() => {});
		}
	}

	/** Returns false when the list holds nothing usable. */
	private applyConfigOptions(raw: unknown[]): boolean {
		const parsed = raw.map(parseConfigOption).filter((option): option is UiAgentOption => option !== null);
		if (!parsed.length) return false;
		const model = parsed.find((option) => option.category === 'model') ?? parsed.find((option) => option.id === 'model');
		this.modelOptionId = model?.id ?? null;
		if (model) {
			this.assembler.model = model.currentValue;
			this.models = model.values.map((item) => ({ id: item.value, name: item.name, ...(item.description ? { description: item.description } : {}) }));
			this.currentModel = model.currentValue;
			this.hooks.onModels(this.models, model.currentValue);
		}
		this.publishOptions(parsed.filter((option) => option !== model));
		return true;
	}

	private setLegacyMode(modeId: string): void {
		if (!this.legacyMode) return;
		this.legacyMode = { ...this.legacyMode, currentValue: modeId };
		this.publishOptions(this.options.filter((option) => option.id !== LEGACY_MODE_OPTION));
	}

	/** The older `modes` list joins as one more option when the agent has no mode option of its own. */
	private publishOptions(options: UiAgentOption[]): void {
		const useLegacy = this.legacyMode !== null && !options.some((option) => option.category === 'mode');
		this.options = useLegacy ? [...options, this.legacyMode!] : options;
		this.hooks.onConfigOptions(this.options);
	}

	private onNotification(method: string, params: unknown): void {
		if (method !== 'session/update' || !params || typeof params !== 'object') return;
		const notification = params as AcpSessionNotification;
		if (!notification.update || (this.sessionId && notification.sessionId !== this.sessionId && !this.replaying)) return;
		const settings = notification.update as { sessionUpdate?: unknown; configOptions?: unknown; currentModeId?: unknown };
		if (settings.sessionUpdate === 'config_option_update') {
			if (Array.isArray(settings.configOptions)) this.applyConfigOptions(settings.configOptions);
			return;
		}
		if (settings.sessionUpdate === 'current_mode_update') {
			if (this.legacyMode && typeof settings.currentModeId === 'string') this.setLegacyMode(settings.currentModeId);
			return;
		}
		if (this.replaying) {
			// History updates are already in our transcript; only the command list is kept.
			const update = notification.update as { sessionUpdate?: unknown; availableCommands?: unknown };
			if (update.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) {
				this.hooks.onCommands(update.availableCommands.filter((item): item is AcpAvailableCommand => !!item && typeof (item as AcpAvailableCommand).name === 'string'));
			}
			return;
		}
		this.apply(this.assembler.update(notification.update));
	}

	private async onRequest(method: string, params: unknown, requestSignal: AbortSignal): Promise<unknown> {
		if (method === 'session/request_permission') {
			const request = params as AcpRequestPermissionParams;
			if (!request || !Array.isArray(request.options) || !request.toolCall) throw new AcpRequestError({ code: -32602, message: 'Invalid params' });
			if (request.sessionId !== this.sessionId || this.replaying || this.disposed) return { outcome: { outcome: 'cancelled' } };
			const signal = this.permissionAbort ? AbortSignal.any([this.permissionAbort.signal, requestSignal]) : AbortSignal.abort();
			if (signal.aborted) return { outcome: { outcome: 'cancelled' } };
			const permission = this.config.id === 'antigravity' ? { ...request, toolCall: this.assembler.toolForPermission(request.toolCall) } : request;
			const outcome = await this.hooks.requestPermission(permission, signal).catch((): AcpRequestPermissionOutcome => ({ outcome: 'cancelled' }));
			return { outcome };
		}
		if (method === 'elicitation/create') {
			const request = parseElicitationForm(params);
			if (request.sessionId !== this.sessionId || this.replaying || this.disposed) return { action: 'cancel' };
			// Codex's async questions belong to the session, even after the prompt ends.
			const signal = !request.async && this.permissionAbort ? AbortSignal.any([requestSignal, this.permissionAbort.signal]) : requestSignal;
			if (signal.aborted) return { action: 'cancel' };
			return await this.hooks.requestElicitation(request, signal);
		}
		throw new AcpRequestError({ code: -32601, message: `Method not found: ${method}` });
	}
}

/** Option id for agents that expose only the older `modes` list. */
export const LEGACY_MODE_OPTION = '__acp_mode';

/** The mode new sessions start in when the agent offers it (Antigravity `accept-edits`, Claude Code `acceptEdits`). */
const ACCEPT_EDITS_MODE = /^accept[-_ ]?edits$/i;

function text(value: unknown, max: number): string | null {
	return typeof value === 'string' && value.trim() ? value.slice(0, max) : null;
}

/** A `select` config option in UI shape; grouped values are flattened. Null when unusable. */
export function parseConfigOption(raw: unknown): UiAgentOption | null {
	if (!raw || typeof raw !== 'object') return null;
	const option = raw as Partial<AcpConfigOption>;
	const id = text(option.id, 200);
	if (!id || option.type !== 'select' || typeof option.currentValue !== 'string' || !Array.isArray(option.options)) return null;
	const values: UiAgentOption['values'] = [];
	const add = (item: unknown) => {
		if (!item || typeof item !== 'object') return;
		const entry = item as { value?: unknown; name?: unknown; description?: unknown };
		const value = text(entry.value, 500);
		if (!value || values.some((existing) => existing.value === value)) return;
		const description = text(entry.description, 500);
		values.push({ value, name: text(entry.name, 200) ?? value, ...(description ? { description } : {}) });
	};
	for (const item of option.options.slice(0, 200)) {
		const group = item as { group?: unknown; options?: unknown };
		if (group && typeof group === 'object' && Array.isArray(group.options)) group.options.slice(0, 200).forEach(add);
		else add(item);
	}
	if (!values.length) return null;
	const description = text(option.description, 500);
	return { id, name: text(option.name, 200) ?? id, ...(description ? { description } : {}), category: text(option.category, 100), currentValue: option.currentValue, values };
}
