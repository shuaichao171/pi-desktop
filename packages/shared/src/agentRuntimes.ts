/**
 * Agent runtimes: Pi (in-process SDK) plus external coding agents driven over
 * ACP (Agent Client Protocol, JSON-RPC on stdio). The renderer reads
 * capabilities, never runtime names, to decide what to show.
 */

export type UiAgentKind = 'pi' | 'acp';

/** Only what the runtime really supports; the UI hides what is false. */
export interface UiAgentCapabilities {
	streamsThinking: boolean;
	interrupt: boolean;
	/** Mid-run input reaches the running turn (otherwise it waits for the turn to end). */
	steer: boolean;
	thinkingLevels: boolean;
	/** `/` commands (Pi commands, or the commands the agent advertises). */
	slashCommands: boolean;
	/** `$` skills, extension cards, plugins. */
	extensions: boolean;
	images: boolean;
	session: {
		/** Session tree / branch switching. */
		branch: boolean;
		/** Fork from an assistant message. */
		fork: boolean;
		editUserMessage: boolean;
		/** File checkpoint rewind. */
		rewind: boolean;
	};
}

export interface UiAgentModel { id: string; name: string; description?: string }

/**
 * A session setting the agent exposes (ACP `configOptions`, select type): reasoning
 * effort, permission mode, speed and so on. The model option is shown as `models`.
 */
export interface UiAgentOption {
	id: string;
	name: string;
	description?: string;
	/** ACP category, e.g. `thought_level`, `mode`, `speed`; null when the agent gives none. */
	category: string | null;
	currentValue: string;
	values: { value: string; name: string; description?: string }[];
}

export interface UiAgentDescriptor {
	id: string;
	kind: UiAgentKind;
	displayName: string;
	accentColor?: string | null;
	capabilities: UiAgentCapabilities;
	/** Models the agent reported for this session (ACP only; Pi uses its own catalog). */
	models?: UiAgentModel[];
	currentModelId?: string | null;
	/** Other session settings the agent exposes (reasoning effort, mode, ...). */
	options?: UiAgentOption[];
	/** The agent's account plan limits can be read (`readAgentQuota`). */
	quota?: boolean;
}

export const PI_AGENT_ID = 'pi';

export const PI_AGENT_CAPABILITIES: UiAgentCapabilities = {
	streamsThinking: true, interrupt: true, steer: true, thinkingLevels: true, slashCommands: true, extensions: true, images: true,
	session: { branch: true, fork: true, editUserMessage: true, rewind: true },
};

export const ACP_AGENT_CAPABILITIES: UiAgentCapabilities = {
	streamsThinking: true, interrupt: true, steer: false, thinkingLevels: false, slashCommands: true, extensions: false, images: false,
	session: { branch: false, fork: false, editUserMessage: false, rewind: false },
};

export function piAgentDescriptor(): UiAgentDescriptor {
	return { id: PI_AGENT_ID, kind: 'pi', displayName: 'Pi', accentColor: null, capabilities: PI_AGENT_CAPABILITIES };
}

/** Capabilities for a descriptor that may be absent (older hosts only ever ran Pi). */
export function agentCapabilities(agent: UiAgentDescriptor | null | undefined): UiAgentCapabilities {
	return agent?.capabilities ?? PI_AGENT_CAPABILITIES;
}

/** One configured external agent (built-in catalog entry or user-defined ACP command). */
export interface UiAgentConfig {
	id: string;
	displayName: string;
	/** Executable name on PATH or an absolute path. */
	command: string;
	args: string[];
	/** Extra environment for the agent process. */
	env?: Record<string, string>;
	enabled: boolean;
	accentColor?: string | null;
	builtin: boolean;
	/** Official install command shown when the executable is missing. */
	installHint?: string;
	/** One-click install the main process can run (built-in agents only). */
	installer?: UiAgentInstaller;
	/** How to sign in, shown when the agent reports that it needs authentication. */
	loginHint?: string;
	/** Interactive sign-in the app can open in a terminal window (built-in agents only). */
	login?: { command: string; args: string[] };
	/**
	 * A prompt sent while a turn runs reaches that turn (the agent ends it and continues
	 * with the new input). Only built-ins verified to support this legacy behavior set it.
	 */
	steer?: boolean;
	/**
	 * URL used to resolve the system proxy to pass as HTTP(S)_PROXY (built-in agents only).
	 */
	systemProxy?: string;
	/** A community-maintained ACP adapter rather than the agent vendor's own (shown as such). */
	community?: boolean;
	/** Requirements or caveats shown on the agent's settings card. */
	note?: string;
	/** How the account plan limits are read (built-in agents only). */
	quota?: UiAgentQuotaSource;
	homepage?: string;
}

/**
 * `codex`: the Codex app-server's `account/rateLimits/read`; `claude`: Claude Code's `/usage`;
 * `antigravity`: `agy -p /usage --output-format json`.
 */
export type UiAgentQuotaSource = 'codex' | 'claude' | 'antigravity';

/** One plan-limit window of an agent account. */
export interface UiAgentQuotaWindow {
	/** `five_hour` and `weekly` are the plan's main windows; `other` carries a label (a model, a separate limit). */
	kind: 'five_hour' | 'weekly' | 'other';
	label?: string;
	/** Models sharing the window when the account has several limit groups (Antigravity: Gemini, Claude and GPT). */
	group?: string;
	/** 0-100. */
	usedPercent: number;
	/** Epoch ms; null when the agent gives none. */
	resetsAt: number | null;
}

export interface UiAgentQuota {
	agentId: string;
	ok: boolean;
	queriedAt: number;
	/** Empty when the account has no plan limits (an API key, for example). On failure: the last known windows. */
	windows: UiAgentQuotaWindow[];
	/** Plan name as the agent reports it (`plus`, `max`, ...). */
	plan?: string | null;
	error?: string;
}

/**
 * An official installer. The main process builds the command line from this
 * catalog entry itself; the renderer only names the agent.
 */
export type UiAgentInstaller =
	| { kind: 'npm'; package: string }
	/** Remote script piped into the platform shell (`irm | iex` on Windows, `curl | bash` elsewhere). */
	| { kind: 'script'; windowsUrl: string; posixUrl: string };

export type UiAgentInstallPhase = 'running' | 'succeeded' | 'failed' | 'cancelled';

/** One install run, kept by the main process so a reopened settings page sees it. */
export interface UiAgentInstallState {
	agentId: string;
	phase: UiAgentInstallPhase;
	/** The command line as shown to the user. */
	command: string;
	/** Tail of combined stdout/stderr, ANSI codes removed. */
	output: string;
	startedAt: number;
	finishedAt?: number;
	exitCode?: number | null;
	error?: string;
}

/**
 * Passive readiness: only PATH lookup and `--version`, never a session.
 * `attention` covers a failed version probe; sign-in problems surface when a
 * session starts (each agent reports its own auth requirement).
 */
export type UiAgentReadiness = 'ready' | 'install' | 'attention' | 'disabled';

export interface UiAgentStatus extends UiAgentConfig {
	readiness: UiAgentReadiness;
	version: string | null;
	resolvedCommand: string | null;
	message?: string;
}

export interface UiAgentSaveRequest {
	/** Absent creates a custom agent. */
	id?: string;
	displayName: string;
	command: string;
	args: string[];
	env?: Record<string, string>;
	enabled: boolean;
	accentColor?: string | null;
}

/** A conversation link written when one conversation continues in another agent. */
export interface UiHandoffLink {
	direction: 'from' | 'to';
	/** The other conversation. */
	sessionPath: string;
	fromAgent: string;
	toAgent: string;
}

export interface AgentRuntimeFeaturesBridge {
	listAgents(): Promise<UiAgentStatus[]>;
	/** Re-run the passive probe (PATH + --version). */
	probeAgents(): Promise<UiAgentStatus[]>;
	saveAgent(request: UiAgentSaveRequest): Promise<UiAgentStatus[]>;
	removeAgent(id: string): Promise<UiAgentStatus[]>;
	clearAntigravityCommandApprovals(): Promise<void>;
	/** Choose the agent of the open conversation; allowed only before its first message. */
	setSessionAgent(agentId: string): Promise<void>;
	/** Continue the open conversation in another agent: opens a new conversation carrying its context. */
	handoffToAgent(agentId: string): Promise<void>;
	/** Change one of the open conversation's agent session settings (`UiAgentOption`). */
	setAgentOption(optionId: string, value: string): Promise<void>;
	/** Start the official installer of a built-in agent; progress arrives through `onAgentInstallEvent`. */
	installAgent(agentId: string): Promise<UiAgentInstallState>;
	cancelAgentInstall(agentId: string): Promise<void>;
	/** Install runs the main process still remembers (running or finished). */
	listAgentInstalls(): Promise<UiAgentInstallState[]>;
	/** Open a terminal window running the agent's own interactive sign-in. */
	openAgentLogin(agentId: string): Promise<void>;
	onAgentInstallEvent(listener: (state: UiAgentInstallState) => void): () => void;
	/** Account plan limits (5-hour and weekly windows); cached briefly unless `refresh`. */
	readAgentQuota(agentId: string, refresh?: boolean): Promise<UiAgentQuota>;
}

export const AGENT_RUNTIME_CHANNELS = {
	installAgent: 'agents:install',
	cancelAgentInstall: 'agents:install-cancel',
	listAgentInstalls: 'agents:install-list',
	agentInstallEvent: 'agents:install-event',
	openAgentLogin: 'agents:open-login',
	listAgents: 'agents:list',
	probeAgents: 'agents:probe',
	saveAgent: 'agents:save',
	removeAgent: 'agents:remove',
	clearAntigravityCommandApprovals: 'agents:clear-antigravity-command-approvals',
	setSessionAgent: 'agents:set-session-agent',
	handoffToAgent: 'agents:handoff',
	setAgentOption: 'agents:set-option',
	readAgentQuota: 'agents:quota',
} as const;

/** Bounded wire validation for an agent option change. */
export function requireAgentOptionChange(optionId: unknown, value: unknown): { optionId: string; value: string } {
	if (typeof optionId !== 'string' || !optionId || optionId.length > 200 || optionId.includes('\0')) throw new Error('Agent 选项无效');
	if (typeof value !== 'string' || !value || value.length > 500 || value.includes('\0')) throw new Error('Agent 选项值无效');
	return { optionId, value };
}

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidAgentId(value: unknown): value is string {
	return typeof value === 'string' && AGENT_ID_PATTERN.test(value);
}

/** Bounded wire validation for a save request from the renderer. */
export function requireAgentSaveRequest(value: unknown): UiAgentSaveRequest {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Agent 配置无效');
	const item = value as Record<string, unknown>;
	const text = (key: string, max: number, required = true): string | undefined => {
		const raw = item[key];
		if (raw === undefined && !required) return undefined;
		if (typeof raw !== 'string' || raw.length > max || /[\u0000]/.test(raw) || (required && !raw.trim())) throw new Error(`Agent 配置字段无效：${key}`);
		return raw.trim();
	};
	if (item.id !== undefined && !isValidAgentId(item.id)) throw new Error('Agent ID 无效');
	const args = item.args === undefined ? [] : item.args;
	if (!Array.isArray(args) || args.length > 64 || args.some((arg) => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) throw new Error('Agent 参数无效');
	let env: Record<string, string> | undefined;
	if (item.env !== undefined) {
		if (!item.env || typeof item.env !== 'object' || Array.isArray(item.env)) throw new Error('Agent 环境变量无效');
		const entries = Object.entries(item.env as Record<string, unknown>);
		if (entries.length > 64 || entries.some(([key, val]) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || typeof val !== 'string' || val.length > 8192 || val.includes('\0'))) throw new Error('Agent 环境变量无效');
		env = Object.fromEntries(entries as [string, string][]);
	}
	if (typeof item.enabled !== 'boolean') throw new Error('Agent 启用状态无效');
	const accent = item.accentColor;
	if (accent !== undefined && accent !== null && (typeof accent !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(accent))) throw new Error('Agent 强调色无效');
	return {
		...(item.id !== undefined ? { id: item.id as string } : {}),
		displayName: text('displayName', 80)!,
		command: text('command', 4096)!,
		args: args as string[],
		...(env ? { env } : {}),
		enabled: item.enabled,
		...(accent !== undefined ? { accentColor: accent as string | null } : {}),
	};
}
