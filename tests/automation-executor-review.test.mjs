import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') return {
    url: 'data:text/javascript,export const app={getAppPath:()=>"test-app"};export const utilityProcess={fork:()=>{globalThis.__automationReviewForks=(globalThis.__automationReviewForks??0)+1;return globalThis.__automationReviewHost;}};',
    shortCircuit: true,
  };
  if (specifier === './agentClient') return nextResolve('./agentClient.ts', context);
  return nextResolve(specifier, context);
} });
const { createAutomationExecutor } = await import('../packages/desktop/src/main/automationExecutor.ts');
const task = { id: 'review', name: 'Review automation', cwd: '/project', prompt: 'Review using the stub provider' };
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  let listener;
  const calls = [];
  const snapshot = { sequence: 0, sessionId: 'review-session', sessionPath: '/sessions/review.jsonl', status: 'idle', messages: [], error: null };
  const agent = {
    onEvent(callback) { listener = callback; },
    async init() { listener({ event: { type: 'ready', ...snapshot } }); },
    async getSnapshot() { return snapshot; },
    async prompt() { snapshot.status = 'busy'; },
    async renameSession() { calls.push('rename'); },
    async abort() { calls.push('abort'); },
    async dispose() { calls.push('dispose'); },
  };
  return { snapshot, calls, emit: (event) => listener({ event }), executor: createAutomationExecutor({ createAgent: () => agent }) };
}

test('a successful SDK retry clears the failed attempt before reporting the automation result', async () => {
  const f = fixture();
  const execution = f.executor.execute(task, new AbortController().signal);
  const result = execution.then((value) => ({ value }), (error) => ({ error }));
  await settle();
  f.emit({ type: 'assistant-end', id: 'attempt-one', text: '', errorMessage: 'Temporary rate limit' });
  f.emit({ type: 'status', status: 'busy', message: 'auto retry 1/3' });
  f.emit({ type: 'assistant-start', id: 'attempt-two', order: 2 });
  f.emit({ type: 'assistant-end', id: 'attempt-two', text: 'The retry succeeded.' });
  f.snapshot.messages = [{ role: 'assistant', status: 'done', text: 'The retry succeeded.' }];
  f.snapshot.status = 'idle';
  f.emit({ type: 'status', status: 'idle' });
  const outcome = await result;
  assert.equal(outcome.error, undefined, 'a transient failed attempt must not override a successful final snapshot');
  assert.equal(outcome.value.summary, 'The retry succeeded.');
});

test('a diagnostic extension error does not count as the model reaching an idle state', async () => {
  const f = fixture();
  let completed = false;
  const execution = f.executor.execute(task, new AbortController().signal);
  const outcome = execution.then((value) => { completed = true; return { value }; }, (error) => { completed = true; return { error }; });
  await settle();
  f.emit({ type: 'error', message: 'An optional extension hook failed' });
  await settle();
  const completedBeforeIdle = completed;
  const disposedBeforeIdle = f.calls.includes('dispose');
  f.snapshot.status = 'idle';
  f.snapshot.messages = [{ role: 'assistant', text: 'The model finished safely.', status: 'done' }];
  f.emit({ type: 'assistant-end', id: 'final', text: 'The model finished safely.' });
  f.emit({ type: 'status', status: 'idle' });
  await outcome;
  assert.equal(completedBeforeIdle, false, 'an error notice is not proof that running model/tools have stopped');
  assert.equal(disposedBeforeIdle, false);
});

test('automation keeps its session locked until the utility worker really exits', async () => {
  const host = new EventEmitter();
  const snapshot = { sequence: 0, sessionId: 'worker-session', sessionPath: '/sessions/worker.jsonl', status: 'idle', messages: [], error: null };
  let sequence = 0;
  let kills = 0;
  const emit = (event) => host.emit('message', { kind: 'event', envelope: { sequence: ++sequence, event } });
  host.kill = () => { kills += 1; return true; };
  host.postMessage = (request) => {
    if (request.kind !== 'call') return;
    queueMicrotask(() => {
      if (request.method === 'init') emit({ type: 'ready', ...snapshot });
      if (request.method === 'prompt') { snapshot.status = 'busy'; emit({ type: 'status', status: 'busy' }); }
      host.emit('message', { kind: 'reply', id: request.id, value: request.method === 'getSnapshot' ? snapshot : undefined });
    });
  };
  globalThis.__automationReviewHost = host;
  const executor = createAutomationExecutor();
  let completed = false;
  const execution = executor.execute(task, new AbortController().signal).then((result) => { completed = true; return result; });
  try {
    host.emit('message', { kind: 'ready' });
    await settle();
    snapshot.status = 'idle';
    snapshot.messages = [{ role: 'assistant', text: 'Finished', status: 'done' }];
    emit({ type: 'assistant-end', id: 'answer', text: 'Finished' });
    emit({ type: 'status', status: 'idle' });
    await settle();
    assert.equal(kills, 1, 'the worker has received a kill request');
    assert.equal(completed, false, 'kill() returning is not the process exit event');
    assert.equal(executor.isSessionRunning(snapshot.sessionPath), true);
  } finally {
    host.emit('exit', 0);
    await execution;
    delete globalThis.__automationReviewHost;
  }
  assert.equal(executor.isSessionRunning(snapshot.sessionPath), false);
});

test('an automation cancelled before initialization never forks a cleanup worker', async () => {
  const host = new EventEmitter();
  host.kill = () => { host.emit('exit', 0); return true; };
  host.postMessage = (request) => {
    if (request.kind === 'call') queueMicrotask(() => host.emit('message', { kind: 'reply', id: request.id, value: undefined }));
  };
  globalThis.__automationReviewHost = host;
  globalThis.__automationReviewForks = 0;
  const controller = new AbortController();
  controller.abort();
  const outcome = createAutomationExecutor().execute(task, controller.signal).then(() => null, (error) => error);
  try {
    await settle();
    const forks = globalThis.__automationReviewForks;
    // Also release an erroneously spawned worker so the regression cannot hang.
    host.emit('message', { kind: 'ready' });
    assert.match((await outcome).message, /停止/);
    assert.equal(forks, 0, 'cancelling an unstarted run must not fork a process only to abort it');
  } finally {
    host.emit('exit', 0);
    delete globalThis.__automationReviewHost;
    delete globalThis.__automationReviewForks;
  }
});

test('workspace restoration skips running automation sessions and creates a fresh context if all are excluded', async () => {
  // Only the AgentService selection policy is exercised; every runtime and
  // session listing below is a stub, so no SDK session or provider is started.
  const { AgentService } = await import('../packages/agent/src/index.ts');
  for (const existingPaths of [['/sessions/running.jsonl', '/sessions/safe.jsonl'], ['/sessions/running.jsonl']]) {
    const service = new AgentService();
    const initialized = [];
    service.listSessions = async () => existingPaths.map((path) => ({ path }));
    service.newContext = (key) => {
      const context = {
        cwd: '/project', hasSession: false,
        async init(input) { initialized.push(input); },
        async dispose() {},
        getSnapshot: () => ({ cwd: '/project', sessionId: null, sessionPath: null, messages: [], activities: [] }),
      };
      service.contexts.set(key, context);
      return context;
    };
    await service.init({ cwd: '/project', excludeSessionPaths: ['/sessions/running.jsonl'] });
    assert.equal(initialized.length, 1);
    assert.deepEqual(initialized[0], existingPaths.length > 1
      ? { cwd: '/project', sessionPath: '/sessions/safe.jsonl', fresh: false }
      : { cwd: '/project', sessionPath: undefined, fresh: true });
    await service.dispose();
  }
});

test('automation IPC accepts only its current main renderer and starts scheduling after readiness', async () => {
  const handlers = new Map();
  const calls = [];
  const owner = Object.assign(new EventEmitter(), {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    isVisible: () => false,
    webContents: { mainFrame: {}, isDestroyed: () => false, send() {} },
  });
  globalThis.__automationIpcReview = { handlers, calls, owner };
  const stubSources = {
    electron: `
      const env=globalThis.__automationIpcReview;
      export const app={getPath:()=>'/automation-review'};
      export const BrowserWindow={getAllWindows:()=>[env.owner],fromWebContents:sender=>sender===env.owner.webContents?env.owner:undefined};
      export const dialog={showErrorBox(){}};
      export const ipcMain={handle:(channel,handler)=>env.handlers.set(channel,handler)};
    `,
    './appLocale': `export const getAppLocale=()=>'en-US';export const setAppLocale=()=>{};`,
    './agentClient': `export const createIsolatedAgentService=()=>({onEvent(){},onBackgroundActivity(){},async dispose(){}});`,
    './automationExecutor': `export const createAutomationExecutor=()=>({isSessionRunning:()=>false,sessionPaths:()=>[],async execute(){throw new Error('No plans may execute in this test')}});`,
    './automationService': `export function createAutomationService(){
      const calls=globalThis.__automationIpcReview.calls;
      return Object.fromEntries(['snapshot','save','setEnabled','delete','run','cancelRun','start','dispose'].map(method=>[method,(...args)=>{calls.push([method,...args]);return Promise.resolve({});}]));
    }`,
    './workbenchIpc': `export const registerWorkbenchIpc=()=>({async reset(){},async dispose(){}});`,
    './updateService': `export const updateService={};`,
  };
  const hook = registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes('/main/ipc.ts?automation-sender-review') && stubSources[specifier]) {
      return { url: `data:text/javascript,${encodeURIComponent(stubSources[specifier])}`, shortCircuit: true };
    }
    if (specifier.startsWith('./') && context.parentURL && new URL(context.parentURL).pathname.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  } });
  try {
    const ipc = await import('../packages/desktop/src/main/ipc.ts?automation-sender-review');
    const { IPC_CHANNELS } = await import('../packages/shared/src/index.ts');
    ipc.registerIpc({ getDialogWindow: () => owner });
    assert.deepEqual(calls, [], 'registering handlers cannot start scheduled work before the UI is ready');
    const event = { sender: owner.webContents, senderFrame: owner.webContents.mainFrame };
    for (const channel of [IPC_CHANNELS.automationSnapshot, IPC_CHANNELS.automationSave, IPC_CHANNELS.automationSetEnabled,
      IPC_CHANNELS.automationDelete, IPC_CHANNELS.automationRun, IPC_CHANNELS.automationCancelRun]) {
      assert.throws(() => handlers.get(channel)({ ...event, senderFrame: {} }, 'task'), /Invalid automation sender/);
      assert.throws(() => handlers.get(channel)({ ...event, sender: {} }, 'task'), /Invalid automation sender/);
    }
    assert.deepEqual(calls, []);
    await handlers.get(IPC_CHANNELS.automationSnapshot)(event);
    assert.deepEqual(calls, [['snapshot']]);
    handlers.get(IPC_CHANNELS.rendererReady)(event);
    assert.deepEqual(calls.at(-1), ['start']);
    await ipc.disposeServices();
    assert.deepEqual(calls.at(-1), ['dispose']);
    assert.throws(() => handlers.get(IPC_CHANNELS.automationRun)(event, 'task'), /Invalid automation sender/);
  } finally {
    hook.deregister();
    delete globalThis.__automationIpcReview;
  }
});
