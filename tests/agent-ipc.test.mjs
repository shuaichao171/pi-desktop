import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const stubs = {
  electron: `
    export const app = { getPath: () => globalThis.__ipcUserData };
    export const Menu = { buildFromTemplate: () => ({}) };
    export const nativeImage = { createFromPath: () => ({ isEmpty: () => true }) };
    export const Tray = class {};
    export const BrowserWindow = {
      getAllWindows: () => globalThis.__ipcWindows ?? [],
      fromWebContents: (sender) => globalThis.__ipcWindows?.find((win) => win.webContents === sender),
    };
    export const dialog = { showErrorBox: () => {} };
    export const ipcMain = { handle: (channel, handler) => globalThis.__ipcHandlers.set(channel, handler) };
  `,
  './agentClient': `
    export function createIsolatedAgentService(ui) {
      globalThis.__ipcAgentUi = ui;
      return globalThis.__ipcAgent;
    }
  `,
  './updateService': 'export const updateService = {};',
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
  assert.throws(() => ready({ sender: main.webContents, senderFrame: {} }), /Invalid renderer-ready sender/);
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

  const switching = globalThis.__ipcHandlers.get(IPC_CHANNELS.workspaceSwitch)({}, second);
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
