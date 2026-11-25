import { execFile, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { UiAgentInstallState } from '@pidesktop/shared';
import type { UiAgentConfig } from '@pidesktop/shared';
import { builtinAgent, openAgentLoginTerminal, startAgentInstall } from '@pidesktop/agent/agentSetup';

export interface AgentInstallDeps {
	findAgent(agentId: string): UiAgentConfig | undefined;
	startInstall: typeof startAgentInstall;
	openLogin(agent: UiAgentConfig): Promise<void>;
	timeoutMs: number;
}

const OUTPUT_LIMIT = 48 * 1024;
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const EMIT_INTERVAL_MS = 120;
// CSI / OSC escape sequences (colours, cursor moves, window titles).
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** Raw output → display text: no escape codes, `\r` progress lines collapsed to their last state. */
export function renderInstallOutput(raw: string): string {
	const text = raw.replace(ANSI, '').replace(/\r\n/g, '\n');
	return text.split('\n').map((line) => {
		const parts = line.split('\r');
		for (let index = parts.length - 1; index >= 0; index -= 1) if (parts[index]) return parts[index];
		return '';
	}).join('\n');
}

interface Job {
	state: UiAgentInstallState;
	raw: string;
	child: ChildProcess | null;
	timer?: ReturnType<typeof setTimeout>;
	emitTimer?: ReturnType<typeof setTimeout>;
	cancelled: boolean;
	timedOut: boolean;
}

function killTree(child: ChildProcess): void {
	const pid = child.pid;
	if (!pid) return;
	if (process.platform === 'win32') {
		execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 }, () => {});
		return;
	}
	try { process.kill(-pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
}

/**
 * Runs the official installers of built-in agents in the main process, one at
 * a time (concurrent `npm -g` runs race on the same global folder). Readiness
 * is re-checked by the renderer afterwards, through the agent host's probe.
 */
export class AgentInstallService {
	private readonly jobs = new Map<string, Job>();
	private readonly emit: (state: UiAgentInstallState) => void;
	private readonly deps: AgentInstallDeps;

	constructor(emit: (state: UiAgentInstallState) => void, deps: Partial<AgentInstallDeps> = {}) {
		this.emit = emit;
		this.deps = { findAgent: builtinAgent, startInstall: startAgentInstall, openLogin: (agent) => openAgentLoginTerminal(agent), timeoutMs: INSTALL_TIMEOUT_MS, ...deps };
	}

	list(): UiAgentInstallState[] {
		return [...this.jobs.values()].map((job) => this.snapshot(job));
	}

	start(agentId: string): UiAgentInstallState {
		const agent = this.deps.findAgent(agentId);
		if (!agent?.installer) throw new Error('该 Agent 不支持一键安装');
		const running = [...this.jobs.values()].find((job) => job.state.phase === 'running');
		if (running) throw new Error(running.state.agentId === agentId ? '正在安装中' : '另一个 Agent 正在安装，请等它完成后再试');
		const started = this.deps.startInstall(agent.installer);
		const child = started.child;
		const job: Job = {
			state: { agentId, phase: 'running', command: started.display, output: '', startedAt: Date.now() },
			raw: `> ${started.display}\n`, child, cancelled: false, timedOut: false,
		};
		this.jobs.set(agentId, job);
		const append = (text: string) => {
			if (!text) return;
			job.raw = (job.raw + text).slice(-OUTPUT_LIMIT * 2);
			this.schedule(job);
		};
		for (const stream of [child.stdout, child.stderr]) {
			const decoder = new StringDecoder('utf8');
			stream?.on('data', (chunk: Buffer) => append(decoder.write(chunk)));
			stream?.on('end', () => append(decoder.end()));
		}
		job.timer = setTimeout(() => { job.timedOut = true; killTree(child); }, this.deps.timeoutMs);
		child.once('error', (error) => this.finish(job, null, error.message));
		child.once('close', (code) => this.finish(job, code));
		this.publish(job);
		return this.snapshot(job);
	}

	cancel(agentId: string): void {
		const job = this.jobs.get(agentId);
		if (!job || job.state.phase !== 'running' || !job.child) return;
		job.cancelled = true;
		killTree(job.child);
	}

	async openLogin(agentId: string): Promise<void> {
		const agent = this.deps.findAgent(agentId);
		if (!agent) throw new Error('只有内置 Agent 支持在终端中登录');
		await this.deps.openLogin(agent);
	}

	dispose(): void {
		for (const job of this.jobs.values()) {
			if (job.state.phase === 'running' && job.child) { job.cancelled = true; killTree(job.child); }
		}
	}

	private finish(job: Job, code: number | null, error?: string): void {
		if (job.state.phase !== 'running') return;
		if (job.timer) clearTimeout(job.timer);
		job.child = null;
		job.state.finishedAt = Date.now();
		job.state.exitCode = code;
		if (job.cancelled) job.state.phase = 'cancelled';
		else if (code === 0 && !error) job.state.phase = 'succeeded';
		else {
			job.state.phase = 'failed';
			job.state.error = error ?? (job.timedOut ? `安装超时（${Math.round(this.deps.timeoutMs / 60000)} 分钟），已停止` : `安装命令退出码 ${code ?? '未知'}`);
		}
		this.publish(job);
	}

	private schedule(job: Job): void {
		if (job.emitTimer) return;
		job.emitTimer = setTimeout(() => { job.emitTimer = undefined; this.publish(job); }, EMIT_INTERVAL_MS);
	}

	private publish(job: Job): void {
		if (job.emitTimer && job.state.phase !== 'running') { clearTimeout(job.emitTimer); job.emitTimer = undefined; }
		this.emit(this.snapshot(job));
	}

	private snapshot(job: Job): UiAgentInstallState {
		return { ...job.state, output: renderInstallOutput(job.raw).slice(-OUTPUT_LIMIT) };
	}
}
