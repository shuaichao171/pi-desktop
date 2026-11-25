import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isValidAgentId, PI_AGENT_ID, requireAgentSaveRequest, type UiAgentConfig, type UiAgentSaveRequest, type UiAgentStatus } from '@pidesktop/shared';
import { resolveCommand, spawnResolved } from './command.ts';

/** Agents known to speak ACP. Commands are the ACP entry points, not the interactive CLIs. */
export const BUILTIN_AGENTS: readonly UiAgentConfig[] = [
	{ id: 'claude-code', displayName: 'Claude Code', command: 'claude-agent-acp', args: [], enabled: true, builtin: true, accentColor: '#D97757',
		installHint: 'npm install -g @agentclientprotocol/claude-agent-acp', loginHint: '在终端运行 claude 并完成登录（/login）', homepage: 'https://github.com/agentclientprotocol/claude-agent-acp' },
	{ id: 'codex', displayName: 'Codex', command: 'codex-acp', args: [], enabled: true, builtin: true, accentColor: '#10A37F',
		installHint: 'npm install -g @agentclientprotocol/codex-acp', loginHint: '在终端运行 codex login', homepage: 'https://github.com/agentclientprotocol/codex-acp' },
	// Antigravity CLI 1.5+ speaks ACP itself (`agy acp`) and reuses the login of an interactive `agy` session.
	{ id: 'antigravity', displayName: 'Antigravity', command: 'agy', args: ['acp'], enabled: true, builtin: true, accentColor: '#3186FF',
		installHint: process.platform === 'win32' ? 'irm https://antigravity.google/cli/install.ps1 | iex' : 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
		loginHint: '在终端运行一次 agy 并登录，或运行 agy acp --login', homepage: 'https://antigravity.google/docs/ide/extensions/acp/' },
	{ id: 'gemini', displayName: 'Gemini CLI', command: 'gemini', args: ['--experimental-acp'], enabled: true, builtin: true, accentColor: '#4285F4',
		installHint: 'npm install -g @google/gemini-cli', homepage: 'https://github.com/google-gemini/gemini-cli' },
	{ id: 'opencode', displayName: 'OpenCode', command: 'opencode', args: ['acp'], enabled: true, builtin: true, accentColor: '#6E56CF',
		installHint: 'npm install -g opencode-ai', homepage: 'https://opencode.ai' },
	{ id: 'qwen', displayName: 'Qwen Code', command: 'qwen', args: ['--experimental-acp'], enabled: true, builtin: true, accentColor: '#615CED',
		installHint: 'npm install -g @qwen-code/qwen-code', homepage: 'https://github.com/QwenLM/qwen-code' },
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
		const agents = this.list();
		return Promise.all(agents.map((agent) => this.status(agent, refresh)));
	}

	async status(agent: UiAgentConfig, refresh = false): Promise<UiAgentStatus> {
		if (!agent.enabled) return { ...agent, readiness: 'disabled', version: null, resolvedCommand: null };
		const env = { ...process.env, ...agent.env };
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
