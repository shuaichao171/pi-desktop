import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './agentClient' && context.parentURL?.endsWith('/automationExecutor.ts')) {
      return { url: 'data:text/javascript,export const createIsolatedAgentService=()=>{throw new Error("Unexpected live worker")}', shortCircuit: true };
    }
    if (specifier.startsWith('./') && context.parentURL && new URL(context.parentURL).pathname.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});
const { createAutomationService } = await import('../packages/desktop/src/main/automationService.ts');
const { nextAutomationRun, validateAutomationSchedule } = await import('../packages/desktop/src/main/automationSchedule.ts');

test('grace expiry skips one occurrence, preserves quota and completes expired one-shots', async t => {
  const f = await fixture(t);
  await f.service.save(f.input({ misfireGraceMinutes: 10, maxScheduledRuns: 3 }));
  await f.service.save(f.input({ name: 'one shot', schedule: { kind: 'once', at: new Date(f.now() + 60000).toISOString() }, misfireGraceMinutes: 1 }));
  f.advance(86400000);
  await Promise.all([f.service.tick(), f.service.tick()]);
  const state = await f.service.snapshot();
  assert.equal(f.calls.length, 0);
  assert.equal(state.runs.length, 2);
  assert.ok(state.runs.every(r => r.status === 'skipped' && r.scheduledAt));
  assert.equal(state.automations[0].scheduledRunCount ?? 0, 0);
  assert.ok(Date.parse(state.automations[0].nextRunAt) > f.now());
  assert.equal(state.automations[1].enabled, false);
  assert.ok(state.automations[1].completedAt);
});

test('pre-dispatch retry keeps occurrence identity and durable backoff across restart', async t => {
  let attempts = 0;
  const f = await fixture(t, { execute: async (_task, _signal, dispatch) => {
    if (++attempts === 1) throw Object.assign(new Error('temporary worker startup failure'), { retryableDispatch: true, executionStarted: false });
    await dispatch('dispatching'); await dispatch('accepted');
    return { sessionId: 's', sessionPath: '/s', summary: 'ok' };
  } });
  await f.service.save(f.input({ maxScheduledRuns: 1, dispatchRetryLimit: 2 }));
  f.advance(3600000); await f.service.tick();
  const deferred = await f.waitFor(s => s.runs[0]?.status === 'retrying');
  const runId = deferred.runs[0].id;
  assert.equal(deferred.automations[0].scheduledRunCount ?? 0, 0);
  await f.service.dispose();
  const restarted = f.create(); await restarted.initialize();
  await restarted.tick(); assert.equal(attempts, 1);
  f.advance(5001); await Promise.all([restarted.tick(), restarted.tick()]);
  for (let n = 0; n < 50 && (await restarted.snapshot()).runs[0].status === 'running'; n++) await new Promise(r => setTimeout(r, 5));
  const final = await restarted.snapshot();
  assert.equal(attempts, 2); assert.equal(final.runs[0].id, runId);
  assert.equal(final.runs[0].status, 'succeeded'); assert.equal(final.runs[0].attempts, 2);
  assert.equal(final.automations[0].scheduledRunCount, 1); assert.equal(final.automations[0].enabled, false);
  assert.ok(final.automations[0].completedAt);
});

test('three accepted scheduled runs exhaust quota; manual runs do not consume it', async t => {
  const f = await fixture(t, { execute: async (_task, _signal, dispatch) => {
    await dispatch('dispatching'); await dispatch('accepted');
    return { sessionId: null, sessionPath: null, summary: 'ok' };
  } });
  const initial = await f.service.save(f.input({ maxScheduledRuns: 3 }));
  const id = initial.automations[0].id;
  await f.service.run(id); await f.waitFor(s => s.runs[0]?.status === 'succeeded');
  assert.equal((await f.service.snapshot()).automations[0].scheduledRunCount ?? 0, 0);
  for (let count = 1; count <= 3; count++) {
    f.advance(3600000); await Promise.all([f.service.tick(), f.service.tick()]);
    await f.waitFor(s => s.runs[0]?.status === 'succeeded' && s.automations[0].scheduledRunCount === count);
  }
  const done = await f.service.snapshot(); assert.equal(done.automations[0].enabled, false);
  await assert.rejects(f.service.setEnabled(id, true), /上限/);
  await f.service.save({ ...done.automations[0], maxScheduledRuns: 4, enabled: true });
  assert.equal((await f.service.snapshot()).automations[0].completedAt, undefined);
});

test('an uncertain dispatch never retries even if a transport error is marked retryable', async t => {
  const f = await fixture(t, { execute: async (_task, _signal, dispatch) => {
    await dispatch('dispatching');
    throw Object.assign(new Error('reply lost after tool may have run'), { retryableDispatch: true, executionStarted: false });
  } });
  const state = await f.service.save(f.input({ dispatchRetryLimit: 5 }));
  await f.service.run(state.automations[0].id);
  await f.waitFor(s => s.runs[0]?.status === 'failed');
  assert.equal((await f.service.snapshot()).runs[0].attempts, 1);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('scheduled completion write failure preserves exactly one count when a later edit flushes it', async t => {
  const f = await fixture(t);
  const task = (await f.service.save(f.input({ maxScheduledRuns: 1 }))).automations[0];
  f.advance(3600000); await f.service.tick();
  const durable = await readFile(f.filePath, 'utf8'); await rm(f.filePath); await mkdir(f.filePath);
  f.calls[0].gate.resolve({ sessionId: 'done', sessionPath: join(f.root, 'done.jsonl'), summary: 'completed once' });
  await f.waitFor(snapshot => Boolean(snapshot.error));
  await assert.rejects(f.service.tick()); assert.equal(f.calls.length, 1);
  await rmdir(f.filePath); await writeFile(f.filePath, durable);
  const recovered = await f.service.save({ ...task, name: 'edited after completion' });
  assert.equal(recovered.automations[0].scheduledRunCount, 1); assert.equal(recovered.automations[0].enabled, false);
  assert.equal(recovered.runs[0].counted, true); assert.equal(recovered.runs[0].status, 'succeeded');
  f.advance(7200000); await Promise.all([f.service.tick(), f.service.tick()]);
  assert.equal(f.calls.length, 1); assert.equal((await f.service.snapshot()).automations[0].scheduledRunCount, 1);
  const disk = JSON.parse(await readFile(f.filePath, 'utf8'));
  assert.equal(disk.automations[0].scheduledRunCount, 1); assert.equal(disk.runs[0].counted, true);
});

test('pausing during setup suppresses a subsequent transient retry for recurring and already-claimed one-shot tasks', async t => {
  for (const once of [false, true]) {
    const setup = deferred(), entered = deferred(); let attempts = 0;
    const f = await fixture(t, { execute: async () => { attempts++; entered.resolve(); await setup.promise; throw Object.assign(new Error('temporary setup disconnect'), { retryableDispatch: true, executionStarted: false }); } });
    const task = (await f.service.save(f.input({ ...(once ? { schedule: { kind: 'once', at: '2026-09-24T01:00:00Z' } } : {}), dispatchRetryLimit: 5 }))).automations[0];
    f.advance(3600000); await f.service.tick(); await entered.promise;
    await f.service.setEnabled(task.id, false); setup.resolve();
    const settled = await f.waitFor(snapshot => snapshot.runs[0]?.status !== 'running');
    assert.equal(settled.runs[0].status, 'failed', 'an explicit pause also inhibits retries of setup still in flight');
    f.advance(600000); await f.service.tick(); assert.equal(attempts, 1);
    assert.equal(settled.automations[0].scheduledRunCount ?? 0, 0);
  }
});

test('a retry whose persistence failed can still be explicitly cancelled without dispatching again', async t => {
  const setup = deferred(), entered = deferred(); let attempts = 0;
  const f = await fixture(t, { execute: async () => { attempts++; entered.resolve(); await setup.promise; throw Object.assign(new Error('temporary setup disconnect'), { retryableDispatch: true, executionStarted: false }); } });
  const task = (await f.service.save(f.input({ dispatchRetryLimit: 5 }))).automations[0];
  f.advance(3600000); await f.service.tick(); await entered.promise;
  const claimed = await f.service.snapshot(), durable = await readFile(f.filePath, 'utf8');
  await rm(f.filePath); await mkdir(f.filePath); setup.resolve(); await f.waitFor(snapshot => Boolean(snapshot.error));
  await new Promise(resolve => setImmediate(resolve));
  await rmdir(f.filePath); await writeFile(f.filePath, durable);
  const cancelled = await f.service.cancelRun(claimed.runs[0].id);
  assert.equal(cancelled.runs[0].status, 'cancelled'); assert.equal(cancelled.runs[0].retryAt, null);
  f.advance(600000); await f.service.tick(); assert.equal(attempts, 1);
});

test('failed accepted-receipt and completion writes preserve quota and never replay after recovery or restart', async t => {
  const accepted = deferred(), resume = deferred(); let attempts = 0;
  const f = await fixture(t, { execute: async (_task, _signal, dispatch) => {
    attempts++; await dispatch('dispatching'); accepted.resolve(); await resume.promise;
    try { await dispatch('accepted'); } catch (error) { throw Object.assign(error, { executionStarted: true, retryableDispatch: false }); }
    return { sessionId: 'already-sent', sessionPath: '/already-sent', summary: 'done' };
  } });
  await f.service.save(f.input({ maxScheduledRuns: 1, dispatchRetryLimit: 5 }));
  f.advance(3600000); await f.service.tick(); await accepted.promise;
  const completion = [...f.service.active.values()][0].done;
  const durable = await readFile(f.filePath, 'utf8'); await rm(f.filePath); await mkdir(f.filePath);
  resume.resolve(); await f.waitFor(snapshot => Boolean(snapshot.error));
  await assert.rejects(completion, undefined, 'both the accepted receipt and terminal write fail before restoring storage');
  await rmdir(f.filePath); await writeFile(f.filePath, durable); await f.service.tick();
  const recovered = await f.service.snapshot();
  assert.equal(recovered.runs[0].status, 'failed'); assert.equal(recovered.runs[0].counted, true);
  assert.equal(recovered.automations[0].scheduledRunCount, 1); assert.equal(recovered.automations[0].enabled, false);
  await f.service.dispose(); const restarted = f.create(); await restarted.initialize();
  f.advance(86400000); await restarted.tick(); assert.equal(attempts, 1);
  assert.equal((await restarted.snapshot()).automations[0].scheduledRunCount, 1);
});

async function fixture(t, overrides = {}) {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, 'pi-automation-'));
  const filePath = join(root, 'automations.json');
  const calls = [], changes = [], errors = [], waiters = new Set(), services = [];
  let now = Date.parse('2026-09-24T00:00:00.000Z');
  const options = {
    filePath, now: () => now,
    validateWorkspace: async (cwd) => { if (cwd !== root) throw new Error('未知工作区'); },
    execute: async (task, signal) => {
      const gate = deferred();
      calls.push({ task, signal, gate });
      signal.addEventListener('abort', () => gate.reject(new Error('cancelled')), { once: true });
      return gate.promise;
    },
    onChanged: (snapshot) => { changes.push(snapshot); for (const check of waiters) check(snapshot); },
    onError: (error) => errors.push(error), ...overrides,
  };
  const create = (more = {}) => { const service = createAutomationService({ ...options, ...more }); services.push(service); return service; };
  const service = create();
  t.after(async () => {
    await Promise.allSettled(services.map((entry) => entry.dispose()));
    assert.equal(dirname(root), temp);
    await rm(root, { recursive: true, force: true });
  });
  async function waitFor(predicate) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { waiters.delete(check); reject(new Error('Timed out waiting for automation state')); }, 3000);
      const check = (snapshot) => {
        if (predicate(snapshot)) { clearTimeout(timeout); waiters.delete(check); resolve(snapshot); }
      };
      waiters.add(check);
      service.snapshot().then(check, reject);
    });
  }
  const input = (more = {}) => ({
    name: '每日检查', prompt: '检查本地项目并总结发现', cwd: root, model: null, thinkingLevel: null,
    schedule: { kind: 'interval', minutes: 60 }, timeZone: 'Asia/Shanghai', enabled: true, ...more,
  });
  return { root, filePath, service, create, calls, changes, errors, input, waitFor, advance: (ms) => { now += ms; }, now: () => now };
}

test('weekly schedules use the selected zone, skip DST gaps and never repeat folded clock time', () => {
  const monday = { kind: 'weekly', days: [1], time: '09:00' };
  assert.equal(nextAutomationRun(monday, 'Asia/Shanghai', Date.parse('2026-09-27T23:00:00Z')), '2026-09-28T01:00:00.000Z');
  const weekdays = { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' };
  assert.equal(nextAutomationRun(weekdays, 'Asia/Shanghai', Date.parse('2026-09-25T01:00:00Z')), '2026-09-28T01:00:00.000Z');
  assert.equal(nextAutomationRun({ kind: 'weekly', days: [0], time: '02:30' }, 'America/New_York', Date.parse('2026-03-08T00:00:00Z')), '2026-03-15T06:30:00.000Z');
  const repeated = { kind: 'weekly', days: [0], time: '01:30' };
  assert.equal(nextAutomationRun(repeated, 'America/New_York', Date.parse('2026-11-01T00:00:00Z')), '2026-11-01T05:30:00.000Z');
  assert.equal(nextAutomationRun(repeated, 'America/New_York', Date.parse('2026-11-01T05:31:00Z')), '2026-11-08T06:30:00.000Z');
  assert.equal(nextAutomationRun({ kind: 'once', at: '2026-09-24T00:00:00.000Z' }, 'UTC', Date.parse('2026-09-24T00:00:00Z')), null);
  assert.throws(() => validateAutomationSchedule({ kind: 'once', at: '2026-02-30T09:00:00Z' }), /执行日期/);
});

test('plugin maintenance defers scheduled and manual runs without consuming their schedules', async (t) => {
  let ready = false;
  const f = await fixture(t, { canRun: () => ready });
  const task = (await f.service.save(f.input())).automations[0];
  f.advance(60 * 60_000);
  await f.service.tick();
  assert.equal(f.calls.length, 0);
  assert.equal(await f.service.hasActiveRuns(), false);
  assert.equal((await f.service.snapshot()).automations[0].nextRunAt, task.nextRunAt);
  await assert.rejects(f.service.run(task.id), /插件正在更新/);
  ready = true;
  await f.service.tick();
  assert.equal(await f.service.hasActiveRuns(), true);
  assert.equal(f.calls.length, 1);
  const run = (await f.service.snapshot()).runs[0];
  await f.service.cancelRun(run.id);
  assert.equal(await f.service.hasActiveRuns(), false);
});

test('unreleased executor workers block repeated manual runs and all scheduled dispatch after active runs clear', async (t) => {
  const { createAutomationExecutor } = await import('../packages/desktop/src/main/automationExecutor.ts');
  const reason = '上次自动化执行进程尚未退出，请重启应用后重试';
  let created = 0;
  const executor = createAutomationExecutor({ createAgent: () => {
    created += 1;
    let listener;
    const snapshot = { sessionId: 'stuck-worker', sessionPath: '/sessions/stuck.jsonl', status: 'idle', messages: [], error: null };
    return {
      onEvent(callback) { listener = callback; },
      async init() { listener({ event: { type: 'ready', ...snapshot } }); },
      async getSnapshot() { return snapshot; },
      async prompt() { listener({ event: { type: 'status', status: 'idle' } }); },
      async renameSession() {},
      async dispose() { throw Object.assign(new Error('Worker did not exit'), { workerStillRunning: true }); },
    };
  } });
  const f = await fixture(t, {
    canRun: () => executor.hasUnreleasedWorkers() ? reason : true,
    execute: (task, signal) => executor.execute(task, signal),
  });
  const task = (await f.service.save(f.input())).automations[0];
  await f.service.run(task.id);
  await f.waitFor((snapshot) => snapshot.runs[0]?.status === 'failed');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await f.service.hasActiveRuns(), false);
  assert.equal(executor.hasUnreleasedWorkers(), true);
  await assert.rejects(f.service.run(task.id), { message: reason });
  const another = (await f.service.save(f.input({ name: '另一个任务' }))).automations.find((entry) => entry.id !== task.id);
  await assert.rejects(f.service.run(another.id), { message: reason });
  f.advance(60 * 60_000);
  await f.service.tick();
  const current = await f.service.snapshot();
  assert.equal(created, 1);
  assert.equal(current.runs.length, 1);
  assert.equal(current.automations.find((entry) => entry.id === task.id).nextRunAt, task.nextRunAt);
});

test('a dispatch gate changed during workspace validation stops a claimed manual run before execute', async (t) => {
  const validation = deferred();
  const started = deferred();
  let checking = false;
  let permission = true;
  const reason = 'worker exit not confirmed';
  const f = await fixture(t, {
    canRun: () => permission,
    validateWorkspace: async () => { if (checking) { started.resolve(); await validation.promise; } },
  });
  const task = (await f.service.save(f.input())).automations[0];
  checking = true;
  await f.service.run(task.id);
  await started.promise;
  permission = reason;
  validation.resolve();
  const result = await f.waitFor((snapshot) => snapshot.runs[0]?.status === 'failed');
  assert.equal(f.calls.length, 0);
  assert.equal(result.runs[0].error, reason);
});

test('a dispatch gate changed when a claim reaches disk stops execution before workspace setup completes', async (t) => {
  let permission = true;
  const f = await fixture(t, { canRun: () => permission });
  const task = (await f.service.save(f.input())).automations[0];
  const onChanged = f.service.options.onChanged;
  f.service.options.onChanged = (snapshot) => {
    if (snapshot.runs.some((run) => run.status === 'running')) permission = 'worker stopped without exit confirmation';
    onChanged(snapshot);
  };
  await f.service.run(task.id);
  const failed = await f.waitFor((snapshot) => snapshot.runs[0]?.status === 'failed');
  assert.equal(f.calls.length, 0);
  assert.equal(failed.runs[0].error, permission);
});

test('a late dispatch gate preserves a due one-shot schedule but respects intervening user edits', async (t) => {
  for (const editWhileWaiting of [false, true]) {
    const validation = deferred();
    const started = deferred();
    let checking = false;
    let permission = true;
    const f = await fixture(t, {
      canRun: () => permission,
      validateWorkspace: async () => { if (checking) { started.resolve(); await validation.promise; } },
    });
    const task = (await f.service.save(f.input({ schedule: { kind: 'once', at: '2026-09-24T01:00:00Z' } }))).automations[0];
    f.advance(60 * 60_000);
    checking = true;
    await f.service.tick();
    await started.promise;
    checking = false;
    if (editWhileWaiting) await f.service.save({ ...task, name: '保持停用的任务', enabled: false });
    permission = 'worker exit not confirmed';
    validation.resolve();
    const failed = await f.waitFor((snapshot) => snapshot.runs[0]?.status === 'failed');
    assert.equal(f.calls.length, 0);
    assert.equal(failed.automations[0].enabled, !editWhileWaiting);
    assert.equal(failed.automations[0].nextRunAt, editWhileWaiting ? null : task.nextRunAt);
    if (!editWhileWaiting) assert.equal(failed.automations[0].lastRunAt, task.lastRunAt);
    permission = true;
    await f.service.tick();
    assert.equal(f.calls.length, editWhileWaiting ? 0 : 1);
    if (f.calls.length) {
      f.calls[0].gate.resolve({ sessionId: null, sessionPath: null, summary: 'done' });
      await f.waitFor((snapshot) => snapshot.runs[0]?.status === 'succeeded');
      await f.service.tick();
      assert.equal(f.calls.length, 1);
    }
  }
});

test('CRUD persists independent copies, validates input and preserves schedule when editing only task text', async (t) => {
  const f = await fixture(t);
  const saved = await f.service.save(f.input({ name: '  每日检查  ' }));
  const first = saved.automations[0];
  assert.equal(first.name, '每日检查');
  assert.equal(first.nextRunAt, '2026-09-24T01:00:00.000Z');
  saved.automations[0].name = 'external mutation';
  f.advance(30 * 60_000);
  const edited = await f.service.save(f.input({ id: first.id, name: '更新名称' }));
  assert.equal(edited.automations[0].nextRunAt, first.nextRunAt);
  assert.equal((await f.create().snapshot()).automations[0].name, '更新名称');
  assert.equal(JSON.parse(await readFile(f.filePath, 'utf8')).version, 1);
  await assert.rejects(f.service.save(f.input({ cwd: join(f.root, 'unknown') })), /未知工作区/);
  await assert.rejects(f.service.save(f.input({ name: '' })), /名称/);
  await assert.rejects(f.service.save(f.input({ schedule: { kind: 'interval', minutes: 0 } })), /执行间隔/);
  await assert.rejects(f.service.save(f.input({ schedule: { kind: 'weekly', days: [], time: '09:00' } })), /星期/);
  await assert.rejects(f.service.save(f.input({ schedule: { kind: 'weekly', days: [1, 1], time: '09:00' } })), /星期/);
  await assert.rejects(f.service.save(f.input({ timeZone: 'Invalid/Zone' })), /时区/);
  await assert.rejects(f.service.save(f.input({ schedule: { kind: 'once', at: '2026-09-23T12:00:00Z' } })), /晚于/);
  await assert.rejects(f.service.save(f.input({ enabled: 'yes' })), /启用/);
  assert.equal((await f.service.snapshot()).automations.length, 1);
  assert.equal((await f.service.setEnabled(first.id, false)).automations[0].nextRunAt, null);
  assert.equal((await f.service.setEnabled(first.id, true)).automations[0].nextRunAt, '2026-09-24T01:30:00.000Z');
  assert.equal((await f.service.delete(first.id)).automations.length, 0);
  assert.ok(f.changes.every((snapshot, index) => index === 0 || snapshot.revision > f.changes[index - 1].revision));
});

test('manual execution is claimed durably, prevents overlap, preserves its schedule and links its completed session', async (t) => {
  const f = await fixture(t);
  const task = (await f.service.save(f.input())).automations[0];
  const running = await f.service.run(task.id);
  const runId = running.runs[0].id;
  const disk = JSON.parse(await readFile(f.filePath, 'utf8'));
  assert.equal(disk.runs[0].status, 'running');
  assert.equal(running.automations[0].nextRunAt, task.nextRunAt);
  assert.equal(running.runs[0].sessionPath, null);
  await assert.rejects(f.service.run(task.id), /已在运行/);
  await assert.rejects(f.service.delete(task.id), /先停止/);
  await f.service.setEnabled(task.id, false);
  assert.equal(f.calls[0].signal.aborted, false, 'pausing affects future schedules, not the current execution');
  f.calls[0].gate.resolve({ sessionId: 'session-1', sessionPath: join(f.root, 'session.jsonl'), summary: '完成检查' });
  const finished = await f.waitFor((snapshot) => snapshot.runs[0]?.status === 'succeeded');
  assert.equal(finished.runs[0].id, runId);
  assert.equal(finished.runs[0].summary, '完成检查');
  assert.equal(finished.runs[0].sessionId, 'session-1');
  assert.equal(finished.automations[0].enabled, false);
  await f.service.delete(task.id);
  assert.equal((await f.service.snapshot()).runs[0].name, '每日检查', 'deleting a task retains its result history');
});

test('overdue schedules catch up only once and total concurrent execution is bounded', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) await f.service.save(f.input({ name: `检查 ${i}` }));
  f.advance(10 * 60 * 60_000);
  await Promise.all([f.service.tick(), f.service.tick(), f.service.tick()]);
  assert.equal(f.calls.length, 2);
  assert.equal((await f.service.snapshot()).runs.length, 2);
  assert.equal((await f.service.snapshot()).automations.filter((task) => task.nextRunAt === '2026-09-24T11:00:00.000Z').length, 2);
  f.calls[0].gate.resolve({ sessionId: null, sessionPath: null, summary: 'done' });
  await f.waitFor((snapshot) => snapshot.runs.some((run) => run.status === 'succeeded'));
  await f.service.tick();
  assert.equal(f.calls.length, 3);
  f.calls[1].gate.resolve({ sessionId: null, sessionPath: null, summary: 'done' });
  f.calls[2].gate.resolve({ sessionId: null, sessionPath: null, summary: 'done' });
  await f.waitFor((snapshot) => snapshot.runs.every((run) => run.status === 'succeeded'));
  await f.service.tick();
  assert.equal(f.calls.length, 3, 'missed hourly runs must not be replayed in a burst');
});

test('scheduled one-shot execution disables itself before running, manual execution does not consume it', async (t) => {
  const f = await fixture(t);
  const task = (await f.service.save(f.input({ schedule: { kind: 'once', at: '2026-09-24T01:00:00Z' } }))).automations[0];
  await f.service.run(task.id);
  f.calls[0].gate.resolve({ sessionId: null, sessionPath: null, summary: 'manual' });
  await f.waitFor((snapshot) => snapshot.runs[0]?.status === 'succeeded');
  assert.equal((await f.service.snapshot()).automations[0].enabled, true);
  f.advance(60 * 60_000);
  await f.service.tick();
  const snapshot = await f.service.snapshot();
  assert.equal(snapshot.automations[0].enabled, false);
  assert.equal(snapshot.automations[0].nextRunAt, null);
  assert.equal(snapshot.runs[0].trigger, 'schedule');
  await assert.rejects(f.service.setEnabled(task.id, true), /日期已过/);
  f.calls[1].gate.resolve({ sessionId: null, sessionPath: null, summary: 'scheduled' });
  await f.waitFor((state) => state.runs.every((run) => run.status === 'succeeded'));
  await f.service.tick();
  assert.equal(f.calls.length, 2);
});

test('failure and cancellation keep result sessions, while shutdown waits for workers to release them', async (t) => {
  const f = await fixture(t);
  const task = (await f.service.save(f.input({ enabled: false }))).automations[0];
  await f.service.run(task.id);
  const failed = Object.assign(new Error('模型不可用'), { sessionId: 'failed-session', sessionPath: join(f.root, 'failed.jsonl'), summary: '部分输出' });
  f.calls[0].gate.reject(failed);
  const snapshot = await f.waitFor((state) => state.runs[0]?.status === 'failed');
  assert.equal(snapshot.runs[0].sessionId, 'failed-session');
  assert.equal(snapshot.runs[0].summary, '部分输出');
  assert.equal(snapshot.runs[0].error, '模型不可用');
  const running = await f.service.run(task.id);
  const cancelled = await f.service.cancelRun(running.runs[0].id);
  assert.equal(cancelled.runs[0].status, 'cancelled');
  assert.equal(f.calls[1].signal.aborted, true);
  await f.service.run(task.id);
  await f.service.dispose();
  assert.equal(f.calls[2].signal.aborted, true);
  assert.equal((await f.service.snapshot()).runs[0].status, 'cancelled');
  await assert.rejects(f.service.run(task.id), /关闭/);
});

test('restart records interrupted executions without replaying already claimed schedules', async (t) => {
  const f = await fixture(t);
  await f.service.save(f.input());
  f.advance(60 * 60_000);
  await f.service.tick();
  const claimedBytes = await readFile(f.filePath, 'utf8');
  await f.service.dispose();
  await writeFile(f.filePath, claimedBytes);
  const restarted = f.create();
  const snapshot = await restarted.initialize();
  assert.equal(snapshot.runs[0].status, 'interrupted');
  assert.ok(snapshot.runs[0].finishedAt);
  await restarted.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(await readFile(f.filePath, 'utf8')).runs[0].status, 'interrupted');
});

test('malformed state is preserved and a failed durable claim never starts execution', async (t) => {
  const f = await fixture(t);
  const corrupt = '{"version": 1, "automations": [';
  await writeFile(f.filePath, corrupt);
  await assert.rejects(f.service.initialize(), /状态文件损坏/);
  await assert.rejects(f.service.save(f.input()), /状态文件损坏/);
  assert.equal(await readFile(f.filePath, 'utf8'), corrupt);
  const other = f.create({ filePath: join(f.root, 'other.json') });
  const task = (await other.save(f.input())).automations[0];
  await rm(join(f.root, 'other.json'));
  await mkdir(join(f.root, 'other.json'));
  await assert.rejects(other.run(task.id));
  assert.equal((await other.snapshot()).runs.length, 0);
  assert.equal(f.calls.length, 0);
});

test('concurrent starts create one timer and disposing an unused service never reads its store', async (t) => {
  const f = await fixture(t);
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const created = [], cleared = [];
  globalThis.setInterval = (...args) => { const timer = originalSetInterval(...args); created.push(timer); return timer; };
  globalThis.clearInterval = (timer) => { cleared.push(timer); return originalClearInterval(timer); };
  try {
    await Promise.all([f.service.start(), f.service.start(), f.service.start()]);
    assert.equal(created.length, 1);
    await f.service.dispose();
    assert.deepEqual(cleared, created);
  } finally {
    for (const timer of created) originalClearInterval(timer);
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
  const unreadable = f.create({ filePath: f.root });
  await unreadable.dispose();
});

test('failed completion writes are visible and retry safely without executing the task again', async (t) => {
  const f = await fixture(t);
  const task = (await f.service.save(f.input())).automations[0];
  await f.service.run(task.id);
  const durable = await readFile(f.filePath, 'utf8');
  const initialRevision = (await f.service.snapshot()).revision;
  await rm(f.filePath);
  await mkdir(f.filePath);
  f.calls[0].gate.resolve({ sessionId: 'safe-result', sessionPath: join(f.root, 'result.jsonl'), summary: '完成输出' });
  const failed = await f.waitFor((snapshot) => Boolean(snapshot.error));
  assert.match(failed.error, /保存失败/);
  assert.ok(failed.revision > initialRevision);
  assert.equal(failed.runs[0].status, 'running', 'do not claim a completion has been persisted while the write failed');
  assert.equal(failed.runs[0].sessionPath, null);
  f.advance(30 * 60_000);
  await assert.rejects(f.service.tick(), undefined, 'failed retry blocks claiming other due work');
  assert.equal(f.calls.length, 1);
  assert.equal(dirname(f.filePath), f.root);
  await rmdir(f.filePath);
  await writeFile(f.filePath, durable);
  await f.service.tick();
  const recovered = await f.service.snapshot();
  assert.equal(recovered.error, undefined);
  assert.ok(recovered.revision > failed.revision);
  assert.equal(recovered.runs[0].status, 'succeeded');
  assert.equal(recovered.runs[0].sessionId, 'safe-result');
  assert.equal(recovered.runs[0].summary, '完成输出');
  await f.service.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(await readFile(f.filePath, 'utf8')).runs[0].status, 'succeeded');
});

test('deferred one-shot schedule recovery survives failed writes and later user changes take precedence', async (t) => {
  for (const recovery of ['retry', 'edit', 'disable']) {
    const validation = deferred();
    const started = deferred();
    let checking = false;
    let permission = true;
    const f = await fixture(t, {
      canRun: () => permission,
      validateWorkspace: async () => { if (checking) { started.resolve(); await validation.promise; } },
    });
    const task = (await f.service.save(f.input({ schedule: { kind: 'once', at: '2026-09-24T01:00:00Z' } }))).automations[0];
    f.advance(60 * 60_000);
    checking = true;
    await f.service.tick();
    await started.promise;
    const durable = await readFile(f.filePath, 'utf8');
    await rm(f.filePath);
    await mkdir(f.filePath);
    permission = 'worker exit not confirmed';
    validation.resolve();
    await f.waitFor((snapshot) => Boolean(snapshot.error));
    await assert.rejects(f.service.tick(), /directory|operation|EPERM|EISDIR/i);
    assert.equal(f.calls.length, 0);
    checking = false;
    assert.equal(dirname(f.filePath), f.root);
    await rmdir(f.filePath);
    await writeFile(f.filePath, durable);
    if (recovery === 'edit') {
      await f.service.save({ ...task, name: '用户修改后的计划', schedule: { kind: 'once', at: '2026-09-24T03:00:00Z' } });
    } else if (recovery === 'disable') {
      await f.service.setEnabled(task.id, false);
    } else {
      await f.service.tick();
    }
    const recovered = await f.service.snapshot();
    assert.equal(recovered.error, undefined);
    assert.equal(recovered.runs[0].status, 'failed');
    assert.equal(f.calls.length, 0);
    const restoredTask = recovered.automations[0];
    const disk = JSON.parse(await readFile(f.filePath, 'utf8'));
    assert.deepEqual(disk.automations[0], restoredTask);
    if (recovery === 'retry') {
      assert.equal(restoredTask.enabled, true);
      assert.equal(restoredTask.nextRunAt, task.nextRunAt);
      assert.equal(restoredTask.lastRunAt, task.lastRunAt);
      permission = true;
      await f.service.tick();
      assert.equal(f.calls.length, 1);
      f.calls[0].gate.resolve({ sessionId: null, sessionPath: null, summary: 'executed after recovery' });
      await f.waitFor((snapshot) => snapshot.runs[0]?.status === 'succeeded');
      await f.service.tick();
      assert.equal(f.calls.length, 1);
    } else {
      assert.equal(restoredTask.enabled, recovery === 'edit');
      assert.equal(restoredTask.nextRunAt, recovery === 'edit' ? '2026-09-24T03:00:00.000Z' : null);
      if (recovery === 'edit') assert.equal(restoredTask.name, '用户修改后的计划');
      permission = true;
      await f.service.tick();
      assert.equal(f.calls.length, 0);
    }
  }
});

test('a failed initial scheduled claim reports its error but polling recovers when storage returns', async (t) => {
  const f = await fixture(t, { pollIntervalMs: 10 });
  await f.service.save(f.input());
  f.advance(60 * 60_000);
  const durable = await readFile(f.filePath, 'utf8');
  await rm(f.filePath);
  await mkdir(f.filePath);
  await assert.rejects(f.service.start());
  assert.equal(f.calls.length, 0);
  assert.match((await f.service.snapshot()).error, /保存失败/);
  assert.equal(dirname(f.filePath), f.root);
  await rmdir(f.filePath);
  await writeFile(f.filePath, durable);
  await f.waitFor((snapshot) => snapshot.runs[0]?.status === 'running');
  const recovered = await f.service.snapshot();
  assert.equal(recovered.error, undefined);
  assert.equal(f.calls.length, 1);
  assert.equal(recovered.automations[0].nextRunAt, '2026-09-24T02:00:00.000Z');
});
