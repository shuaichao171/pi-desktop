import { mkdirSync } from 'node:fs';
import type { UiAgentConfig, UiAgentQuota, UiAgentQuotaWindow } from '@pidesktop/shared';
import { killProcessTree } from '../shellInterrupt.ts';
import { resolveCommand, spawnResolved, withAgentSearchPath } from './command.ts';
import { AcpConnection, MethodNotFoundError } from './connection.ts';

/**
 * Account plan limits (the 5-hour and weekly windows) of agents whose adapter can
 * report them. Each read starts a short-lived helper process and never touches the
 * agent's credentials: Codex answers `account/rateLimits/read` on its own app-server,
 * Claude Code renders its `/usage` in a throwaway, unsaved session, and the Antigravity
 * CLI prints `/usage` as JSON without starting a turn.
 */

const QUOTA_TIMEOUT_MS = 45_000;
const CACHE_MS = 3 * 60_000;
const FIVE_HOURS_MINUTES = 300;
const WEEK_MINUTES = 7 * 24 * 60;

export interface AgentQuotaDeps {
	/** A folder the helper sessions may use as their working directory. */
	workDir: string;
	now?: () => number;
	timeoutMs?: number;
}

/** The agent's configuration plus the version its readiness probe found. */
export type AgentQuotaTarget = UiAgentConfig & { version?: string | null };

interface CodexWindow { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown }
interface CodexSnapshot { limitId?: unknown; limitName?: unknown; primary?: CodexWindow | null; secondary?: CodexWindow | null; planType?: unknown }
interface CodexRateLimits { rateLimits?: CodexSnapshot | null; rateLimitsByLimitId?: Record<string, CodexSnapshot | null | undefined> | null }

const percent = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;

function windowLabel(minutes: number): string {
	if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

/** Windows of an `account/rateLimits/read` response; the default `codex` limit comes first. */
export function codexQuotaWindows(response: CodexRateLimits): { windows: UiAgentQuotaWindow[]; plan: string | null } {
	const snapshots: CodexSnapshot[] = [];
	const byId = response.rateLimitsByLimitId && typeof response.rateLimitsByLimitId === 'object' ? Object.values(response.rateLimitsByLimitId).filter((item): item is CodexSnapshot => !!item && typeof item === 'object') : [];
	if (byId.length) snapshots.push(...byId);
	else if (response.rateLimits && typeof response.rateLimits === 'object') snapshots.push(response.rateLimits);
	snapshots.sort((a, b) => Number((b.limitId ?? 'codex') === 'codex') - Number((a.limitId ?? 'codex') === 'codex'));
	const windows: UiAgentQuotaWindow[] = [];
	let plan: string | null = null;
	for (const snapshot of snapshots) {
		const main = (snapshot.limitId ?? 'codex') === 'codex';
		if (main && typeof snapshot.planType === 'string') plan = snapshot.planType;
		const name = typeof snapshot.limitName === 'string' && snapshot.limitName.trim() ? snapshot.limitName.trim() : typeof snapshot.limitId === 'string' ? snapshot.limitId : '';
		for (const item of [snapshot.primary, snapshot.secondary]) {
			const used = percent(item?.usedPercent);
			if (!item || used === null) continue;
			const minutes = typeof item.windowDurationMins === 'number' ? item.windowDurationMins : null;
			const resetsAt = typeof item.resetsAt === 'number' && item.resetsAt > 0 ? item.resetsAt * 1000 : null;
			const kind = !main || minutes === null ? 'other' : minutes === FIVE_HOURS_MINUTES ? 'five_hour' : minutes === WEEK_MINUTES ? 'weekly' : 'other';
			const label = kind === 'other' ? [main ? '' : name, minutes === null ? '' : windowLabel(minutes)].filter(Boolean).join(' ') || undefined : undefined;
			windows.push({ kind, ...(label ? { label } : {}), usedPercent: used, resetsAt });
		}
	}
	return { windows, plan };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * The reset time as claude-agent-acp prints it (`Intl` "en": "Nov 25, 3:00 PM GMT+8").
 * The year is left out, so the next such moment is taken; a zone that is not a GMT
 * offset means the local zone, which the adapter shares with this process.
 */
export function parseClaudeResetTime(text: string, now: number): number | null {
	const match = /^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{1,2}):(\d{2})[\s ]*([AP]M)(?:\s+(\S+))?$/i.exec(text.trim());
	if (!match) {
		const parsed = Date.parse(text);
		return Number.isNaN(parsed) ? null : parsed;
	}
	const month = MONTHS.indexOf(match[1].toLowerCase());
	if (month < 0) return null;
	const day = Number(match[2]);
	let hour = Number(match[3]) % 12;
	if (match[5].toUpperCase() === 'PM') hour += 12;
	const minute = Number(match[4]);
	const zone = match[6] ? /^(?:GMT|UTC)(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/i.exec(match[6]) : null;
	const at = (year: number): number => {
		if (!zone) return new Date(year, month, day, hour, minute).getTime();
		const offset = zone[1] ? (zone[1] === '-' ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3] ?? 0)) : 0;
		return Date.UTC(year, month, day, hour, minute) - offset * 60_000;
	};
	const year = new Date(now).getFullYear();
	const value = at(year);
	// A reset lies ahead; a date well in the past belongs to next year (December → January).
	return value < now - 24 * 60 * 60_000 ? at(year + 1) : value;
}

const unescapeMarkdown = (value: string): string => value.replace(/\\([\\`*_[\]<>|])/g, '$1');

/**
 * Plan limits from the Markdown claude-agent-acp renders for `/usage`. Null when the
 * text is not that rendering (the adapter then forwards Claude Code's own output).
 */
export function parseClaudeUsage(text: string, now: number): { windows: UiAgentQuotaWindow[]; plan: string | null } | null {
	if (!/^##\s+Usage\s*$/m.test(text)) return null;
	const plan = /^>\s*Claude\s+(.+?)\s+subscription usage\s*$/m.exec(text)?.[1];
	const windows: UiAgentQuotaWindow[] = [];
	for (const line of text.split(/\r?\n/)) {
		const match = /^\*\*(.+?)\*\*\s+—\s+\*\*(\d+(?:\.\d+)?)%\*\*(?:\s+·\s+Resets\s+(.+))?\s*$/.exec(line.trim());
		if (!match) continue;
		const label = unescapeMarkdown(match[1]).trim();
		const used = percent(Number(match[2]));
		if (used === null) continue;
		const resetsAt = match[3] ? parseClaudeResetTime(unescapeMarkdown(match[3]), now) : null;
		const kind = /^5-hour\b/i.test(label) ? 'five_hour' : /^Weekly\s+·\s+all models$/i.test(label) ? 'weekly' : 'other';
		windows.push({ kind, ...(kind === 'other' ? { label: label.replace(/^Weekly\s+·\s+/i, '') } : {}), usedPercent: used, resetsAt });
	}
	return { windows, plan: plan ? unescapeMarkdown(plan) : null };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const rejectRequests = (method: string): Promise<never> => Promise.reject(new MethodNotFoundError(method));

/** `codex-acp cli app-server` runs the Codex CLI the adapter bundles (after any configured arguments). */
async function readCodex(agent: UiAgentConfig, deps: Required<AgentQuotaDeps>): Promise<{ windows: UiAgentQuotaWindow[]; plan: string | null }> {
	const connection = AcpConnection.start({ command: agent.command, args: [...agent.args, 'cli', 'app-server'], cwd: deps.workDir, env: agent.env, onNotification: () => {}, onRequest: rejectRequests });
	try {
		return await withTimeout((async () => {
			await connection.request('initialize', { clientInfo: { name: 'pi-desktop', title: 'Pi Desktop', version: '1' } });
			connection.notify('initialized', undefined);
			return codexQuotaWindows(await connection.request<CodexRateLimits>('account/rateLimits/read', undefined));
		})(), deps.timeoutMs, 'Codex 额度查询超时');
	} finally { await connection.close(); }
}

/** `/usage` in a session that loads no settings (no hooks or plugins run) and is not saved. */
async function readClaude(agent: UiAgentConfig, deps: Required<AgentQuotaDeps>): Promise<{ windows: UiAgentQuotaWindow[]; plan: string | null }> {
	let sessionId = '';
	let text = '';
	const connection = AcpConnection.start({
		command: agent.command, args: agent.args, cwd: deps.workDir, env: agent.env,
		onNotification: (method, params) => {
			const value = params as { sessionId?: string; update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } } | null;
			if (method !== 'session/update' || value?.sessionId !== sessionId) return;
			const update = value.update;
			if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && typeof update.content.text === 'string' && text.length < 200_000) text += update.content.text;
		},
		onRequest: rejectRequests,
	});
	try {
		return await withTimeout((async () => {
			await connection.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
			const created = await connection.request<{ sessionId: string }>('session/new', {
				cwd: deps.workDir, mcpServers: [],
				_meta: { claudeCode: { options: { persistSession: false, settingSources: [] } } },
			});
			sessionId = created.sessionId;
			await connection.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/usage' }] });
			const parsed = parseClaudeUsage(text, deps.now());
			if (!parsed) throw new Error('Claude Code 没有返回额度信息');
			return parsed;
		})(), deps.timeoutMs, 'Claude Code 额度查询超时');
	} finally { await connection.close(); }
}

interface AgyBucket { window?: unknown; remaining_fraction?: unknown; reset_time?: unknown }
interface AgyUsage { command?: { name?: unknown; data?: { groups?: { name?: unknown; buckets?: AgyBucket[] | null }[] | null } | null } | null }

/** Windows of `agy -p /usage --output-format json`: each model group has its own 5-hour and weekly limit. */
export function antigravityQuotaWindows(output: AgyUsage): UiAgentQuotaWindow[] | null {
	const data = output?.command?.name === 'usage' ? output.command.data : null;
	if (!data || !Array.isArray(data.groups)) return null;
	const windows: UiAgentQuotaWindow[] = [];
	for (const group of data.groups) {
		const name = typeof group?.name === 'string' ? group.name.trim() : '';
		for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
			const remaining = typeof bucket?.remaining_fraction === 'number' && Number.isFinite(bucket.remaining_fraction) ? bucket.remaining_fraction : null;
			if (remaining === null) continue;
			const kind = bucket.window === '5h' ? 'five_hour' : bucket.window === 'weekly' ? 'weekly' : 'other';
			const reset = typeof bucket.reset_time === 'string' ? Date.parse(bucket.reset_time) : NaN;
			// An untouched window reports the epoch as its reset time.
			const resetsAt = Number.isFinite(reset) && reset > 0 ? reset : null;
			const label = kind === 'other' && typeof bucket.window === 'string' ? bucket.window : undefined;
			windows.push({ kind, ...(label ? { label } : {}), ...(name ? { group: name } : {}), usedPercent: percent(Math.round((1 - remaining) * 10_000) / 100)!, resetsAt });
		}
	}
	return windows;
}

/** `-p "/usage"` answers without a turn since agy 1.1.11; older versions would send it to the model. */
const AGY_USAGE_MIN_VERSION = [1, 1, 11];
export function versionAtLeast(version: string | null | undefined, minimum: number[]): boolean {
	const parts = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version ?? '');
	if (!parts) return false;
	const actual = [Number(parts[1]), Number(parts[2]), Number(parts[3] ?? 0)];
	for (let index = 0; index < minimum.length; index += 1) if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
	return true;
}

/** Run a command to completion with stdin closed; stdout is capped, the process tree is killed on timeout. */
function runToCompletion(command: string, args: string[], options: { cwd: string; env?: Record<string, string>; timeoutMs: number; timeoutMessage: string }): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const env = withAgentSearchPath({ ...process.env, ...options.env });
	const resolved = resolveCommand(command, env);
	if (!resolved) return Promise.reject(new Error(`找不到 Agent 命令：${command}`));
	return new Promise((resolve, reject) => {
		const child = spawnResolved(resolved, args, { cwd: options.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
		let stdout = '', stderr = '', settled = false;
		const finish = (action: () => void) => { if (!settled) { settled = true; clearTimeout(timer); action(); } };
		const timer = setTimeout(() => finish(() => {
			if (child.pid) killProcessTree(child.pid); else child.kill();
			reject(new Error(options.timeoutMessage));
		}), options.timeoutMs);
		child.stdout!.setEncoding('utf8');
		child.stdout!.on('data', (chunk: string) => { if (stdout.length < 1_000_000) stdout += chunk; });
		child.stderr!.setEncoding('utf8');
		child.stderr!.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
		child.once('error', (error) => finish(() => reject(error)));
		child.once('close', (code) => finish(() => resolve({ code, stdout, stderr })));
	});
}

/** The CLI itself (the configured arguments without the `acp` subcommand) in print mode. */
async function readAntigravity(agent: AgentQuotaTarget, deps: Required<AgentQuotaDeps>): Promise<{ windows: UiAgentQuotaWindow[]; plan: string | null }> {
	if (!versionAtLeast(agent.version, AGY_USAGE_MIN_VERSION)) throw new Error(`需要 Antigravity CLI 1.1.11 以上才能查询额度${agent.version ? `（当前 ${agent.version}）` : ''}`);
	const args = [...agent.args.filter((arg) => arg !== 'acp'), '-p', '/usage', '--output-format', 'json'];
	const result = await runToCompletion(agent.command, args, { cwd: deps.workDir, env: agent.env, timeoutMs: deps.timeoutMs, timeoutMessage: 'Antigravity 额度查询超时' });
	// Exit code 2: signed in with a GEMINI_API_KEY, which has no account quota.
	if (result.code === 2) return { windows: [], plan: null };
	if (result.code !== 0) throw new Error(`Antigravity 额度查询失败（${result.code ?? '已终止'}）${result.stderr.trim() ? `：${result.stderr.trim().split('\n').slice(-2).join(' ')}` : ''}`);
	let output: AgyUsage;
	try { output = JSON.parse(result.stdout.replace(/^﻿/, '')) as AgyUsage; } catch { throw new Error('Antigravity 没有返回额度信息'); }
	const windows = antigravityQuotaWindows(output);
	if (!windows) throw new Error('Antigravity 没有返回额度信息');
	return { windows, plan: null };
}

const READERS = { codex: readCodex, claude: readClaude, antigravity: readAntigravity } as const;

/** Reads and briefly caches each agent's plan limits; concurrent reads share one helper process. */
export class AgentQuotaService {
	private readonly deps: Required<AgentQuotaDeps>;
	private readonly cache = new Map<string, { command: string; quota: UiAgentQuota }>();
	private readonly inflight = new Map<string, Promise<UiAgentQuota>>();
	private workDirReady = false;

	constructor(deps: AgentQuotaDeps) {
		this.deps = { now: Date.now, timeoutMs: QUOTA_TIMEOUT_MS, ...deps };
	}

	read(agent: AgentQuotaTarget, refresh = false): Promise<UiAgentQuota> {
		const source = agent.quota;
		if (!source || !(source in READERS)) return Promise.resolve({ agentId: agent.id, ok: false, queriedAt: this.deps.now(), windows: [], error: '该 Agent 不提供账号额度' });
		const cached = this.cache.get(agent.id);
		if (!refresh && cached && cached.command === agent.command && cached.quota.ok && this.deps.now() - cached.quota.queriedAt < CACHE_MS) return Promise.resolve(cached.quota);
		const running = this.inflight.get(agent.id);
		if (running) return running;
		const task = (async (): Promise<UiAgentQuota> => {
			const queriedAt = this.deps.now();
			try {
				if (!this.workDirReady) { mkdirSync(this.deps.workDir, { recursive: true }); this.workDirReady = true; }
				const { windows, plan } = await READERS[source](agent, this.deps);
				const quota: UiAgentQuota = { agentId: agent.id, ok: true, queriedAt, windows, plan };
				this.cache.set(agent.id, { command: agent.command, quota });
				return quota;
			} catch (error) {
				const last = this.cache.get(agent.id)?.quota;
				return { agentId: agent.id, ok: false, queriedAt, windows: last?.windows ?? [], plan: last?.plan ?? null, error: error instanceof Error ? error.message : String(error) };
			} finally { this.inflight.delete(agent.id); }
		})();
		this.inflight.set(agent.id, task);
		return task;
	}
}
