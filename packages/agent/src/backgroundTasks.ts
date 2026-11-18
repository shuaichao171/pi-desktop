/**
 * Background tasks with assistant self-wake (Claude Desktop parity).
 *
 * Mirrors claude.ai's "script keeps running after the conversation ends, then
 * re-wakes the assistant with its result" mechanism, adapted to Pi's resident
 * agent-host model:
 *
 * - The `run_in_background` tool spawns a shell command owned by this module
 *   (not by the turn): detached from the agent host process, stdout/stderr
 *   appended straight into a per-task log file, so the script survives agent
 *   host restarts and keeps writing output.
 * - Task lifecycle is persisted in a per-session registry file
 *   (`<sessionDir>/.pi-desktop-background-tasks/<sessionId>.json`); on session
 *   attach, running tasks are re-adopted by pid polling (host restart) and
 *   already-finished-but-undelivered notifications are delivered.
 * - When a task exits, a synthetic user message carrying the exit code and the
 *   output tail is injected through the owning session's `prompt()` — a
 *   self-invoked turn with no human input. A chain guard stops runaway
 *   auto-continuation after several synthetic turns without real user input.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { openSync, closeSync, readFileSync, readSync, existsSync, mkdirSync, renameSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { Type, type Static } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

/** Per-session concurrent background task cap. */
export const MAX_BACKGROUND_TASKS_PER_SESSION = 8;
/** Longest synthetic user message tail we compose (characters). */
export const WAKE_OUTPUT_TAIL_CHARS = 4000;
/** Max auto-wakes in a row without real user input before notifications stay pending. */
export const MAX_AUTO_WAKE_CHAIN = 6;
/** Poll interval for re-adopted (host-restart) tasks whose exit handle is gone. */
export const ADOPT_POLL_MS = 5000;
/** First retry delay when the owning session is busy; grows to RETRY_MAX_MS. */
const RETRY_FIRST_MS = 5000;
const RETRY_MAX_MS = 30000;
/** Total time a delivery keeps retrying before parking as pending. */
const DELIVER_BUDGET_MS = 15 * 60 * 1000;
/** Consecutive prompt failures (not busy) before parking until user activity. */
export const MAX_PROMPT_FAILURES = 3;

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed';

export interface BackgroundTaskRecord {
	taskId: string;
	sessionId: string;
	command: string;
	cwd: string;
	note?: string;
	pid: number;
	logFile: string;
	startedAt: number;
	endedAt?: number;
	/** null when unknown: killed by a signal, or the exit happened while this host was down. */
	exitCode?: number | null;
	/** Terminating signal (POSIX) when the process was killed by one. */
	signal?: string;
	/** True when the exit was detected by pid polling after a host restart (exit code unknowable). */
	exitedOffline?: boolean;
	status: BackgroundTaskStatus;
	/** Set once the completion notification has been prompted into the session. */
	delivered?: boolean;
	/** Guard marker: task was already settled; used to keep records idempotent. */
	settled?: boolean;
}

/** Hooks into the owning session service; installed on session attach. */
export interface BackgroundSessionHooks {
	/** Inject the synthetic user message (self-invoked turn). */
	prompt(text: string): Promise<void>;
	/** True when the session can start a new run now. */
	isIdle(): boolean;
	/** Live UI system notice (does not persist in the transcript). */
	notify(kind: 'info' | 'warning' | 'error', text: string): void;
}

export interface BackgroundTaskStart {
	sessionId: string;
	sessionDir: string;
	cwd: string;
	command: string;
	note?: string;
}

function registryFile(sessionDir: string, sessionId: string): string {
	return join(sessionDir, '.pi-desktop-background-tasks', `${sessionId}.json`);
}

function readRegistry(path: string): BackgroundTaskRecord[] {
	try {
		const raw = JSON.parse(readFileSync(path, 'utf8'));
		if (!Array.isArray(raw)) return [];
		return raw.filter((item): item is BackgroundTaskRecord => !!item && typeof item.taskId === 'string');
	} catch {
		return [];
	}
}

function writeRegistry(path: string, records: BackgroundTaskRecord[]): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, JSON.stringify(records, null, '\t'), 'utf8');
		renameSync(tmp, path);
	} catch {
		// Registry persistence is best-effort; in-memory state stays authoritative.
	}
}

export function isPidAlive(pid: number): boolean {
	// pid <= 0 addresses process groups / every process (POSIX `kill -1`): never a real task.
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: process exists but is owned by another user — still alive.
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** Read the last `maxChars` characters of a UTF-8 file (best effort). */
export function readTail(file: string, maxChars: number): string {
	try {
		const size = statSync(file).size;
		const fd = openSync(file, 'r');
		try {
			const bytes = Math.min(size, maxChars * 4 + 1024);
			const buffer = Buffer.alloc(bytes);
			const read = readSync(fd, buffer, 0, bytes, Math.max(0, size - bytes));
			return buffer.subarray(0, read).toString('utf8').slice(-maxChars);
		} finally {
			closeSync(fd);
		}
	} catch {
		return '';
	}
}


export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

/** Compose the synthetic user message that re-wakes the assistant. */
export function buildWakeMessage(record: BackgroundTaskRecord, tail: string): string {
	const exit = record.signal
		? `被信号 ${record.signal} 终止`
		: record.exitCode !== null && record.exitCode !== undefined
			? `退出码 ${record.exitCode}`
			: record.exitedOffline ? '退出码未知（进程在宿主离线期间结束）' : '退出码未知';
	const lines = [
		`[后台任务结束] taskId=${record.taskId}`,
		`命令: ${record.command}`,
		`结果: ${exit}（${record.status === 'failed' ? '失败' : '完成'}），耗时 ${formatDuration((record.endedAt ?? Date.now()) - record.startedAt)}`,
	];
	if (record.note) lines.push(`说明: ${record.note}`);
	lines.push('输出末尾（截断保留）:', '--------', tail || '（无输出）', '--------', `完整日志: ${record.logFile}`, '', '请基于该结果继续之前的工作。');
	return lines.join('\n');
}

interface TrackedTask {
	record: BackgroundTaskRecord;
	registryPath: string;
	child?: ChildProcess;
	pollTimer?: ReturnType<typeof setInterval>;
	deliverTimer?: ReturnType<typeof setTimeout>;
	deliverStartedAt?: number;
	deliverAttempts?: number;
	/** Consecutive hooks.prompt rejections (busy retries excluded). */
	promptFailures?: number;
}

/** Delete a task log only when it lives in the registry's own directory. */
function removeTaskLog(registryPath: string, record: BackgroundTaskRecord): void {
	if (!record.logFile || dirname(record.logFile) !== dirname(registryPath)) return;
	try { unlinkSync(record.logFile); } catch { /* already gone */ }
}

/**
 * Process-wide background task manager. The agent host is one process; tasks
 * are keyed by sessionId so parallel session runtimes never cross-wake.
 */
export class BackgroundTaskManager {
	/** Injectable timing knobs (tests use small values; production keeps the module defaults). */
	private readonly timing: { retryFirstMs: number; retryMaxMs: number; deliverBudgetMs: number; adoptPollMs: number };

	constructor(timing: Partial<{ retryFirstMs: number; retryMaxMs: number; deliverBudgetMs: number; adoptPollMs: number }> = {}) {
		this.timing = { retryFirstMs: RETRY_FIRST_MS, retryMaxMs: RETRY_MAX_MS, deliverBudgetMs: DELIVER_BUDGET_MS, adoptPollMs: ADOPT_POLL_MS, ...timing };
	}

	private readonly hooks = new Map<string, BackgroundSessionHooks>();
	private readonly tasks = new Map<string, TrackedTask>();
	/** Synthetic wake chain per session since the last real user prompt. */
	private readonly wakeChain = new Map<string, number>();

	attach(sessionId: string, hooks: BackgroundSessionHooks): void {
		this.hooks.set(sessionId, hooks);
		// 会话离开期间结束的内存任务：deliver 因无 hooks 已放弃，回到会话时重新投递（adopt 只处理未在内存的记录）。
		this.rearmPending(sessionId, 0);
	}

	detach(sessionId: string): void {
		this.hooks.delete(sessionId);
	}

	/** Real user activity resets the auto-wake chain guard and re-arms parked notifications. */
	noteUserActivity(sessionId: string): void {
		this.wakeChain.delete(sessionId);
		// 通知在链守卫/预算耗尽/投递失败时被搁置；用户回来后立即补投。
		this.rearmPending(sessionId, 0);
	}

	/** Restart delivery of settled-but-undelivered tasks with a fresh retry budget. */
	private rearmPending(sessionId: string, delayMs: number): void {
		for (const task of this.tasks.values()) {
			if (task.record.sessionId !== sessionId || task.record.status === 'running' || task.record.delivered) continue;
			task.deliverStartedAt = undefined;
			task.deliverAttempts = 0;
			task.promptFailures = 0;
			this.scheduleDelivery(task.record.taskId, delayMs);
		}
	}

	runningCount(sessionId: string): number {
		let count = 0;
		for (const task of this.tasks.values()) if (task.record.sessionId === sessionId && task.record.status === 'running') count += 1;
		return count;
	}

	hooked(sessionId: string): boolean {
		return this.hooks.has(sessionId);
	}

	wakeChainCount(sessionId: string): number {
		return this.wakeChain.get(sessionId) ?? 0;
	}

	/** Spawn a detached background task and register it for wake-on-exit. */
	start(request: BackgroundTaskStart, spawnTask: (logFile: string) => { child: ChildProcess; pid: number }): BackgroundTaskRecord {
		const dir = join(request.sessionDir, '.pi-desktop-background-tasks');
		mkdirSync(dir, { recursive: true });
		const taskId = `bg-${randomUUID().slice(0, 8)}`;
		const logFile = join(dir, `${taskId}.log`);
		const { child, pid } = spawnTask(logFile);
		// 未拿到 pid 说明启动失败：不登记，避免留下永远 running 的幽灵任务。
		if (!Number.isInteger(pid) || pid <= 0) throw new Error('后台任务启动失败：未获得进程 pid');
		const record: BackgroundTaskRecord = {
			taskId, sessionId: request.sessionId, command: request.command, cwd: request.cwd,
			note: request.note, pid, logFile, startedAt: Date.now(), status: 'running',
		};
		const registryPath = registryFile(request.sessionDir, request.sessionId);
		const tracked: TrackedTask = { record, registryPath, child };
		this.tasks.set(taskId, tracked);
		this.persist(tracked);
		child.once('exit', (code, signal) => { this.settle(taskId, code, { signal: signal ?? undefined }); });
		// 启动后才出现的 spawn 错误（通常不会再有 exit 事件）：按失败结算，settle 本身幂等。
		child.once('error', () => { this.settle(taskId, null); });
		return record;
	}

	/** Task finished: capture tail, persist, then wake the session. */
	settle(taskId: string, exitCode: number | null, options: { offline?: boolean; signal?: string } = {}): BackgroundTaskRecord | null {
		const tracked = this.tasks.get(taskId);
		if (!tracked || tracked.record.status !== 'running') return null;
		if (exitCode === 0) tracked.record.status = 'completed';
		else if (exitCode === null && options.offline) tracked.record.status = 'completed'; // 宿主离线期间结束，退出码不可知
		else tracked.record.status = 'failed';
		tracked.record.exitCode = exitCode;
		if (options.signal) tracked.record.signal = options.signal;
		if (options.offline) tracked.record.exitedOffline = true;
		tracked.record.endedAt = Date.now();
		tracked.record.settled = true;
		if (tracked.pollTimer) clearInterval(tracked.pollTimer);
		this.persist(tracked);
		this.scheduleDelivery(taskId, 0);
		return tracked.record;
	}

	/** Adopt persisted tasks on session attach: re-arm running ones, deliver parked notifications. */
	adopt(sessionId: string, sessionDir: string): void {
		const path = registryFile(sessionDir, sessionId);
		if (!existsSync(path)) return;
		const records = readRegistry(path);
		for (const record of records) {
			if (this.tasks.has(record.taskId)) continue;
			const tracked: TrackedTask = { record, registryPath: path };
			this.tasks.set(record.taskId, tracked);
			if (record.status === 'running') {
				if (record.pid && isPidAlive(record.pid)) {
					tracked.pollTimer = setInterval(() => {
						if (!isPidAlive(record.pid)) void this.settle(record.taskId, null, { offline: true });
					}, this.timing.adoptPollMs);
					tracked.pollTimer.unref?.();
				} else {
					void this.settle(record.taskId, null, { offline: true });
				}
			} else if (!record.delivered) {
				// Finished while the session was away: deliver now that hooks exist.
				this.scheduleDelivery(record.taskId, 1000);
			}
		}
	}

	/** Drop finished, delivered records older than a day, with their log files (called on adopt). */
	prune(sessionId: string, sessionDir: string): void {
		const path = registryFile(sessionDir, sessionId);
		if (!existsSync(path)) return;
		const cutoff = Date.now() - 24 * 60 * 60 * 1000;
		const kept: BackgroundTaskRecord[] = [];
		for (const record of readRegistry(path)) {
			if (record.status === 'running' || !record.delivered || (record.endedAt ?? 0) >= cutoff) kept.push(record);
			else {
				removeTaskLog(path, record);
				const tracked = this.tasks.get(record.taskId);
				if (tracked?.record.delivered) this.tasks.delete(record.taskId);
			}
		}
		writeRegistry(path, kept);
	}

	/** Kill a running task's process tree (user or model stop). Returns false when not running. */
	stop(taskId: string): boolean {
		const tracked = this.tasks.get(taskId);
		if (!tracked || tracked.record.status !== 'running') return false;
		try {
			if (process.platform === 'win32') {
				const child = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/F', '/T', '/PID', String(tracked.record.pid)], { stdio: 'ignore', detached: true, windowsHide: true });
				child.once('error', () => { });
			} else {
				try { process.kill(-tracked.record.pid, 'SIGKILL'); } catch { try { process.kill(tracked.record.pid, 'SIGKILL'); } catch { /* already gone */ } }
			}
		} catch {
			// settle will arrive via the exit event / pid poll.
		}
		return true;
	}

	currentRecords(sessionId: string): BackgroundTaskRecord[] {
		return [...this.tasks.values()].filter((task) => task.record.sessionId === sessionId).map((task) => ({ ...task.record }));
	}

	/** Test/teardown helper: clear all timers and in-memory state. */
	clear(): void {
		for (const tracked of this.tasks.values()) {
			if (tracked.pollTimer) clearInterval(tracked.pollTimer);
			if (tracked.deliverTimer) clearTimeout(tracked.deliverTimer);
		}
		this.tasks.clear();
		this.hooks.clear();
		this.wakeChain.clear();
	}

	private persist(tracked: TrackedTask): void {
		// 只去重同 taskId 的旧记录，其他 running/未投递记录必须保留。
		const records = readRegistry(tracked.registryPath).filter((record) => record.taskId !== tracked.record.taskId);
		records.push({ ...tracked.record });
		// 超额时优先淘汰最早的历史记录（running/未投递的永不淘汰）。
		while (records.length > 30) {
			const index = records.findIndex((record) => record.status !== 'running' && record.delivered && record.taskId !== tracked.record.taskId);
			if (index === -1) break;
			const [removed] = records.splice(index, 1);
			removeTaskLog(tracked.registryPath, removed);
		}
		writeRegistry(tracked.registryPath, records);
	}

	/**
	 * Deliver the completion notification as a synthetic prompt. Retries while
	 * the session is busy; parks as pending (delivered=false) once the chain
	 * guard trips or the retry budget is exhausted.
	 */
	private scheduleDelivery(taskId: string, delayMs: number): void {
		const tracked = this.tasks.get(taskId);
		if (!tracked || tracked.record.delivered) return;
		if (tracked.deliverTimer) clearTimeout(tracked.deliverTimer);
		tracked.deliverStartedAt ??= Date.now();
		tracked.deliverTimer = setTimeout(() => { void this.deliver(taskId); }, delayMs);
	}

	private async deliver(taskId: string): Promise<void> {
		const tracked = this.tasks.get(taskId);
		if (!tracked || tracked.record.delivered) return;
		const { record } = tracked;
		const hooks = this.hooks.get(record.sessionId);
		if (!hooks) return; // Session not loaded: stay pending in the registry.
		const chain = this.wakeChain.get(record.sessionId) ?? 0;
		if (chain >= MAX_AUTO_WAKE_CHAIN) {
			hooks.notify('warning', `后台任务 ${record.taskId} 已结束，但连续自动唤醒次数达到上限（${chain}），等待用户下次发消息后再投递结果。`);
			return;
		}
		if ((Date.now() - (tracked.deliverStartedAt ?? Date.now())) > this.timing.deliverBudgetMs) {
			hooks.notify('warning', `后台任务 ${record.taskId} 的结果长时间无法投递，已保留，用户下次发消息时会自动补投。`);
			return;
		}
		if (hooks.isIdle()) {
			try {
				const tail = readTail(record.logFile, WAKE_OUTPUT_TAIL_CHARS);
				await hooks.prompt(buildWakeMessage(record, tail));
				// 只有真正唤醒成功才计入连续唤醒链；失败的尝试不消耗守卫额度。
				this.wakeChain.set(record.sessionId, (this.wakeChain.get(record.sessionId) ?? 0) + 1);
				tracked.promptFailures = 0;
				record.delivered = true;
				this.persist(tracked);
				return;
			} catch (error) {
				tracked.promptFailures = (tracked.promptFailures ?? 0) + 1;
				if (tracked.promptFailures >= MAX_PROMPT_FAILURES) {
					const reason = error instanceof Error ? error.message : String(error);
					hooks.notify('warning', `后台任务 ${record.taskId} 的结果投递连续失败（${reason}），已保留，用户下次发消息时会自动补投。`);
					return;
				}
			}
		}
		// Busy or transient prompt failure: back off and retry.
		tracked.deliverAttempts = (tracked.deliverAttempts ?? 0) + 1;
		const backoff = Math.min(this.timing.retryMaxMs, this.timing.retryFirstMs * Math.pow(1.5, Math.min(tracked.deliverAttempts, 6)));
		this.scheduleDelivery(taskId, backoff);
	}
}

/** Process-wide manager singleton, mirroring shellRunRegistry's pattern. */
export const backgroundTaskManager = new BackgroundTaskManager();

export const BackgroundTaskParameters = Type.Object({
	command: Type.String({ description: '要后台运行的 shell 命令（与 bash 工具相同的 shell 语义）。启动后立即返回，不阻塞当前轮次。' }),
	note: Type.Optional(Type.String({ description: '这条后台任务的用途说明（可选），会出现在完成通知里。' })),
});

export type BackgroundTaskToolInput = Static<typeof BackgroundTaskParameters>;

/**
 * Build the `run_in_background` tool. Shell resolution mirrors the desktop's
 * interruptible shell tools so command semantics match `bash`.
 */
export function createBackgroundTaskTool(
	manager: BackgroundTaskManager,
	resolveShell: () => { shell: string; args: string[]; commandTransport?: 'argv' | 'stdin' } | null,
	/** Configured shell command prefix (same setting the interruptible bash tool applies), read at execution time. */
	resolveCommandPrefix: () => string | undefined | null = () => undefined,
): ToolDefinition {
	const killHint = (pid: number) => process.platform === 'win32' ? `taskkill /F /T /PID ${pid}` : `kill -- -${pid}`;
	return {
		name: 'run_in_background',
		label: '后台运行命令',
		description:
			'在后台运行一条长耗时的 shell 命令（构建、测试、下载、训练、watch 等）：立即返回任务句柄，不占用当前对话轮次；'
			+ '命令结束（无论成败）后会自动向对话注入一条带退出码与输出末尾的通知，并自动唤醒助手继续后续工作。'
			+ '返回结果包含 taskId、pid 与日志文件路径：可随时用 read 工具查看日志进度，用 bash 终止整个进程树（Windows: taskkill /F /T /PID <pid>；macOS/Linux: kill -- -<pid>）。'
			+ '任务进程独立于本应用存活，应用重启后也会在下次打开会话时结算并通知。不要用它运行需要交互输入的命令。',
		promptSnippet: 'run_in_background(command): run a long shell command detached from the turn; on exit its result and output tail are auto-delivered back into the conversation and the assistant resumes.',
		promptGuidelines: [
			'长耗时且无需盯守的命令（完整构建、大批量测试、训练、下载）优先用 run_in_background 而不是 bash：它会立刻返回，结束后结果会自动回灌并唤醒你继续。',
		],
		parameters: BackgroundTaskParameters,
		annotations: { openWorldHint: false },
		executionMode: 'sequential',
		execute: async (_toolCallId: string, params: BackgroundTaskToolInput, _signal: AbortSignal | undefined, _onUpdate: never, ctx: Parameters<ToolDefinition['execute']>[4]) => {
			const command = typeof params?.command === 'string' ? params.command.trim() : '';
			if (!command) throw new Error('command 不能为空');
			if (command.length > 8000) throw new Error('command 过长（>8000 字符）');
			const shell = resolveShell();
			if (!shell) throw new Error('后台任务不可用：无法解析 shell 配置');
			if (shell.commandTransport === 'stdin') throw new Error('后台任务不支持 stdin 传输型 shell 配置，请在设置中改用 argv 型 shell');
			const sessionManager = ctx?.sessionManager;
			const sessionId = sessionManager?.getSessionId?.();
			const sessionDir = sessionManager?.getSessionDir?.();
			const cwd = ctx?.cwd ?? process.cwd();
			if (!sessionId || !sessionDir) throw new Error('后台任务需要会话上下文');
			if (manager.runningCount(sessionId) >= MAX_BACKGROUND_TASKS_PER_SESSION) {
				throw new Error(`本会话后台任务已达上限（${MAX_BACKGROUND_TASKS_PER_SESSION}），请先等待或终止现有任务`);
			}
			// 与可中断 bash 工具一致：在执行时拼接设置里的命令前缀（编码/环境初始化等）；记录里保留原始命令。
			const prefix = resolveCommandPrefix();
			const resolvedCommand = prefix ? `${prefix}\n${command}` : command;
			const record = manager.start(
				{ sessionId, sessionDir, cwd, command, note: typeof params.note === 'string' && params.note.trim() ? params.note.trim() : undefined },
				(logFile) => {
					const fd = openSync(logFile, 'a');
					try {
						const child = spawn(shell.shell, [...shell.args, resolvedCommand], {
							cwd, detached: true, stdio: ['ignore', fd, fd], windowsHide: true,
						});
						// 启动错误由 manager 的 error 监听结算；这里只防止未处理的 error 事件。
						child.once('error', () => { });
						child.unref();
						return { child, pid: child.pid ?? -1 };
					} finally {
						closeSync(fd);
					}
				},
			);
			return {
				content: [{
					type: 'text',
					text: `后台任务已启动：taskId=${record.taskId}，pid=${record.pid}，日志=${record.logFile}。\n`
						+ `命令不会阻塞本轮对话；结束后我会自动收到通知（含退出码与输出末尾）并继续。`
						+ `期间可用 read 查看日志进度；需要终止时用 bash 执行 ${killHint(record.pid)}（终止整个进程树）。`,
				}],
				details: undefined,
			};
		},
	} as ToolDefinition;
}
