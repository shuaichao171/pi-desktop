import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const stubs = {
  electron: `
    export const app = { getPath: () => globalThis.__ipcUserData, getVersion: () => '0.1.7-test' };
    export const shell = { showItemInFolder: () => {} };
    export const Menu = { buildFromTemplate: () => ({}) };
    export const nativeImage = { createFromPath: () => ({ isEmpty: () => true }) };
    export const Tray = class {};
    export const BrowserWindow = {
      getAllWindows: () => globalThis.__ipcWindows ?? [],
      fromWebContents: (sender) => globalThis.__ipcWindows?.find((win) => win.webContents === sender),
    };
    export const dialog = { showErrorBox: () => {}, showOpenDialog: (...args) => globalThis.__ipcOpenDialog(...args) };
    export const Notification = class { static isSupported() { return false; } on() { return this; } show() {} };
    export const ipcMain = { handle: (channel, handler) => globalThis.__ipcHandlers.set(channel, handler) };
    export const powerSaveBlocker = { start: () => 1, stop: () => {}, isStarted: () => false };
  `,
  './agentClient': `
    export function createIsolatedAgentService(ui) {
      globalThis.__ipcAgentUi = ui;
      return globalThis.__ipcAgent;
    }
  `,
  './updateService': 'export const updateService = { stop() {}, setAutoInstallSource: async () => {} };',
  './workbenchIpc': `
    export const registerWorkbenchIpc = () => globalThis.__ipcWorkbench ?? ({ reset: async () => {}, dispose: async () => {} });
  `,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (stubs[specifier]) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
    if (specifier.startsWith('./') && context.parentURL && new URL(context.parentURL).pathname.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

function createIpcWindow() {
  const win = Object.assign(new EventEmitter(), {
    destroyed: false,
    visible: false,
    sent: [],
    isDestroyed: () => win.destroyed,
    isVisible: () => win.visible,
    show: () => { win.visible = true; win.emit('show'); },
    close: () => { win.destroyed = true; win.visible = false; win.emit('closed'); },
    webContents: { mainFrame: {}, isDestroyed: () => win.destroyed, send: (...args) => win.sent.push(args) },
  });
  return win;
}

test('startup IPC routes extension dialogs to the main renderer and authenticates readiness', async (t) => {
  const splash = createIpcWindow();
  const main = createIpcWindow();
  globalThis.__ipcWindows = [splash, main];
  globalThis.__ipcHandlers = new Map();
  globalThis.__ipcUserData = tmpdir();
  globalThis.__ipcAgent = { onEvent: () => {}, onBackgroundActivity: () => {}, dispose: async () => {} };
  t.after(() => { delete globalThis.__ipcWindows; });
  const ipc = await import('../packages/desktop/src/main/ipc.ts?startup-dialogs');
  const { IPC_CHANNELS } = await import('../packages/shared/src/index.ts');
  const readyWindows = [];
  ipc.registerIpc({ getDialogWindow: () => main, onRendererReady: (win) => readyWindows.push(win) });
  const eventFor = (win) => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  const ready = globalThis.__ipcHandlers.get(IPC_CHANNELS.rendererReady);
  ready(eventFor(main));
  assert.deepEqual(readyWindows, [main]);
  assert.throws(() => ready({ sender: main.webContents, senderFrame: {} }), /Invalid renderer sender/);
  assert.throws(() => ready({ sender: {}, senderFrame: {} }), /no longer available/);

  const request = { id: 'startup-choice', kind: 'confirm', title: 'Continue initialization?', message: 'Extension startup' };
  const result = globalThis.__ipcAgentUi.requestExtensionDialog(request);
  assert.deepEqual(splash.sent, [], 'the logo splash never receives interactive requests');
  assert.deepEqual(main.sent, [[IPC_CHANNELS.agentExtensionDialog, request]]);
  const pending = globalThis.__ipcHandlers.get(IPC_CHANNELS.agentExtensionDialogPending);
  assert.deepEqual(pending(eventFor(main)), [request], 'requests sent before renderer subscription remain recoverable');
  assert.deepEqual(pending(eventFor(splash)), []);
  const respond = globalThis.__ipcHandlers.get(IPC_CHANNELS.agentExtensionDialogResponse);
  respond(eventFor(splash), request.id, true);
  assert.deepEqual(pending(eventFor(main)), [request], 'a different window cannot answer the startup dialog');
  respond(eventFor(main), request.id, true);
  assert.equal(await result, true);
  assert.deepEqual(pending(eventFor(main)), []);

  main.close();
  assert.throws(() => ready(eventFor(main)), /no longer available/);
  await ipc.disposeServices();
});

test('startup notifications wait for their own ready, visible window and retain a bounded queue', async (t) => {
  const first = createIpcWindow();
  const second = createIpcWindow();
  const closing = createIpcWindow();
  const noisy = createIpcWindow();
  const disposing = createIpcWindow();
  let owner = first;
  globalThis.__ipcWindows = [first, second, closing, noisy, disposing];
  globalThis.__ipcHandlers = new Map();
  globalThis.__ipcUserData = tmpdir();
  globalThis.__ipcAgent = { onEvent: () => {}, onBackgroundActivity: () => {}, dispose: async () => {} };
  t.after(() => { delete globalThis.__ipcWindows; });
  const ipc = await import('../packages/desktop/src/main/ipc.ts?startup-notifications');
  const { IPC_CHANNELS } = await import('../packages/shared/src/index.ts');
  const readyWindows = [];
  ipc.registerIpc({ getDialogWindow: () => owner, onRendererReady: (win) => readyWindows.push(win) });
  const eventFor = (win) => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  const ready = globalThis.__ipcHandlers.get(IPC_CHANNELS.rendererReady);
  const notify = (id) => globalThis.__ipcAgentUi.requestExtensionDialog({ id, kind: 'notify', title: id });
  const notificationIds = (win) => win.sent.filter(([channel]) => channel === IPC_CHANNELS.agentExtensionDialog).map(([, request]) => request.id);

  assert.equal(await notify('first-notice'), null, 'notification delivery does not block agent initialization');
  assert.deepEqual(first.sent, [], 'a notice cannot reach the renderer before it has subscribed');
  assert.deepEqual(readyWindows, [], 'a startup notice never requests an early reveal');
  assert.deepEqual(globalThis.__ipcHandlers.get(IPC_CHANNELS.agentExtensionDialogPending)(eventFor(first)), [],
    'the pending interactive-dialog fetch must not start hidden notification timers');

  owner = second;
  await notify('second-notice');
  ready(eventFor(second));
  assert.deepEqual(second.sent, [], 'renderer readiness alone cannot start a timer while the window is hidden');
  second.show();
  assert.deepEqual(notificationIds(second), ['second-notice']);
  assert.deepEqual(first.sent, [], 'one window becoming ready does not flush another window');
  ready(eventFor(second));
  assert.deepEqual(notificationIds(second), ['second-notice'], 'duplicate readiness cannot replay notifications');

  ready(eventFor(first));
  assert.deepEqual(first.sent, []);
  first.show();
  assert.deepEqual(notificationIds(first), ['first-notice']);
  owner = first;
  await notify('live-notice');
  assert.deepEqual(notificationIds(first), ['first-notice', 'live-notice'], 'normal notices are delivered immediately after startup');
  assert.equal(first.listenerCount('show'), 0);
  assert.equal(first.listenerCount('closed'), 0);

  owner = closing;
  await notify('closed-notice');
  closing.close();
  assert.equal(closing.listenerCount('show'), 0);
  assert.equal(closing.listenerCount('closed'), 0);
  closing.emit('show');
  assert.deepEqual(closing.sent, [], 'closing an unready window discards its startup queue');

  owner = noisy;
  noisy.show();
  for (let index = 0; index < 105; index += 1) await notify(`notice-${index}`);
  assert.deepEqual(noisy.sent, [], 'visibility without renderer readiness cannot flush notices');
  ready(eventFor(noisy));
  assert.equal(notificationIds(noisy).length, 100);
  assert.equal(notificationIds(noisy)[0], 'notice-5', 'only the latest bounded set of startup notices is retained');
  assert.equal(notificationIds(noisy).at(-1), 'notice-104');

  owner = disposing;
  await notify('shutdown-notice');
  await ipc.disposeServices();
  assert.equal(disposing.listenerCount('show'), 0);
  assert.equal(disposing.listenerCount('closed'), 0);
});

test('switching workspaces waits for in-flight crash recovery and keeps the chosen workspace', async (t) => {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, 'pi-desktop-agent-ipc-'));
  t.after(async () => {
    assert.equal(dirname(root), temp);
    await rm(root, { recursive: true, force: true });
  });
  const first = join(root, 'first');
  const second = join(root, 'second');
  await Promise.all([mkdir(first), mkdir(second)]);
  await writeFile(join(root, 'workspace.json'), JSON.stringify({ cwd: first, workspaces: [first, second] }));
  globalThis.__ipcUserData = root;
  globalThis.__ipcHandlers = new Map();
  let active = first;
  let recovering = false;
  let releaseRecovery;
  let recoveryStarted;
  const started = new Promise((resolve) => { recoveryStarted = resolve; });
  const gate = new Promise((resolve) => { releaseRecovery = resolve; });
  t.after(() => releaseRecovery());
  globalThis.__ipcAgent = {
    onEvent: () => {},
    onBackgroundActivity: () => {},
    init: async ({ cwd }) => {
      recovering = true;
      recoveryStarted();
      await gate;
      active = cwd;
      recovering = false;
    },
    switchWorkspace: async (cwd) => {
      if (recovering) throw new Error('A Pi session transition is already in progress');
      active = cwd;
    },
    getSnapshot: async () => ({ cwd: active, sessionPath: null }),
    dispose: async () => {},
  };
  const ipc = await import('../packages/desktop/src/main/ipc.ts');
  const { IPC_CHANNELS } = await import('../packages/shared/src/index.ts');
  ipc.registerIpc();
  assert.equal(ipc.defaultWorkspace(), first);
  globalThis.__ipcAgentUi.onHostCrash();
  await started;

  const main = createIpcWindow();
  globalThis.__ipcWindows = [main];
  const valid = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
  const switching = globalThis.__ipcHandlers.get(IPC_CHANNELS.workspaceSwitch)(valid, second);
  // Catch immediately so the regression can report the race without an
  // unhandled rejection while the recovery gate is held open.
  const result = switching.then(() => null, (error) => error);
  await new Promise((resolve) => setTimeout(resolve, 30));
  releaseRecovery();
  assert.equal(await result, null);
  assert.equal(active, second);
  assert.equal(ipc.defaultWorkspace(), second);
  await ipc.disposeServices();
});

test('pai IPC exposes its mode, disables background features, and recovers only its own session', async (t) => {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, 'pi-pai-ipc-'));
  const cwd = join(root, 'project');
  await mkdir(cwd);
  const main = createIpcWindow();
  globalThis.__ipcUserData = root;
  globalThis.__ipcWindows = [main];
  globalThis.__ipcHandlers = new Map();
  const calls = [];
  let agentEvent;
  let recovered;
  globalThis.__ipcAgent = {
    onEvent(listener) { agentEvent = listener; }, onBackgroundActivity() {}, async dispose() {},
    async init(options) { calls.push(options); recovered?.(); },
    async listSessions() { throw new Error('pai recovery must not search for another instance\'s session'); },
  };
  const ipc = await import('../packages/desktop/src/main/ipc.ts?pai-mode');
  const { IPC_CHANNELS: channels } = await import('../packages/shared/src/index.ts');
  t.after(async () => {
    await ipc.disposeServices();
    assert.equal(dirname(root), temp);
    await rm(root, { recursive: true, force: true });
  });
  ipc.registerIpc({ windowMode: 'pai', getDialogWindow: () => main });
  assert.equal(ipc.defaultWorkspace(cwd), cwd);
  const valid = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
  const call = (channel, ...args) => globalThis.__ipcHandlers.get(channel)(valid, ...args);
  assert.equal(call(channels.appInfo).windowMode, 'pai');
  assert.deepEqual(call(channels.updateState), { phase: 'unavailable', unavailableReason: 'unsupported', currentVersion: '0.1.7-test' });
  for (const channel of [channels.updateCheck, channels.updateInstall]) assert.throws(() => call(channel), /main Pi Desktop window/);
  for (const channel of [channels.automationSnapshot, channels.automationSave, channels.automationSetEnabled, channels.automationDelete, channels.automationRun, channels.automationCancelRun]) {
    assert.throws(() => call(channel), /main Pi Desktop window/);
  }
  call(channels.rendererReady);
  let ready = new Promise(resolve => { recovered = resolve; });
  globalThis.__ipcAgentUi.onHostCrash();
  await ready;
  assert.deepEqual(calls[0], { cwd, fresh: true }, 'an unpersisted pai session cannot adopt the latest global history');
  const ownSession = join(cwd, 'own-session.jsonl');
  agentEvent({ sequence: 1, event: { type: 'ready', cwd, sessionPath: ownSession } });
  ready = new Promise(resolve => { recovered = resolve; });
  globalThis.__ipcAgentUi.onHostCrash();
  await ready;
  assert.deepEqual(calls[1], { cwd, sessionPath: ownSession });
});

test('composer workspace selection creates a fresh session, including the first detach to home, while normal selection restores history', async (t) => {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, 'pi-desktop-fresh-workspace-'));
  const project = join(root, 'project');
  const unknown = join(root, 'unknown');
  await Promise.all([mkdir(project), mkdir(unknown)]);
  await writeFile(join(root, 'workspace.json'), JSON.stringify({ cwd: project, workspaces: [project] }));
  const main = createIpcWindow();
  globalThis.__ipcUserData = root;
  globalThis.__ipcWindows = [main];
  globalThis.__ipcHandlers = new Map();
  const calls = [];
  let snapshot = { cwd: project, sessionPath: 'project-old', messages: ['old project conversation'] };
  globalThis.__ipcAgent = {
    onEvent() {}, onBackgroundActivity() {}, async dispose() {},
    async init(options) {
      calls.push(['init', options]);
      assert.equal(options.fresh, true);
      snapshot = { cwd: options.cwd, sessionPath: `fresh-${calls.length}`, messages: [] };
    },
    async switchWorkspace(cwd) {
      calls.push(['restore', cwd]);
      snapshot = { cwd, sessionPath: `${cwd}-old`, messages: ['remembered conversation'] };
    },
    getSnapshot: async () => snapshot,
  };
  const ipc = await import('../packages/desktop/src/main/ipc.ts?fresh-workspace');
  const { IPC_CHANNELS } = await import('../packages/shared/src/index.ts');
  t.after(async () => {
    await ipc.disposeServices();
    assert.equal(dirname(root), temp);
    await rm(root, { recursive: true, force: true });
  });
  ipc.registerIpc();
  assert.equal(ipc.defaultWorkspace(), project);
  const valid = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
  const switchWorkspace = globalThis.__ipcHandlers.get(IPC_CHANNELS.workspaceSwitch);
  const home = globalThis.__ipcHandlers.get(IPC_CHANNELS.workspaceDefault)(valid);
  assert.equal(home, join(root, 'PiDesktopWorkspace'));
  assert.deepEqual(await globalThis.__ipcHandlers.get(IPC_CHANNELS.agentListWorkspaces)(valid), [project, home]);

  for (const options of [null, true, [], { fresh: 'true' }]) {
    assert.throws(() => switchWorkspace(valid, home, options), /切换选项无效/);
  }
  await assert.rejects(switchWorkspace(valid, unknown, { fresh: true }), /未知工作区/);
  assert.deepEqual(calls, [], 'invalid targets and options never activate a session');

  await switchWorkspace(valid, home, { fresh: true });
  assert.deepEqual(calls, [['init', { cwd: home, fresh: true }]]);
  assert.deepEqual(snapshot.messages, []);
  assert.equal(ipc.defaultWorkspace(), home);
  await switchWorkspace(valid, project);
  assert.deepEqual(calls.at(-1), ['restore', project]);
  assert.deepEqual(snapshot.messages, ['remembered conversation']);
  await switchWorkspace(valid, home, { fresh: false });
  assert.deepEqual(calls.at(-1), ['restore', home]);
  await switchWorkspace(valid, home, { fresh: true });
  assert.deepEqual(calls.at(-1), ['init', { cwd: home, fresh: true }]);
  assert.deepEqual(snapshot.messages, [], 'fresh selection also works in the currently active workspace');
});

test('fresh workspace initialization stays in the activation queue and a failure preserves the previous workspace', async (t) => {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, 'pi-desktop-fresh-queue-'));
  const first = join(root, 'first');
  const second = join(root, 'second');
  await Promise.all([mkdir(first), mkdir(second)]);
  await writeFile(join(root, 'workspace.json'), JSON.stringify({ cwd: first, workspaces: [first, second] }));
  const main = createIpcWindow();
  globalThis.__ipcUserData = root;
  globalThis.__ipcWindows = [main];
  globalThis.__ipcHandlers = new Map();
  const calls = [];
  let active = first;
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.__ipcAgent = {
    onEvent() {}, onBackgroundActivity() {}, async dispose() {},
    async init(options) {
      calls.push(['init', options]);
      entered();
      await gate;
      throw new Error('fresh initialization failed');
    },
    async switchWorkspace(cwd) { calls.push(['restore', cwd]); active = cwd; },
    getSnapshot: async () => ({ cwd: active, sessionPath: null }),
  };
  const ipc = await import('../packages/desktop/src/main/ipc.ts?fresh-workspace-queue');
  const { IPC_CHANNELS } = await import('../packages/shared/src/index.ts');
  t.after(async () => {
    release();
    await ipc.disposeServices();
    assert.equal(dirname(root), temp);
    await rm(root, { recursive: true, force: true });
  });
  ipc.registerIpc();
  assert.equal(ipc.defaultWorkspace(), first);
  const valid = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
  const switchWorkspace = globalThis.__ipcHandlers.get(IPC_CHANNELS.workspaceSwitch);
  const fresh = switchWorkspace(valid, second, { fresh: true });
  const failure = assert.rejects(fresh, /fresh initialization failed/);
  await started;
  const restoring = switchWorkspace(valid, first);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [['init', { cwd: second, fresh: true }]], 'the next navigation waits for fresh initialization');
  release();
  await Promise.all([failure, restoring]);
  assert.equal(active, first);
  assert.equal(ipc.defaultWorkspace(), first);
  assert.deepEqual(calls.at(-1), ['restore', first]);
  await assert.rejects(switchWorkspace(valid, second, { fresh: true }), /fresh initialization failed/);
  assert.equal(ipc.defaultWorkspace(), first, 'a failed fresh session cannot persist the target as the current workspace');
});

test('shutdown cancels extension dialogs, waits for every service, and is idempotent after failure', async (t) => {
  const main = createIpcWindow();
  globalThis.__ipcWindows = [main];
  globalThis.__ipcHandlers = new Map();
  globalThis.__ipcUserData = tmpdir();
  let closeWorkbench;
  let startedWorkbench;
  const workbenchStarted = new Promise((resolve) => { startedWorkbench = resolve; });
  const workbenchGate = new Promise((resolve) => { closeWorkbench = resolve; });
  let agentDisposals = 0;
  let workbenchDisposals = 0;
  globalThis.__ipcWorkbench = {
    reset: async () => {},
    dispose: async () => { workbenchDisposals += 1; startedWorkbench(); await workbenchGate; },
  };
  globalThis.__ipcAgent = {
    onEvent: () => {}, onBackgroundActivity: () => {},
    dispose: async () => { agentDisposals += 1; throw new Error('Agent shutdown failed'); },
  };
  t.after(() => {
    closeWorkbench();
    delete globalThis.__ipcWindows;
    delete globalThis.__ipcWorkbench;
  });
  const ipc = await import('../packages/desktop/src/main/ipc.ts?shutdown-failure');
  ipc.registerIpc({ getDialogWindow: () => main });
  const dialog = globalThis.__ipcAgentUi.requestExtensionDialog({ id: 'pending-shutdown', kind: 'confirm', title: 'Continue?' });
  let completed = false;
  const shutdown = ipc.disposeServices();
  const failure = shutdown.then(() => { completed = true; }, (error) => { completed = true; return error; });
  assert.equal(ipc.disposeServices(), shutdown);
  assert.equal(await dialog, null, 'shutdown must release initialization waiting for extension input');
  assert.equal(await globalThis.__ipcAgentUi.requestExtensionDialog({ id: 'late', kind: 'confirm', title: 'Too late' }), null);
  await workbenchStarted;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false, 'one failed service cannot skip other cleanup');
  assert.equal(main.listenerCount('closed'), 0);
  closeWorkbench();
  assert.match((await failure).message, /Agent shutdown failed/);
  assert.equal(agentDisposals, 1);
  assert.equal(workbenchDisposals, 1);
});

test('every IPC registration rejects subframes and unknown windows before performing work', async (t) => {
  const main = createIpcWindow();
  globalThis.__ipcWindows = [main];
  globalThis.__ipcHandlers = new Map();
  globalThis.__ipcUserData = tmpdir();
  globalThis.__ipcAgent = { onEvent() {}, onBackgroundActivity() {}, async dispose() {} };
  delete globalThis.__ipcWorkbench;
  const ipc = await import('../packages/desktop/src/main/ipc.ts?all-sender-guards');
  ipc.registerIpc({ getDialogWindow: () => main });
  t.after(() => ipc.disposeServices());
  assert.ok(globalThis.__ipcHandlers.size > 50);
  for (const [channel, handler] of globalThis.__ipcHandlers) {
    assert.throws(() => handler({ sender: main.webContents, senderFrame: {} }), /Invalid renderer sender/, channel);
    assert.throws(() => handler({ sender: {}, senderFrame: {} }), /no longer available/, channel);
  }
});

test('agent broadcasts survive a renderer disappearing during send and still deliver to live windows', async (t) => {
  const destroyed = createIpcWindow();
  destroyed.destroyed = true;
  const racing = createIpcWindow();
  racing.webContents.send = () => { throw new Error('Object has been destroyed'); };
  const healthy = createIpcWindow();
  globalThis.__ipcWindows = [destroyed, racing, healthy];
  globalThis.__ipcHandlers = new Map();
  globalThis.__ipcUserData = tmpdir();
  let listener;
  globalThis.__ipcAgent = { onEvent(fn) { listener = fn; }, onBackgroundActivity() {}, async dispose() {} };
  t.mock.method(console, 'error', () => {});
  const ipc = await import('../packages/desktop/src/main/ipc.ts?broadcast-race');
  const { IPC_CHANNELS } = await import('../packages/shared/src/index.ts');
  ipc.registerIpc();
  t.after(() => ipc.disposeServices());
  const event = { sequence: 1, event: { type: 'status', status: 'busy' } };
  assert.doesNotThrow(() => listener(event));
  assert.deepEqual(destroyed.sent, []);
  assert.deepEqual(healthy.sent, [[IPC_CHANNELS.agentEvent, event]]);
  assert.equal(console.error.mock.callCount(), 1);
});

test('session switches and shutdown wait for an accepted asynchronous deletion', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-ipc-delete-queue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'workspace.json'), JSON.stringify({ cwd: root, workspaces: [root] }));
  const oldPath = join(root, 'old.jsonl');
  const nextPath = join(root, 'next.jsonl');
  // A regular file used as a path segment makes the real unlink fail with ENOTDIR.
  await writeFile(join(root, 'blocked.jsonl'), 'in the way');
  const stuckPath = join(root, 'blocked.jsonl', 'old.jsonl');
  await writeFile(oldPath, 'transcript body');
  const main = createIpcWindow();
  globalThis.__ipcUserData = root;
  globalThis.__ipcWindows = [main];
  globalThis.__ipcHandlers = new Map();
  let entered;
  let release;
  let switching = false;
  let disposed = false;
  let releases = 0;
  let busy = false;
  const prepareGate = () => {
    const started = new Promise((resolve) => { entered = resolve; });
    const finished = new Promise((resolve) => { release = resolve; });
    globalThis.__ipcPrepare = async () => { entered(); await finished; };
    return started;
  };
  globalThis.__ipcAgent = {
    onEvent() {}, onBackgroundActivity() {},
    listSessions: async () => [{ path: oldPath }, { path: nextPath }, { path: stuckPath }],
    getSnapshot: async () => ({ cwd: root, sessionPath: null }),
    switchSession: async () => { switching = true; },
    prepareSessionDeletion: async () => { if (busy) throw new Error('后台会话仍在运行'); await globalThis.__ipcPrepare(); },
    releaseSessionDeletion: async () => { releases++; },
    dispose: async () => { disposed = true; },
  };
  const ipc = await import('../packages/desktop/src/main/ipc.ts?delete-queue');
  const { IPC_CHANNELS } = await import('../packages/shared/src/index.ts');
  ipc.registerIpc();
  const valid = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
  const remove = (path = oldPath) => globalThis.__ipcHandlers.get(IPC_CHANNELS.sessionDelete)(valid, path);
  let started = prepareGate();
  const firstDelete = remove();
  await started;
  const switchSession = globalThis.__ipcHandlers.get(IPC_CHANNELS.agentSwitchSession)(valid, nextPath);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(switching, false);
  release();
  await Promise.all([firstDelete, switchSession]);
  assert.equal(switching, true);
  assert.equal(releases, 1);
  assert.equal(existsSync(oldPath), false, 'deletion unlinks the transcript directly');
  assert.equal(existsSync(join(root, 'session-trash')), false, 'no app trash directory is created');

  busy = true;
  await assert.rejects(remove(), /后台会话仍在运行/);
  assert.equal(releases, 1, 'a failed prepare must not release an unrelated reservation');
  busy = false;

  started = prepareGate();
  const secondDelete = remove(nextPath);
  await started;
  const shutdown = ipc.disposeServices();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposed, false, 'host shutdown cannot interrupt the deletion');
  release();
  await Promise.all([secondDelete, shutdown]);
  assert.equal(disposed, true);
  assert.equal(releases, 2);
});

test('folder-drop IPC registers projects atomically without activating or trusting them', async (t) => {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, 'pi-ipc-workspace-drop-'));
  const active = join(root, 'active');
  const first = join(root, 'first');
  const second = join(root, 'second');
  const third = join(root, 'third');
  const file = join(root, 'readme.md');
  await Promise.all([mkdir(active), mkdir(first), mkdir(second), mkdir(third), writeFile(file, '# text')]);
  const settings = { cwd: active, workspaces: [active], pinnedWorkspaces: [active] };
  const settingsPath = join(root, 'workspace.json');
  await writeFile(settingsPath, JSON.stringify(settings));
  const main = createIpcWindow();
  globalThis.__ipcUserData = root;
  globalThis.__ipcWindows = [main];
  globalThis.__ipcHandlers = new Map();
  let switched = null;
  globalThis.__ipcAgent = {
    onEvent() {}, onBackgroundActivity() {}, async dispose() {},
    init: async () => assert.fail('adding folders cannot initialize an SDK session'),
    switchWorkspace: async (cwd) => { switched = cwd; },
    getSnapshot: async () => ({ cwd: switched ?? active, sessionPath: null }),
  };
  const ipc = await import('../packages/desktop/src/main/ipc.ts?folder-drop');
  const { IPC_CHANNELS } = await import('../packages/shared/src/index.ts');
  t.after(async () => {
    await ipc.disposeServices();
    assert.equal(dirname(root), temp);
    await rm(root, { recursive: true, force: true });
  });
  ipc.registerIpc();
  assert.equal(ipc.defaultWorkspace(), active);
  const valid = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
  const add = globalThis.__ipcHandlers.get(IPC_CHANNELS.workspaceAddDropped);
  assert.throws(() => add({ sender: main.webContents, senderFrame: {} }, [first]), /Invalid renderer sender/);
  assert.throws(() => add({ sender: {}, senderFrame: {} }, [first]), /no longer available/);
  await assert.rejects(add(valid, [first, join(root, 'missing')]), /无法读取拖入的文件夹/);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), settings, 'a failed batch cannot persist an earlier valid directory');
  assert.deepEqual(await add(valid, [file]), []);
  assert.deepEqual(await Promise.all([add(valid, [first, active, first]), add(valid, [second])]), [[first, active], [second]]);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), { ...settings, workspaces: [active, first, second], explicitWorkspaces: [first, active, second] });
  assert.equal(switched, null);
  assert.equal(ipc.defaultWorkspace(), active);
  assert.deepEqual(await add(valid, [first]), [first], 'existing projects retain their registered identity');
  await assert.rejects(globalThis.__ipcHandlers.get(IPC_CHANNELS.workspaceSwitch)(valid, third), /未知工作区/);
  await globalThis.__ipcHandlers.get(IPC_CHANNELS.workspaceSwitch)(valid, first);
  assert.equal(switched, first, 'activation still uses the ordinary workspace transition');
});

test('project creation IPC registers a Documents project without activating a session and permits later selection', async (t) => {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, 'pi-ipc-project-create-'));
  const active = join(root, 'active');
  await mkdir(active);
  const settings = { cwd: active, workspaces: [active], pinnedWorkspaces: [active] };
  const settingsPath = join(root, 'workspace.json');
  await writeFile(settingsPath, JSON.stringify(settings));
  const main = createIpcWindow();
  globalThis.__ipcUserData = root;
  globalThis.__ipcWindows = [main];
  globalThis.__ipcHandlers = new Map();
  let switched = null;
  globalThis.__ipcAgent = {
    onEvent() {}, onBackgroundActivity() {}, async dispose() {},
    init: async () => assert.fail('creating a project cannot initialize an SDK session'),
    switchWorkspace: async (cwd) => { switched = cwd; },
    getSnapshot: async () => ({ cwd: switched ?? active, sessionPath: null }),
  };
  const ipc = await import('../packages/desktop/src/main/ipc.ts?project-create');
  const { IPC_CHANNELS } = await import('../packages/shared/src/index.ts');
  t.after(async () => {
    await ipc.disposeServices();
    assert.equal(dirname(root), temp);
    await rm(root, { recursive: true, force: true });
  });
  ipc.registerIpc();
  assert.equal(ipc.defaultWorkspace(), active);
  const valid = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
  const create = globalThis.__ipcHandlers.get(IPC_CHANNELS.workspaceCreateProject);
  assert.equal(await globalThis.__ipcHandlers.get(IPC_CHANNELS.workspaceProjectsDirectory)(valid), join(root, 'Pi Desktop'));
  assert.throws(() => create({ sender: main.webContents, senderFrame: {} }, 'bad-sender'), /Invalid renderer sender/);
  await assert.rejects(create(valid, '../outside'), /项目名称/);
  const cwd = await create(valid, '项目');
  assert.equal(cwd, join(root, 'Pi Desktop', '项目'));
  assert.equal(switched, null);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), { ...settings, workspaces: [active, cwd], explicitWorkspaces: [cwd] });
  assert.ok((await globalThis.__ipcHandlers.get(IPC_CHANNELS.agentListWorkspaces)(valid)).includes(cwd));
  await assert.rejects(create(valid, '项目'), /已存在同名/);
  await globalThis.__ipcHandlers.get(IPC_CHANNELS.workspaceSwitch)(valid, cwd);
  assert.equal(switched, cwd);
});

test('the built-in workspace exposes unassigned conversations even when absent from saved projects', async (t) => {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, 'pi-ipc-unassigned-'));
  const project = join(root, 'project');
  const home = join(root, 'PiDesktopWorkspace');
  const sessionPath = join(root, 'home-session.jsonl');
  await Promise.all([mkdir(project), mkdir(home), writeFile(sessionPath, '{}\n')]);
  await writeFile(join(root, 'workspace.json'), JSON.stringify({ cwd: project, workspaces: [project] }));
  const main = createIpcWindow();
  globalThis.__ipcUserData = root;
  globalThis.__ipcWindows = [main];
  globalThis.__ipcHandlers = new Map();
  globalThis.__ipcAgent = {
    onEvent() {}, onBackgroundActivity() {}, async dispose() {},
    listSessions: async (cwd) => cwd === home ? [{ id: 'home-session', path: sessionPath }] : [],
  };
  const ipc = await import('../packages/desktop/src/main/ipc.ts?unassigned');
  const { IPC_CHANNELS } = await import('../packages/shared/src/index.ts');
  t.after(async () => {
    await ipc.disposeServices();
    assert.equal(dirname(root), temp);
    await rm(root, { recursive: true, force: true });
  });
  ipc.registerIpc();
  assert.equal(ipc.defaultWorkspace(), project);
  const valid = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
  assert.deepEqual(await globalThis.__ipcHandlers.get(IPC_CHANNELS.agentListWorkspaces)(valid), [project, home]);
  const list = globalThis.__ipcHandlers.get(IPC_CHANNELS.agentListSessions);
  assert.deepEqual(await list(valid, home), [{ id: 'home-session', path: sessionPath }]);
  await globalThis.__ipcHandlers.get(IPC_CHANNELS.agentUpdateSessionMeta)(valid, sessionPath, { pinned: true });
  assert.deepEqual(await list(valid, home), [{ id: 'home-session', path: sessionPath, pinned: true }], 'unassigned sessions retain authenticated metadata actions');
});

test('standalone conversations get independent folders and retain discoverable history after storage changes', async (t) => {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, 'pi-ipc-conversation-storage-'));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  t.after(() => { if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir; });
  const home = join(root, 'PiDesktopWorkspace');
  const project = join(home, 'my-project');
  const changedRoot = join(root, 'new-storage');
  const pickedRoot = join(root, 'picked');
  await Promise.all([mkdir(project, { recursive: true }), mkdir(pickedRoot)]);
  const settingsPath = join(root, 'workspace.json');
  await writeFile(settingsPath, JSON.stringify({ cwd: project, workspaces: [project], pinnedWorkspaces: [project] }));
  await writeFile(join(root, 'desktop-settings.json'), JSON.stringify({ notificationsEnabled: false, closeBehavior: 'quit' }));
  const main = createIpcWindow();
  globalThis.__ipcUserData = root;
  globalThis.__ipcWindows = [main];
  globalThis.__ipcHandlers = new Map();
  globalThis.__ipcOpenDialog = async (options) => {
    assert.ok(options.properties.includes('openDirectory'));
    assert.equal(options.defaultPath, home);
    return { canceled: false, filePaths: [pickedRoot] };
  };
  const initialized = [];
  let snapshot = { cwd: project, sessionPath: null };
  globalThis.__ipcAgent = {
    onEvent() {}, onBackgroundActivity() {}, async dispose() {},
    async init(options) {
      assert.equal(options.fresh, true);
      assert.equal((await stat(options.cwd)).isDirectory(), true);
      initialized.push(options.cwd);
      snapshot = { cwd: options.cwd, sessionPath: join(options.cwd, `session-${initialized.length}.jsonl`) };
    },
    async switchWorkspace(cwd) { snapshot = { cwd, sessionPath: null }; },
    async forgetWorkspace() {},
    getSnapshot: async () => snapshot,
    listSessions: async (cwd) => initialized.includes(cwd) ? [{ id: cwd, path: `${cwd}.jsonl` }] : [],
  };
  const ipc = await import('../packages/desktop/src/main/ipc.ts?conversation-storage');
  const { IPC_CHANNELS, INPUT_FEATURE_CHANNELS } = await import('../packages/shared/src/index.ts');
  t.after(async () => {
    await ipc.disposeServices();
    delete globalThis.__ipcOpenDialog;
    assert.equal(dirname(root), temp);
    await rm(root, { recursive: true, force: true });
  });
  ipc.registerIpc();
  assert.equal(ipc.defaultWorkspace(), project);
  const valid = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
  const call = (channel, ...args) => globalThis.__ipcHandlers.get(channel)(valid, ...args);
  assert.equal(call(IPC_CHANNELS.desktopSettingsGet).conversationStorageDirectory, home);
  const beforePick = await readFile(settingsPath, 'utf8');
  assert.equal(await call(IPC_CHANNELS.conversationStoragePick), pickedRoot);
  assert.equal(await readFile(settingsPath, 'utf8'), beforePick, 'storage picker cannot register a project');
  for (const options of [null, true, [], { cwd: 1 }]) assert.throws(() => call(IPC_CHANNELS.agentNewSession, options), /新对话选项无效/);
  await assert.rejects(call(IPC_CHANNELS.agentNewSession, { cwd: pickedRoot }), /未知工作区/);

  const firstScope = await call(IPC_CHANNELS.agentNewSession);
  const first = initialized[0];
  assert.equal(dirname(first), home);
  assert.deepEqual(firstScope, { cwd: first, sessionPath: join(first, 'session-1.jsonl') });
  await writeFile(join(first, 'keep.txt'), 'user-created content');
  const parallelScopes = await Promise.all([call(IPC_CHANNELS.agentNewSession), call(IPC_CHANNELS.agentNewSession)]);
  assert.equal(new Set(initialized).size, 3, 'parallel requests reserve different directories');
  assert.deepEqual(parallelScopes, initialized.slice(1).map((cwd, index) => ({ cwd, sessionPath: join(cwd, `session-${index + 2}.jsonl`) })),
    'each RPC captures its created scope before the next queued activation');
  assert.ok(initialized.every(cwd => dirname(cwd) === home));
  assert.equal(await readFile(join(first, 'keep.txt'), 'utf8'), 'user-created content');
  const deferredDraft = call(INPUT_FEATURE_CHANNELS.saveInputDraft, { ...firstScope, text: 'Typed before navigating away', attachmentIds: [], expectedVersion: 0 });
  assert.equal(deferredDraft.text, 'Typed before navigating away', 'created scopes allow deferred draft persistence after another conversation activates');
  assert.equal(call(INPUT_FEATURE_CHANNELS.getInputDraft, firstScope).text, deferredDraft.text);
  assert.throws(() => call(INPUT_FEATURE_CHANNELS.saveInputDraft, { ...firstScope, sessionPath: join(first, 'uncreated.jsonl'), text: 'wrong scope', attachmentIds: [], expectedVersion: 0 }), /会话已变化/,
    'scope handoff does not authorize arbitrary session paths');

  for (const invalid of ['', 'relative-folder', 123, 'C:\0bad']) {
    await assert.rejects(call(IPC_CHANNELS.desktopSettingsSet, { conversationStorageDirectory: invalid }), /绝对文件夹路径/);
  }
  const file = join(root, 'file.txt');
  await writeFile(file, 'untouched');
  await assert.rejects(call(IPC_CHANNELS.desktopSettingsSet, { conversationStorageDirectory: file }));
  assert.equal(call(IPC_CHANNELS.desktopSettingsGet).conversationStorageDirectory, home);
  const changed = await call(IPC_CHANNELS.desktopSettingsSet, { conversationStorageDirectory: changedRoot });
  assert.equal(changed.conversationStorageDirectory, changedRoot);
  assert.equal(changed.notificationsEnabled, false);
  assert.equal(changed.closeBehavior, 'quit');
  assert.equal(call(IPC_CHANNELS.workspaceDefault), changedRoot);
  await call(IPC_CHANNELS.agentNewSession);
  assert.equal(dirname(initialized.at(-1)), changedRoot);
  const automatic = [...initialized];
  const internal = await call(IPC_CHANNELS.workspaceListConversations);
  assert.ok(automatic.every(cwd => internal.includes(cwd)));
  assert.ok(internal.includes(home) && internal.includes(changedRoot));
  assert.equal(internal.includes(project), false, 'an explicit project inside a storage root is still a project');
  assert.equal(await ipc.isConversationWorkspace(first), true);
  assert.equal(await ipc.isConversationWorkspace(project), false);
  assert.ok((await call(IPC_CHANNELS.agentListWorkspaces)).includes(first));
  assert.deepEqual(await call(IPC_CHANNELS.agentListSessions, first), [{ id: first, path: `${first}.jsonl` }]);
  await call(IPC_CHANNELS.workspaceSwitch, first);
  assert.equal(snapshot.cwd, first, 'old storage locations remain authorized after a setting change');

  const projectScope = await call(IPC_CHANNELS.agentNewSession, { cwd: project });
  assert.equal(initialized.at(-1), project);
  assert.deepEqual(projectScope, { cwd: project, sessionPath: join(project, `session-${initialized.length}.jsonl`) });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')).conversationWorkspaces, automatic);
  await call(IPC_CHANNELS.desktopSettingsSet, { conversationStorageDirectory: project });
  assert.equal((await call(IPC_CHANNELS.workspaceListConversations)).includes(project), false,
    'choosing an already registered project as storage cannot silently hide that project');
  await call(IPC_CHANNELS.workspaceAddDropped, [home]);
  assert.equal((await call(IPC_CHANNELS.workspaceListConversations)).includes(home), false,
    'explicitly adding a storage root as a project preserves that deliberate choice');
  await call(IPC_CHANNELS.workspaceSetPinned, []);
  await call(IPC_CHANNELS.workspaceSwitch, automatic.at(-1));
  await call(IPC_CHANNELS.workspaceRemove, project);
  const persisted = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.deepEqual(persisted.conversationWorkspaces, automatic, 'normal workspace writes preserve internal metadata');
  assert.ok(persisted.conversationStorageDirectories.includes(home));
  assert.equal(ipc.defaultWorkspace(), automatic.at(-1), 'startup restores the previous conversation folder');
});

test('first launch creates a private conversation directory and failed initialization preserves existing files', async (t) => {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, 'pi-ipc-conversation-startup-'));
  const main = createIpcWindow();
  globalThis.__ipcUserData = root;
  globalThis.__ipcWindows = [main];
  globalThis.__ipcHandlers = new Map();
  let failedDirectory;
  globalThis.__ipcAgent = {
    onEvent() {}, onBackgroundActivity() {}, async dispose() {},
    async init({ cwd }) { failedDirectory = cwd; await writeFile(join(cwd, 'extension-output.txt'), 'preserve me'); throw new Error('extension initialization failed'); },
  };
  const ipc = await import('../packages/desktop/src/main/ipc.ts?conversation-startup');
  const { IPC_CHANNELS } = await import('../packages/shared/src/index.ts');
  t.after(async () => {
    await ipc.disposeServices();
    assert.equal(dirname(root), temp);
    await rm(root, { recursive: true, force: true });
  });
  ipc.registerIpc();
  const initial = ipc.defaultWorkspace();
  assert.equal(dirname(initial), join(root, 'PiDesktopWorkspace'));
  assert.equal((await stat(initial)).isDirectory(), true);
  const valid = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
  await assert.rejects(globalThis.__ipcHandlers.get(IPC_CHANNELS.agentNewSession)(valid), /initialization failed/);
  assert.notEqual(failedDirectory, initial);
  assert.equal(await readFile(join(failedDirectory, 'extension-output.txt'), 'utf8'), 'preserve me');
  const persisted = JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8'));
  assert.equal(persisted.cwd, initial, 'failed activation does not replace startup restore target');
  assert.ok(persisted.conversationWorkspaces.includes(failedDirectory), 'files from failed extensions remain registered and recoverable');
});

test('unread settles stamp a rising watermark and clears only against the matching version', async (t) => {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, 'pi-ipc-unread-cas-'));
  const project = join(root, 'project');
  const home = join(root, 'PiDesktopWorkspace');
  const sessionPath = join(root, 'home-session.jsonl');
  await Promise.all([mkdir(project), mkdir(home), writeFile(sessionPath, '{}\n')]);
  await writeFile(join(root, 'workspace.json'), JSON.stringify({ cwd: project, workspaces: [project] }));
  let backgroundActivity = null;
  let activeSession = null;
  const main = createIpcWindow();
  globalThis.__ipcUserData = root;
  globalThis.__ipcWindows = [main];
  globalThis.__ipcHandlers = new Map();
  globalThis.__ipcAgent = {
    onEvent() {},
    onBackgroundActivity(callback) { backgroundActivity = callback; },
    async dispose() {},
    getSnapshot: async () => ({ sessionPath: activeSession }),
    listSessions: async (cwd) => cwd === home ? [{ id: 'home-session', path: sessionPath }] : [],
  };
  const ipc = await import('../packages/desktop/src/main/ipc.ts?unread-cas');
  const { IPC_CHANNELS } = await import('../packages/shared/src/index.ts');
  t.after(async () => {
    await ipc.disposeServices();
    assert.equal(dirname(root), temp);
    await rm(root, { recursive: true, force: true });
  });
  ipc.registerIpc();
  const valid = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
  const listRow = async () => (await globalThis.__ipcHandlers.get(IPC_CHANNELS.agentListSessions)(valid, home))[0];
  const updateMeta = (patch) => globalThis.__ipcHandlers.get(IPC_CHANNELS.agentUpdateSessionMeta)(valid, sessionPath, patch);

  // First settle lights the dot and stamps a watermark (zcode unread_at).
  await backgroundActivity(null, sessionPath);
  const first = await listRow();
  assert.equal(first.unread, true);
  assert.equal(typeof first.unreadAt, 'number', 'settle stamps a numeric watermark');

  // A second settle re-stamps strictly higher even within the same millisecond
  // (zcode last_unread_at + 1 watermark semantics).
  await backgroundActivity(null, sessionPath);
  const second = await listRow();
  assert.ok(second.unreadAt > first.unreadAt, 'watermark strictly increases per settle');

  // A stale CAS clear — the watermark the renderer saw is older than the
  // persisted one — misses and leaves the newer dot in place (zcode
  // clearTaskUnreadIfMatches inside one serialized transaction).
  await updateMeta({ unread: false, expectedUnreadAt: first.unreadAt });
  const blocked = await listRow();
  assert.equal(blocked.unread, true, 'stale clear is rejected');
  assert.equal(blocked.unreadAt, second.unreadAt, 'rejected clear keeps the newer watermark');

  // A CAS clear carrying the current watermark clears and drops the stamp.
  await updateMeta({ unread: false, expectedUnreadAt: second.unreadAt });
  const cleared = await listRow();
  assert.notEqual(cleared.unread, true);
  assert.equal(cleared.unreadAt, undefined, 'successful clear drops the watermark');

  // Compat: a plain clear without an expectation still clears unconditionally,
  // and a settle for the currently open session is suppressed outright so a
  // queued background settle cannot re-light a dot on the viewed conversation.
  await backgroundActivity(null, sessionPath);
  assert.equal((await listRow()).unread, true);
  await updateMeta({ unread: false });
  assert.notEqual((await listRow()).unread, true);
  activeSession = sessionPath;
  await backgroundActivity(null, sessionPath);
  assert.notEqual((await listRow()).unread, true, 'settle for the open session never lights the dot');
});
