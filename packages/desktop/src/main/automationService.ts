import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { UiAutomation, UiAutomationInput, UiAutomationRun, UiAutomationSnapshot, UiThinkingLevel } from '@pidesktop/shared';
import { nextAutomationRun, validateAutomationSchedule, validateAutomationTimeZone } from './automationSchedule';
import { readStateFileAsync, writeStateFileAsync } from './stateFiles';

const MAX_TASKS = 100;
const MAX_RUNS = 200;
const MAX_CONCURRENT = 2;
const THINKING_LEVELS: UiThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export interface AutomationExecutionResult {
  sessionId: string | null;
  sessionPath: string | null;
  summary: string;
  error?: string;
}

export interface AutomationServiceOptions {
  filePath: string;
  execute: (automation: UiAutomation, signal: AbortSignal, dispatch?: (phase: 'dispatching' | 'accepted') => Promise<void>) => Promise<AutomationExecutionResult>;
  validateWorkspace?: (cwd: string) => Promise<void>;
  onChanged?: (snapshot: UiAutomationSnapshot) => void;
  /** Fired once a run settles (succeeded/failed/cancelled); used for OS notifications (4.1). */
  onRunFinished?: (entry: UiAutomationRun, task: UiAutomation) => void;
  onError?: (error: unknown) => void;
  now?: () => number;
  pollIntervalMs?: number;
  /** Defer dispatch for maintenance or a worker that could not be shut down. */
  canRun?: () => boolean | string;
}

interface StoredState extends UiAutomationSnapshot { version: 1 }
interface ActiveRun { controller: AbortController; done: Promise<void>; retryAllowed: boolean }
interface PendingRunCompletion {
  run: UiAutomationRun;
  restoreSchedule?: {
    expected: UiAutomation;
    previous: Pick<UiAutomation, 'lastRunAt' | 'nextRunAt' | 'enabled'>;
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`${label}无效`);
  return value.trim();
}

function id(value: unknown): string { return boundedString(value, '任务标识', 128); }
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}
function nullableTimestamp(value: unknown): value is string | null { return value === null || timestamp(value); }
function nullableString(value: unknown, max: number): value is string | null { return value === null || (typeof value === 'string' && value.length <= max); }

function normalizeInput(value: unknown): UiAutomationInput {
  if (!object(value)) throw new Error('自动化任务格式无效');
  const cwd = boundedString(value.cwd, '项目目录', 32_768);
  if (!isAbsolute(cwd)) throw new Error('项目目录必须为绝对路径');
  let model: UiAutomationInput['model'] = null;
  if (value.model !== null) {
    if (!object(value.model)) throw new Error('模型配置无效');
    model = { provider: boundedString(value.model.provider, '模型提供方', 200), id: boundedString(value.model.id, '模型', 200) };
  }
  if (value.thinkingLevel !== null && !THINKING_LEVELS.includes(value.thinkingLevel as UiThinkingLevel)) throw new Error('思考强度无效');
  if (typeof value.enabled !== 'boolean') throw new Error('任务启用状态无效');
  for (const [key, maximum] of [['misfireGraceMinutes', 525600], ['maxScheduledRuns', 100000], ['dispatchRetryLimit', 5]] as const) {
    const number = value[key];
    if (number !== undefined && number !== null && (!Number.isInteger(number) || (number as number) < (key === 'dispatchRetryLimit' ? 0 : 1) || (number as number) > maximum)) throw new Error(`${key}无效`);
  }
  return {
    ...(value.id === undefined ? {} : { id: id(value.id) }),
    name: boundedString(value.name, '任务名称', 120),
    prompt: boundedString(value.prompt, '任务指令', 32_000), cwd, model,
    thinkingLevel: value.thinkingLevel as UiThinkingLevel | null,
    schedule: validateAutomationSchedule(value.schedule), timeZone: validateAutomationTimeZone(value.timeZone), enabled: value.enabled,
    ...(value.misfireGraceMinutes === undefined ? {} : { misfireGraceMinutes: value.misfireGraceMinutes as number | null }),
    ...(value.maxScheduledRuns === undefined ? {} : { maxScheduledRuns: value.maxScheduledRuns as number | null }),
    ...(value.dispatchRetryLimit === undefined ? {} : { dispatchRetryLimit: value.dispatchRetryLimit as number }),
  };
}

function validState(value: unknown): value is StoredState {
  if (!object(value) || value.version !== 1 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || !Array.isArray(value.automations) || value.automations.length > MAX_TASKS
    || !Array.isArray(value.runs) || value.runs.length > MAX_RUNS) return false;
  try {
    const taskIds = new Set<string>();
    for (const task of value.automations) {
      if (!object(task)) return false;
      normalizeInput(task);
      const taskId = id(task.id);
      if (taskIds.has(taskId) || !timestamp(task.createdAt) || !timestamp(task.updatedAt)
        || (task.scheduledRunCount !== undefined && (!Number.isSafeInteger(task.scheduledRunCount) || (task.scheduledRunCount as number) < 0))
        || (task.completedAt !== undefined && !nullableTimestamp(task.completedAt))
        || !nullableTimestamp(task.nextRunAt) || !nullableTimestamp(task.lastRunAt)
        || (task.enabled && !task.nextRunAt) || (!task.enabled && task.nextRunAt !== null)) return false;
      taskIds.add(taskId);
    }
    const runIds = new Set<string>();
    for (const run of value.runs) {
      if (!object(run)) return false;
      const runId = id(run.id);
      if (runIds.has(runId)) return false;
      runIds.add(runId);
      id(run.automationId);
      boundedString(run.name, '任务名称', 120);
      if (!isAbsolute(boundedString(run.cwd, '项目目录', 32_768)) || !['manual', 'schedule'].includes(run.trigger as string)
        || !['running', 'retrying', 'skipped', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status as string)
        || !timestamp(run.startedAt) || !nullableTimestamp(run.finishedAt)
        || !nullableString(run.sessionId, 512) || !nullableString(run.sessionPath, 32_768)
        || typeof run.summary !== 'string' || run.summary.length > 4_000 || !nullableString(run.error, 4_000)
        || (run.status === 'running' || run.status === 'retrying' ? run.finishedAt !== null : run.finishedAt === null)
        || (run.attempts !== undefined && (!Number.isSafeInteger(run.attempts) || (run.attempts as number) < 1 || (run.attempts as number) > 6))
        || (run.retryAt !== undefined && !nullableTimestamp(run.retryAt))) return false;
      if (run.status === 'retrying' && (!timestamp(run.retryAt) || run.dispatchState !== 'not-started')) return false;
      if (run.dispatchState !== undefined && !['not-started', 'dispatching', 'accepted'].includes(run.dispatchState as string)) return false;
      if (run.counted !== undefined && typeof run.counted !== 'boolean') return false;
      if (run.scheduledAt !== undefined && !timestamp(run.scheduledAt)) return false;
    }
  } catch { return false; }
  return true;
}

const emptyState = (): StoredState => ({ version: 1, revision: 0, automations: [], runs: [] });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 4_000);

export class AutomationService {
  private state = emptyState();
  private initialization: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private starting: Promise<void> | null = null;
  private active = new Map<string, ActiveRun>();
  private pendingFinished = new Map<string, PendingRunCompletion>();
  private storageError: string | null = null;
  private notificationRevision = 0;
  private closing = false;
  private disposal: Promise<void> | null = null;
  private readonly options: AutomationServiceOptions;

  constructor(options: AutomationServiceOptions) { this.options = options; }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private copy(): UiAutomationSnapshot {
    return structuredClone({ revision: this.notificationRevision, automations: this.state.automations, runs: this.state.runs,
      ...(this.storageError ? { error: this.storageError } : {}) });
  }
  private report(error: unknown): void {
    try { this.options.onError?.(error); } catch { /* Error reporting must not interrupt shutdown. */ }
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private ensureOpen(): void { if (this.closing) throw new Error('自动化服务正在关闭'); }
  private notify(): void {
    try { this.options.onChanged?.(this.copy()); } catch (error) { this.report(error); }
  }
  private async commit(next: StoredState): Promise<void> {
    // Carry previously completed but unwritten runs into the next successful write.
    // Until then the durable snapshot retains "running" and exposes the write error.
    for (const [runId, completion] of this.pendingFinished) {
      const index = next.runs.findIndex((run) => run.id === runId);
      if (index >= 0) {
        const needsCount = completion.run.counted && !next.runs[index].counted;
        next.runs[index] = structuredClone(completion.run);
        if (needsCount) { next.runs[index].counted = false; this.countScheduled(next, next.runs[index]); }
      }
      const restore = completion.restoreSchedule;
      if (restore) {
        const task = next.automations.find((item) => item.id === restore.expected.id);
        // Preserve both parts of a deferred completion across failed writes,
        // while allowing any later user edit to supersede schedule recovery.
        if (task && JSON.stringify(task) === JSON.stringify(restore.expected)) Object.assign(task, restore.previous);
      }
    }
    next.revision = this.notificationRevision + 1;
    try { await writeStateFileAsync(this.options.filePath, next); }
    catch (error) {
      this.storageError = `自动化状态保存失败，任务不会重复执行；应用将自动重试。${message(error)}`;
      this.notificationRevision++;
      this.notify();
      throw error;
    }
    this.state = next;
    this.notificationRevision = next.revision;
    this.pendingFinished.clear();
    this.storageError = null;
    this.notify();
  }

  async initialize(): Promise<UiAutomationSnapshot> {
    if (!this.initialization) {
      this.initialization = (async () => {
        const loaded = await readStateFileAsync(this.options.filePath, emptyState, validState);
        this.state = loaded;
        this.notificationRevision = loaded.revision;
        if (loaded.runs.some((run) => run.status === 'running')) {
          const next = structuredClone(loaded);
          for (const run of next.runs) if (run.status === 'running') {
            if (run.dispatchState !== 'not-started') this.countScheduled(next, run);
            run.status = 'interrupted'; run.finishedAt = new Date(this.now()).toISOString();
            run.error = '应用退出时任务尚未完成，请手动重新运行';
          }
          await this.commit(next);
        }
      })();
    }
    await this.initialization;
    return this.copy();
  }

  start(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('自动化服务正在关闭'));
    if (!this.starting) {
      const starting = (async () => {
        await this.initialize();
        this.ensureOpen();
        if (!this.timer) {
          this.timer = setInterval(() => { void this.tick().catch((error) => this.report(error)); }, this.options.pollIntervalMs ?? 15_000);
          this.timer.unref?.();
        }
        // Keep polling after a transient first-write error, while still reporting
        // that initial error to the caller. An unreadable store never gets here.
        await this.tick();
      })();
      this.starting = starting;
      void starting.catch(() => { if (this.starting === starting) this.starting = null; });
    }
    return this.starting;
  }

  async snapshot(): Promise<UiAutomationSnapshot> {
    await this.initialize();
    return this.serialize(async () => this.copy());
  }

  async hasActiveRuns(): Promise<boolean> {
    // A corrupt store cannot start workers; it must not block unrelated plugin
    // management. Waiting for the queue also covers an in-flight durable claim.
    await this.initialization?.catch(() => undefined);
    return this.serialize(async () => this.active.size > 0);
  }

  async save(value: UiAutomationInput): Promise<UiAutomationSnapshot> {
    await this.initialize();
    return this.serialize(async () => {
      this.ensureOpen();
      const input = normalizeInput(value);
      await this.options.validateWorkspace?.(input.cwd);
      const previous = input.id ? this.state.automations.find((task) => task.id === input.id) : undefined;
      if (input.id && !previous) throw new Error('自动化任务不存在');
      if (!previous && this.state.automations.length >= MAX_TASKS) throw new Error('最多可保存 100 个自动化任务');
      const now = this.now();
      if (input.enabled && input.schedule.kind === 'once' && Date.parse(input.schedule.at) <= now) throw new Error('执行日期必须晚于当前时间');
      const sameSchedule = previous && previous.enabled === input.enabled && previous.timeZone === input.timeZone
        && JSON.stringify(previous.schedule) === JSON.stringify(input.schedule);
      const task: UiAutomation = {
        ...input, id: previous?.id ?? randomUUID(), createdAt: previous?.createdAt ?? new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(), lastRunAt: previous?.lastRunAt ?? null,
        ...(previous?.scheduledRunCount !== undefined ? { scheduledRunCount: previous.scheduledRunCount } : {}),
        nextRunAt: input.enabled ? (sameSchedule ? previous.nextRunAt : nextAutomationRun(input.schedule, input.timeZone, now)) : null,
      };
      if (task.maxScheduledRuns && (task.scheduledRunCount ?? 0) >= task.maxScheduledRuns) { task.enabled = false; task.nextRunAt = null; task.completedAt = previous?.completedAt ?? new Date(now).toISOString(); }
      else if (task.enabled && !task.nextRunAt) task.nextRunAt = nextAutomationRun(input.schedule, input.timeZone, now);
      const next = structuredClone(this.state);
      if (previous) next.automations[next.automations.findIndex((item) => item.id === task.id)] = task;
      else next.automations.push(task);
      if (!task.enabled) this.cancelDeferred(next, task.id);
      await this.commit(next);
      if (!task.enabled) this.suppressActiveRetries(task.id);
      return this.copy();
    });
  }

  async setEnabled(taskId: string, enabled: boolean): Promise<UiAutomationSnapshot> {
    await this.initialize();
    return this.serialize(async () => {
      this.ensureOpen(); id(taskId);
      if (typeof enabled !== 'boolean') throw new Error('任务启用状态无效');
      const next = structuredClone(this.state);
      const task = next.automations.find((item) => item.id === taskId);
      if (!task) throw new Error('自动化任务不存在');
      const cancelledRetry = !enabled && this.cancelDeferred(next, taskId);
      if (enabled && task.maxScheduledRuns && (task.scheduledRunCount ?? 0) >= task.maxScheduledRuns) throw new Error('执行次数已用完，请先提高次数上限');
      if (task.enabled === enabled) {
        let cancelledRecovery = false;
        for (const completion of this.pendingFinished.values()) {
          if (completion.restoreSchedule?.expected.id === taskId && completion.restoreSchedule.previous.enabled !== enabled) {
            delete completion.restoreSchedule;
            cancelledRecovery = true;
          }
        }
        // An explicit disable still matters when a one-shot claim already set
        // enabled=false but its unwritten completion would otherwise re-enable it.
        if (cancelledRecovery || cancelledRetry) await this.commit(next);
        if (!enabled) this.suppressActiveRetries(taskId);
        return this.copy();
      }
      if (enabled) await this.options.validateWorkspace?.(task.cwd);
      task.nextRunAt = enabled ? nextAutomationRun(task.schedule, task.timeZone, this.now()) : null;
      if (enabled && !task.nextRunAt) throw new Error('执行日期已过，请先编辑任务');
      task.enabled = enabled; task.updatedAt = new Date(this.now()).toISOString();
      await this.commit(next);
      if (!enabled) this.suppressActiveRetries(taskId);
      return this.copy();
    });
  }

  async delete(taskId: string): Promise<UiAutomationSnapshot> {
    await this.initialize();
    return this.serialize(async () => {
      this.ensureOpen(); id(taskId);
      if (this.state.runs.some((run) => run.automationId === taskId && (run.status === 'running' || run.status === 'retrying'))) throw new Error('请先停止正在运行或等待重试的任务');
      if (!this.state.automations.some((task) => task.id === taskId)) throw new Error('自动化任务不存在');
      const next = structuredClone(this.state);
      next.automations = next.automations.filter((task) => task.id !== taskId);
      await this.commit(next);
      return this.copy();
    });
  }

  async run(taskId: string): Promise<UiAutomationSnapshot> {
    await this.initialize();
    return this.serialize(async () => {
      this.ensureOpen(); id(taskId);
      const blocker = this.dispatchBlocker();
      if (blocker) throw new Error(blocker);
      const task = this.state.automations.find((item) => item.id === taskId);
      if (!task) throw new Error('自动化任务不存在');
      await this.claim(task, 'manual');
      return this.copy();
    });
  }

  private dispatchBlocker(): string | null {
    const permission = this.options.canRun?.();
    if (typeof permission === 'string') return permission || '自动化暂时无法运行，请稍后再试';
    return permission === false ? '插件正在更新，请完成后再运行自动化' : null;
  }

  private countScheduled(state: StoredState, run: UiAutomationRun): void {
    if (run.trigger !== 'schedule' || run.counted) return;
    run.counted = true;
    const task = state.automations.find(item => item.id === run.automationId);
    if (!task) return;
    task.scheduledRunCount = (task.scheduledRunCount ?? 0) + 1;
    if (task.maxScheduledRuns && task.scheduledRunCount >= task.maxScheduledRuns) {
      task.enabled = false; task.nextRunAt = null; task.completedAt = new Date(this.now()).toISOString();
    }
  }

  private cancelDeferred(state: StoredState, taskId: string): boolean {
    let changed = false;
    const pending = [...this.pendingFinished.values()].map(item => item.run);
    for (const run of [...state.runs, ...pending]) if (run.automationId === taskId && run.status === 'retrying') {
      run.status = 'cancelled'; run.finishedAt = new Date(this.now()).toISOString(); run.retryAt = null;
      run.error = '任务已停用，派发重试已取消'; changed = true;
    }
    return changed;
  }

  private suppressActiveRetries(taskId: string): void {
    // Pausing must not abort work already sent to the model, but it must also
    // prevent a still-running setup phase from scheduling a later retry.
    for (const run of this.state.runs) if (run.automationId === taskId) {
      const active = this.active.get(run.id); if (active) active.retryAllowed = false;
    }
  }

  private async claim(task: UiAutomation, trigger: UiAutomationRun['trigger'], retry?: UiAutomationRun): Promise<void> {
    if (this.active.size >= MAX_CONCURRENT) throw new Error('已有 2 个自动化正在运行，请稍后重试');
    if (this.state.runs.some((run) => run.automationId === task.id && (run.status === 'running' || run.status === 'retrying') && run.id !== retry?.id)) throw new Error('此自动化已在运行');
    const now = this.now();
    const next = structuredClone(this.state);
    const storedTask = next.automations.find((item) => item.id === task.id)!;
    storedTask.lastRunAt = new Date(now).toISOString();
    if (trigger === 'schedule' && !retry) {
      storedTask.nextRunAt = nextAutomationRun(task.schedule, task.timeZone, now);
      if (task.schedule.kind === 'once') { storedTask.enabled = false; storedTask.nextRunAt = null; }
    }
    const run: UiAutomationRun = retry ? { ...retry, status: 'running', retryAt: null, attempts: (retry.attempts ?? 1) + 1, error: null } : {
      id: randomUUID(), automationId: task.id, name: task.name, cwd: task.cwd, trigger, status: 'running',
      startedAt: new Date(now).toISOString(), finishedAt: null, sessionId: null, sessionPath: null, summary: '', error: null,
      attempts: 1, dispatchState: 'not-started', ...(trigger === 'schedule' && task.nextRunAt ? { scheduledAt: task.nextRunAt } : {}),
    };
    if (retry) next.runs[next.runs.findIndex(item => item.id === retry.id)] = run;
    else next.runs.unshift(run);
    // The newest running entries are always retained; only completed old history is evicted.
    while (next.runs.length > MAX_RUNS) {
      const lastFinished = next.runs.findLastIndex((entry) => entry.status !== 'running' && entry.status !== 'retrying');
      if (lastFinished < 0) throw new Error('运行历史已满');
      next.runs.splice(lastFinished, 1);
    }
    // Claiming and advancing the schedule are durable before any model is called.
    await this.commit(next);
    const controller = new AbortController();
    const done = Promise.resolve().then(async () => {
      let result: Partial<AutomationExecutionResult> = {};
      let error: string | null = null;
      let dispatchDeferred = false;
      let retryable = false;
      try {
        await this.options.validateWorkspace?.(task.cwd);
        const blocker = this.dispatchBlocker();
        if (blocker && !controller.signal.aborted) {
          dispatchDeferred = true;
          throw new Error(blocker);
        }
        if (!controller.signal.aborted) result = await this.options.execute(structuredClone(task), controller.signal, phase => this.serialize(async () => {
          const next = structuredClone(this.state), entry = next.runs.find(item => item.id === run.id)!;
          entry.dispatchState = phase;
          if (phase === 'accepted') this.countScheduled(next, entry);
          await this.commit(next);
        }));
        if (result.error) error = result.error.slice(0, 4_000);
      } catch (caught) {
        error = message(caught);
        retryable = object(caught) && caught.retryableDispatch === true && caught.executionStarted === false;
        if (object(caught)) result = caught as Partial<AutomationExecutionResult>;
      }
      let finishedEntry: UiAutomationRun | null = null;
      await this.serialize(async () => {
        const finished = structuredClone(this.state);
        const entry = finished.runs.find((item) => item.id === run.id)!;
        const shouldRetry = retryable && this.active.get(run.id)?.retryAllowed !== false && entry.dispatchState === 'not-started' && !controller.signal.aborted && (entry.attempts ?? 1) <= (task.dispatchRetryLimit ?? 2);
        if (shouldRetry) {
          entry.status = 'retrying'; entry.error = error; entry.retryAt = new Date(this.now() + Math.min(300000, 5000 * 2 ** ((entry.attempts ?? 1) - 1))).toISOString();
          this.pendingFinished.set(entry.id, { run: structuredClone(entry) });
          await this.commit(finished); return;
        }
        if (entry.dispatchState === 'dispatching' || entry.dispatchState === 'accepted'
          || (!dispatchDeferred && !retryable && !controller.signal.aborted && !error)) this.countScheduled(finished, entry);
        entry.status = controller.signal.aborted ? 'cancelled' : error ? 'failed' : 'succeeded';
        entry.finishedAt = new Date(this.now()).toISOString();
        entry.error = error;
        entry.summary = typeof result.summary === 'string' ? result.summary.slice(0, 4_000) : '';
        entry.sessionId = typeof result.sessionId === 'string' ? result.sessionId.slice(0, 512) : null;
        entry.sessionPath = typeof result.sessionPath === 'string' ? result.sessionPath.slice(0, 32_768) : null;
        this.pendingFinished.set(entry.id, {
          run: structuredClone(entry),
          ...(dispatchDeferred && trigger === 'schedule' && !controller.signal.aborted ? {
            restoreSchedule: {
              expected: structuredClone(storedTask),
              previous: { lastRunAt: task.lastRunAt, nextRunAt: task.nextRunAt, enabled: task.enabled },
            },
          } : {}),
        });
        await this.commit(finished);
        finishedEntry = structuredClone(entry);
      });
      if (finishedEntry) { try { this.options.onRunFinished?.(finishedEntry, task); } catch { /* notifications must never break runs */ } }
    }).finally(() => { this.active.delete(run.id); });
    this.active.set(run.id, { controller, done, retryAllowed: true });
    void done.catch((error) => this.report(error));
  }

  async cancelRun(runId: string): Promise<UiAutomationSnapshot> {
    await this.initialize();
    const active = await this.serialize(async () => {
      this.ensureOpen(); id(runId);
      const run = this.state.runs.find((item) => item.id === runId);
      if (!run) throw new Error('运行记录不存在');
      const running = this.active.get(runId);
      const pendingRetry = this.pendingFinished.get(runId)?.run;
      if (run.status === 'retrying' || pendingRetry?.status === 'retrying') {
        const next = structuredClone(this.state), entry = structuredClone(pendingRetry ?? run);
        entry.status = 'cancelled'; entry.finishedAt = new Date(this.now()).toISOString(); entry.retryAt = null;
        next.runs[next.runs.findIndex(item => item.id === runId)] = entry;
        this.pendingFinished.set(runId, { run: structuredClone(entry) });
        await this.commit(next);
        return undefined;
      }
      if (run.status === 'running' && !running) throw new Error('任务运行状态异常，请重启应用后重试');
      running?.controller.abort();
      return running;
    });
    await active?.done;
    return this.snapshot();
  }

  async tick(): Promise<void> {
    await this.initialize();
    await this.serialize(async () => {
      if (this.closing) return;
      // Never launch another worker while the previous completion is still unwritten.
      if (this.pendingFinished.size || this.storageError) await this.commit(structuredClone(this.state));
      if (this.dispatchBlocker()) return;
      for (const run of this.state.runs.filter(item => item.status === 'retrying' && item.retryAt && Date.parse(item.retryAt) <= this.now())) {
        if (this.active.size >= MAX_CONCURRENT) break;
        const task = this.state.automations.find(item => item.id === run.automationId);
        if (task) await this.claim(task, run.trigger, run);
      }
      const due = this.state.automations.filter((task) => task.enabled && task.nextRunAt && Date.parse(task.nextRunAt) <= this.now())
        .sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!));
      for (const task of due) {
        if (this.dispatchBlocker()) break;
        if (this.active.size >= MAX_CONCURRENT) break;
        if (this.state.runs.some((run) => run.automationId === task.id && (run.status === 'running' || run.status === 'retrying'))) continue;
        if (task.misfireGraceMinutes && this.now() - Date.parse(task.nextRunAt!) > task.misfireGraceMinutes * 60000) {
          const next = structuredClone(this.state), stored = next.automations.find(item => item.id === task.id)!;
          const timestamp = new Date(this.now()).toISOString();
          next.runs.unshift({ id: randomUUID(), automationId: task.id, name: task.name, cwd: task.cwd, trigger: 'schedule', status: 'skipped', startedAt: timestamp, finishedAt: timestamp, scheduledAt: task.nextRunAt!, sessionId: null, sessionPath: null, summary: '超过补跑宽限，已跳过', error: null });
          while (next.runs.length > MAX_RUNS) {
            const lastFinished = next.runs.findLastIndex(entry => entry.status !== 'running' && entry.status !== 'retrying');
            next.runs.splice(lastFinished, 1);
          }
          stored.nextRunAt = nextAutomationRun(task.schedule, task.timeZone, this.now());
          if (task.schedule.kind === 'once') { stored.enabled = false; stored.completedAt = timestamp; }
          await this.commit(next); continue;
        }
        await this.claim(task, 'schedule');
      }
    });
  }

  dispose(): Promise<void> {
    if (!this.disposal) this.disposal = (async () => {
      this.closing = true;
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      if (!this.initialization) return;
      // An unreadable store never started workers and must remain untouched.
      try { await this.initialization; } catch { return; }
      await this.queue;
      const running = [...this.active.values()];
      for (const run of running) run.controller.abort();
      const results = await Promise.allSettled(running.map((run) => run.done));
      await this.queue;
      if (this.pendingFinished.size || this.storageError) await this.serialize(() => this.commit(structuredClone(this.state)));
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    })();
    return this.disposal;
  }
}

export function createAutomationService(options: AutomationServiceOptions): AutomationService {
  return new AutomationService(options);
}
