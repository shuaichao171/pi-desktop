import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === './agentClient') return { url: 'data:text/javascript,export const createIsolatedAgentService=()=>{throw new Error("Unexpected live worker")}', shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { createAutomationExecutor } = await import('../packages/desktop/src/main/automationExecutor.ts');
const task = { id: 'task', name: 'Review', prompt: 'Review the project', cwd: '/project', model: { provider: 'test', id: 'model' }, thinkingLevel: 'high' };
const settle = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function fixture(overrides = {}) {
  let ui, listener;
  const calls = [];
  const snapshot = { sessionId: 'new-session', sessionPath: '/sessions/new.jsonl', status: 'idle', messages: [], error: null };
  const agent = {
    onEvent(callback) { listener = callback; },
    async init(input) { calls.push(['init', input]); listener({ event: { type: 'ready', ...snapshot } }); },
    async getSnapshot() { return snapshot; },
    async setModel(...args) { calls.push(['model', ...args]); },
    async setThinkingLevel(...args) { calls.push(['thinking', ...args]); },
    async prompt(text) { calls.push(['prompt', text]); snapshot.status = 'busy'; },
    async renameSession(...args) { calls.push(['rename', ...args]); },
    async abort() { calls.push(['abort']); },
    async dispose() { calls.push(['dispose']); },
    ...overrides,
  };
  const executor = createAutomationExecutor({ createAgent: (handlers) => { ui = handlers; return agent; } });
  return { executor, calls, snapshot, get ui() { return ui; }, emit: (event) => listener({ event }),
    complete() {
      snapshot.status = 'idle';
      snapshot.messages = [{ role: 'assistant', text: 'Review complete.', status: 'done' }];
      listener({ event: { type: 'assistant-end', text: 'Review complete.' } });
      listener({ event: { type: 'status', status: 'idle' } });
    },
  };
}

test('automation waits for actual completion after prompt acknowledgement and isolates its session', async () => {
  const f = fixture();
  let finished = false;
  const running = f.executor.execute(task, new AbortController().signal).then((result) => { finished = true; return result; });
  await settle();
  assert.equal(finished, false);
  assert.deepEqual(f.calls.slice(0, 4), [
    ['init', { cwd: task.cwd, fresh: true }], ['model', 'test', 'model', false], ['thinking', 'high', false], ['prompt', task.prompt],
  ]);
  assert.equal(f.executor.isSessionRunning('/sessions/new.jsonl'), true);
  assert.equal(f.executor.hasActiveWorkers(), true);
  assert.equal(f.executor.hasUnreleasedWorkers(), false);
  assert.deepEqual(f.executor.sessionPaths('/project'), ['/sessions/new.jsonl']);
  assert.deepEqual(await f.ui.requestProjectTrust('/new-project'), { trusted: false, remember: false });
  f.complete();
  assert.deepEqual(await running, { sessionId: 'new-session', sessionPath: '/sessions/new.jsonl', summary: 'Review complete.' });
  assert.equal(f.executor.isSessionRunning('/sessions/new.jsonl'), false);
  assert.equal(f.executor.hasActiveWorkers(), false);
  assert.equal(f.executor.hasUnreleasedWorkers(), false);
  assert.deepEqual(f.calls.at(-1), ['dispose']);
});

test('failure after acceptance retains the result session and never reports success', async () => {
  const f = fixture();
  const result = f.executor.execute(task, new AbortController().signal);
  const rejection = assert.rejects(result, (error) => error.message === 'provider failed' && error.sessionPath === '/sessions/new.jsonl');
  await settle();
  f.emit({ type: 'error', message: 'provider failed' });
  f.emit({ type: 'status', status: 'idle' });
  await rejection;
  assert.deepEqual(f.calls.at(-1), ['dispose']);
});

test('cancel keeps the session locked until worker disposal finishes', async () => {
  const disposed = deferred();
  const f = fixture({ dispose: () => disposed.promise });
  const controller = new AbortController();
  const result = f.executor.execute(task, controller.signal);
  const rejection = assert.rejects(result, (error) => /停止/.test(error.message) && error.sessionId === 'new-session');
  await settle();
  controller.abort();
  await settle();
  assert.equal(f.executor.isSessionRunning('/sessions/new.jsonl'), true);
  assert.equal(f.executor.hasUnreleasedWorkers(), false, 'an ordinary shutdown wait must not poison scheduling');
  disposed.resolve();
  await rejection;
  assert.equal(f.executor.isSessionRunning('/sessions/new.jsonl'), false);
});

test('interactive extension requests stop an unattended run without approving them', async () => {
  const f = fixture();
  const result = f.executor.execute(task, new AbortController().signal);
  const rejection = assert.rejects(result, /需要交互.*Confirm deployment/);
  await settle();
  assert.equal(await f.ui.requestExtensionDialog({ kind: 'notify', title: 'Notice' }), null);
  await assert.rejects(f.ui.requestExtensionDialog({ kind: 'confirm', title: 'Confirm deployment' }), /需要交互/);
  await rejection;
  assert.deepEqual(f.calls.at(-1), ['dispose']);
});

test('already cancelled automation does not initialize or prompt a worker', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.executor.execute(task, controller.signal), /停止/);
  assert.ok(!f.calls.some(([method]) => ['init', 'prompt', 'abort'].includes(method)));
});

test('an unconfirmed worker shutdown keeps its session hidden and locked', async () => {
  const f = fixture({ async dispose() { throw Object.assign(new Error('Worker did not exit'), { workerStillRunning: true }); } });
  const running = f.executor.execute(task, new AbortController().signal);
  const rejection = assert.rejects(running, (error) => error.sessionPath === null && /did not exit/.test(error.message));
  await settle();
  f.complete();
  await rejection;
  assert.equal(f.executor.isSessionRunning('/sessions/new.jsonl'), true);
  assert.equal(f.executor.hasActiveWorkers(), true);
  assert.equal(f.executor.hasUnreleasedWorkers(), true);
});

test('a shutdown error after confirmed exit does not leave an unreleased-worker gate', async () => {
  const f = fixture({ async dispose() { throw new Error('Cleanup failed after exit'); } });
  const running = f.executor.execute(task, new AbortController().signal);
  const rejection = assert.rejects(running, /Cleanup failed after exit/);
  await settle();
  f.complete();
  await rejection;
  assert.equal(f.executor.hasUnreleasedWorkers(), false);
  assert.equal(f.executor.hasActiveWorkers(), false);
});

test('an unconfirmed startup worker blocks new dispatch even without a registered session path', async () => {
  const f = fixture({
    async init() { throw new Error('Startup failed'); },
    async dispose() { throw Object.assign(new Error('Worker did not exit'), { workerStillRunning: true }); },
  });
  await assert.rejects(f.executor.execute(task, new AbortController().signal), /Startup failed/);
  assert.deepEqual(f.executor.sessionPaths(task.cwd), []);
  assert.equal(f.executor.hasUnreleasedWorkers(), true);
});
