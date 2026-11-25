import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isValidAgentId, PI_AGENT_ID, requireAgentSaveRequest, type UiAgentConfig, type UiAgentInstaller, type UiAgentSaveRequest, type UiAgentStatus } from '@pidesktop/shared';
import { refreshStoredSearchPath, resolveCommand, spawnResolved, withAgentSearchPath } from './command.ts';

const AGY_INSTALL = { kind: 'script', windowsUrl: 'https://antigravity.google/cli/install.ps1', posixUrl: 'https://antigravity.google/cli/install.sh' } as const;

/** The official install command as a user would type it. */
export function installerCommandLine(installer: UiAgentInstaller, platform: NodeJS.Platform = process.platform): string {
	if (installer.kind === 'npm') return `npm install -g ${installer.package}`;
	return platform === 'win32' ? `irm ${installer.windowsUrl} | iex` : `curl -fsSL ${installer.posixUrl} | bash`;
}

const builtin = (agent: Omit<UiAgentConfig, 'enabled' | 'builtin' | 'installHint'>): UiAgentConfig => ({
	...agent, enabled: true, builtin: true, ...(agent.installer ? { installHint: installerCommandLine(agent.installer) } : {}),
});

/**
 * Agents known to speak ACP. Commands are the ACP entry points, not the interactive CLIs;
 * `login` opens the agent's own interactive sign-in (the ACP adapters bundle their CLI).
 */
export const BUILTIN_AGENTS: readonly UiAgentConfig[] = [
	builtin({ id: 'claude-code', displayName: 'Claude Code', command: 'claude-agent-acp', args: [], accentColor: '#D97757',
		installer: { kind: 'npm', package: '@agentclientprotocol/claude-agent-acp' },
		login: { command: 'claude-agent-acp', args: ['--cli'] }, loginHint: '在 设置 → Agents 中点击“在终端中登录”，在打开的 Claude Code 里输入 /login 完成登录',
		quota: 'claude',
		homepage: 'https://github.com/agentclientprotocol/claude-agent-acp' }),
	builtin({ id: 'codex', displayName: 'Codex', command: 'codex-acp', args: [], accentColor: '#10A37F',
		installer: { kind: 'npm', package: '@agentclientprotocol/codex-acp' },
		login: { command: 'codex-acp', args: ['login'] }, loginHint: '在 设置 → Agents 中点击“在终端中登录”，或在终端运行 codex login',
		quota: 'codex',
		homepage: 'https://github.com/agentclientprotocol/codex-acp' }),
	// Antigravity CLI 1.5+ speaks ACP itself (`agy acp`) and reuses the login of an interactive `agy` session.
	builtin({ id: 'antigravity', displayName: 'Antigravity', command: 'agy', args: ['acp'], accentColor: '#3186FF',
		installer: AGY_INSTALL,
		login: { command: 'agy', args: [] }, loginHint: '在 设置 → Agents 中点击“在终端中登录”，或在终端运行一次 agy 并登录',
		// Verified with agy 1.5.17: a prompt sent mid-turn ends the running one and continues.
		steer: true,
		quota: 'antigravity',
		homepage: 'https://antigravity.google/docs/ide/extensions/acp/' }),
	builtin({ id: 'gemini', displayName: 'Gemini CLI', command: 'gemini', args: ['--experimental-acp'], accentColor: '#4285F4',
		installer: { kind: 'npm', package: '@google/gemini-cli' }, login: { command: 'gemini', args: [] },
		homepage: 'https://github.com/google-gemini/gemini-cli' }),
	builtin({ id: 'opencode', displayName: 'OpenCode', command: 'opencode', args: ['acp'], accentColor: '#6E56CF',
		installer: { kind: 'npm', package: 'opencode-ai' }, login: { command: 'opencode', args: ['auth', 'login'] },
		homepage: 'https://opencode.ai' }),
	builtin({ id: 'qwen', displayName: 'Qwen Code', command: 'qwen', args: ['--experimental-acp'], accentColor: '#615CED',
		installer: { kind: 'npm', package: '@qwen-code/qwen-code' }, login: { command: 'qwen', args: [] },
		homepage: 'https://github.com/QwenLM/qwen-code' }),
	// Community adapter (not by Zhipu): bridges an installed ZCode CLI (`zcode app-server --stdio`) to ACP.
	// Its own default mode is `yolo`; the modes are undocumented, so no mode is preset here.
	builtin({ id: 'zcode', displayName: 'ZCode', command: 'zcode-acp-server', args: [], accentColor: '#2F6BFF',
		installer: { kind: 'npm', package: 'zcode-acp-server' },
		login: { command: 'zcode-acp', args: ['setup', '--provider', 'bigmodel'] },
		loginHint: '在 设置 → Agents 中点击“在终端中登录”填入智谱 Coding Plan API Key（Z.ai 国际版账号在终端运行 zcode-acp setup --provider zai），或先在 ZCode 桌面版中登录',
		community: true, note: '需要本机已安装 ZCode（桌面版或 CLI 0.14.8 以上）；它默认使用 yolo 模式，不经确认执行操作，可在 Agent 选项中切换。',
		homepage: 'https://github.com/william0wang/zcode-acp' }),
];

interface StoredAgents {
	version: 1;
	/** Builtin overrides and custom agents, by id. */
	agents: Record<string, Partial<UiAgentConfig>>;
}

const PROBE_TIMEOUT_MS = 5000;
const VERSION_PATTERN = /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/;

/** Run `<command> --version` with stdin closed; any failure just means "version unknown". */
function probeVersion(resolved: string, env: NodeJS.ProcessEnv): Promise<string | null> {
	return new Promise((resolve) => {
		let output = '';
		let done = false;
		const finish = (value: string | null) => { if (!done) { done = true; resolve(value); } };
		let child: ReturnType<typeof spawn>;
		try {
			child = spawnResolved(resolved, ['--version'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		} catch { finish(null); return; }
		const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(null); }, PROBE_TIMEOUT_MS);
		const collect = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(0, 2000); };
		child.stdout?.on('data', collect);
		child.stderr?.on('data', collect);
		child.once('error', () => { clearTimeout(timer); finish(null); });
		child.once('exit', () => { clearTimeout(timer); finish(output.match(VERSION_PATTERN)?.[0] ?? null); });
	});
}

/**
 * Agent configuration (builtin catalog merged with user edits) and passive
 * readiness. Probing only resolves the executable and asks for its version;
 * it never opens a session, so no hooks, MCP servers or sign-in flows run.
 */
export class AgentRegistry {
	private readonly file: string;
	private stored: StoredAgents;
	private searchPathLoaded = false;
	private readonly probes = new Map<string, { command: string; resolved: string | null; version: string | null }>();

	constructor(file: string) {
		this.file = file;
		this.stored = this.read();
	}

	list(): UiAgentConfig[] {
		const builtins = BUILTIN_AGENTS.map((agent) => this.merge(agent, this.stored.agents[agent.id]));
		const custom = Object.entries(this.stored.agents)
			.filter(([id, value]) => !BUILTIN_AGENTS.some((agent) => agent.id === id) && value.command)
			.map(([id, value]) => this.merge({ id, displayName: id, command: '', args: [], enabled: true, builtin: false }, value));
		return [...builtins, ...custom];
	}

	get(id: string): UiAgentConfig | undefined {
		return this.list().find((agent) => agent.id === id);
	}

	save(input: UiAgentSaveRequest): UiAgentConfig {
		const request = requireAgentSaveRequest(input);
		const id = request.id ?? this.newId(request.displayName);
		if (id === PI_AGENT_ID) throw new Error('Pi 不能作为外部 Agent 配置');
		const builtin = BUILTIN_AGENTS.find((agent) => agent.id === id);
		if (!builtin && request.id && !this.stored.agents[id]) throw new Error('Agent 不存在');
		this.stored.agents[id] = {
			displayName: request.displayName,
			command: request.command,
			args: request.args,
			env: request.env ?? {},
			enabled: request.enabled,
			accentColor: request.accentColor ?? builtin?.accentColor ?? null,
		};
		this.write();
		this.probes.delete(id);
		return this.get(id)!;
	}

	/** Custom agents are deleted; builtin ones go back to their defaults. */
	remove(id: string): void {
		if (!isValidAgentId(id)) throw new Error('Agent ID 无效');
		if (!(id in this.stored.agents)) return;
		delete this.stored.agents[id];
		this.write();
		this.probes.delete(id);
	}

	/** Readiness for every agent; `refresh` re-runs the probe instead of using the cached one. */
	async statuses(refresh = false): Promise<UiAgentStatus[]> {
		// An installer may have edited the user PATH since the last look.
		if (refresh || !this.searchPathLoaded) { this.searchPathLoaded = true; await refreshStoredSearchPath(); }
		const agents = this.list();
		return Promise.all(agents.map((agent) => this.status(agent, refresh)));
	}

	async status(agent: UiAgentConfig, refresh = false): Promise<UiAgentStatus> {
		if (!agent.enabled) return { ...agent, readiness: 'disabled', version: null, resolvedCommand: null };
		const env = withAgentSearchPath({ ...process.env, ...agent.env });
		let probe = this.probes.get(agent.id);
		if (refresh || !probe || probe.command !== agent.command) {
			const resolved = resolveCommand(agent.command, env);
			probe = { command: agent.command, resolved, version: resolved ? await probeVersion(resolved, env) : null };
			this.probes.set(agent.id, probe);
		}
		if (!probe.resolved) {
			return { ...agent, readiness: 'install', version: null, resolvedCommand: null, message: `未找到命令 ${agent.command}` };
		}
		return { ...agent, readiness: 'ready', version: probe.version, resolvedCommand: probe.resolved };
	}

	private merge(base: UiAgentConfig, value: Partial<UiAgentConfig> | undefined): UiAgentConfig {
		if (!value) return { ...base, args: [...base.args] };
		return {
			...base,
			displayName: typeof value.displayName === 'string' && value.displayName.trim() ? value.displayName : base.displayName,
			command: typeof value.command === 'string' && value.command.trim() ? value.command : base.command,
			args: Array.isArray(value.args) ? value.args.filter((arg): arg is string => typeof arg === 'string') : [...base.args],
			env: value.env && typeof value.env === 'object' ? { ...value.env } : base.env,
			enabled: typeof value.enabled === 'boolean' ? value.enabled : base.enabled,
			accentColor: value.accentColor === null || typeof value.accentColor === 'string' ? value.accentColor : base.accentColor ?? null,
		};
	}

	private newId(name: string): string {
		const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
		const base = slug && /^[a-z0-9]/.test(slug) ? slug : 'agent';
		let id = base === PI_AGENT_ID ? `${base}-agent` : base;
		while (this.get(id)) id = `${base}-${randomUUID().slice(0, 6)}`;
		return id;
	}

	private read(): StoredAgents {
		try {
			const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as StoredAgents;
			if (parsed?.version === 1 && parsed.agents && typeof parsed.agents === 'object') {
				const agents = Object.fromEntries(Object.entries(parsed.agents).filter(([id, value]) => isValidAgentId(id) && id !== PI_AGENT_ID && value && typeof value === 'object'));
				return { version: 1, agents };
			}
		} catch { /* missing or malformed: defaults */ }
		return { version: 1, agents: {} };
	}

	private write(): void {
		mkdirSync(dirname(this.file), { recursive: true });
		const temp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(this.stored, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
		renameSync(temp, this.file);
	}
}
