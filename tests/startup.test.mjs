import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

let harnessId = 0;
const stubs = {
  electron: `
    const env = globalThis.__startupTest;
    export const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } = env;
  `,
  './ipc': `
    const env = globalThis.__startupTest;
    export const { agentService, updateService, registerIpc, defaultWorkspace, disposeServices } = env;
  `,
  './appLocale': `export const getAppLocale = () => 'en-US';`,
  './splash': `
    export const createSplashHtml = () => '<html>Splash</html>';
    export const createSplashErrorHtml = (message) => '<html>' + message + '</html>';
  `,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (stubs[specifier]) {
      return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}#${harnessId}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

async function settle() {
  // Native module imports can cross event-loop turns; this does not advance
  // the fake startup timers controlled by each test.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function createStartupHarness(t, { workspaceError, initialization = deferred(), shutdown = async () => {} } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const windows = [];
  const calls = { init: [], startUpdates: 0, dispose: 0, quit: 0, errors: [], logs: [], registered: 0 };
  t.mock.method(console, 'error', (...args) => calls.logs.push(args));
  let rendererReady;
  let getDialogWindow;
  let beforeInstall;
  class TestWindow extends EventEmitter {
    static getAllWindows() { return windows.filter((win) => !win.destroyed); }
    static getFocusedWindow() { return TestWindow.getAllWindows().find((win) => win.visible) ?? null; }
    static fromWebContents(contents) { return windows.find((win) => win.webContents === contents); }
    constructor(options) {
      super();
      this.options = options;
      this.visible = false;
      this.destroyed = false;
      this.showCount = 0;
      this.load = deferred();
      this.webContents = Object.assign(new EventEmitter(), {
        isDestroyed: () => this.destroyed,
        send: () => {},
        setBackgroundThrottling: (value) => { this.backgroundThrottling = value; },
        setWindowOpenHandler: () => {},
        getURL: () => this.url ?? '',
      });
      windows.push(this);
    }
    loadURL(url) { this.url = url; return this.options.transparent ? Promise.resolve() : this.load.promise; }
    loadFile(path) { this.url = path; return this.load.promise; }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isMinimized() { return false; }
    isMaximized() { return false; }
    show() { assert.equal(this.destroyed, false); this.visible = true; this.showCount += 1; }
    close() { this.destroy(); }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.visible = false; this.emit('closed'); }
    setSize() {}
    center() {}
    focus() {}
    reload() {}
  }
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    setAppUserModelId: () => {},
    quit: () => { calls.quit += 1; },
  });
  const ipcMain = Object.assign(new EventEmitter(), {
    handle: (channel, handler) => ipcMain.handlers.set(channel, handler),
    removeHandler: (channel) => ipcMain.handlers.delete(channel),
    handlers: new Map(),
  });
  globalThis.__startupTest = {
    app,
    BrowserWindow: TestWindow,
    ipcMain,
    dialog: {
      showErrorBox: (...args) => calls.errors.push(args),
      showMessageBox: (...args) => { calls.errors.push(args); return Promise.resolve({ response: 0 }); },
    },
    Menu: { setApplicationMenu: () => {} },
    session: { defaultSession: { setPermissionRequestHandler: () => {} } },
    shell: { openExternal: async () => {} },
    registerIpc: (options) => {
      calls.registered += 1;
      rendererReady = options?.onRendererReady;
      getDialogWindow = options?.getDialogWindow;
    },
    defaultWorkspace: () => { if (workspaceError) throw workspaceError; return process.cwd(); },
    disposeServices: async () => { calls.dispose += 1; await shutdown(); },
    agentService: { init: (...args) => { calls.init.push(args); return initialization.promise; } },
    updateService: {
      setBeforeInstall: (callback) => { beforeInstall = callback; },
      start: () => { calls.startUpdates += 1; },
      stop: () => {},
    },
  };
  harnessId += 1;
  t.after(() => { t.mock.timers.reset(); delete globalThis.__startupTest; });
  await import(`../packages/desktop/src/main/index.ts?startup-test=${harnessId}`);
  await settle();
  const splash = windows[0];
  assert.ok(splash.options.transparent, 'the first window is the splash');
  return {
    app, windows, splash, calls, initialization, ipcMain,
    getDialogWindow: () => getDialogWindow?.(),
    prepareInstall: () => beforeInstall(),
    async start() {
      splash.emit('ready-to-show');
      t.mock.timers.tick(100);
      await settle();
      return windows[1];
    },
    async rendererReady(win) {
      assert.equal(typeof rendererReady, 'function', 'startup installs the renderer-ready callback');
      rendererReady(win);
      await settle();
    },
  };
}

test('startup restores the agent in parallel and keeps the splash until the renderer commits the session', async (t) => {
  const harness = await createStartupHarness(t);
  const main = await harness.start();
  assert.equal(harness.calls.init.length, 1, 'agent initialization starts before the main window is shown');
  main.load.resolve();
  main.emit('ready-to-show');
  await settle();
  assert.equal(main.showCount, 0, 'a painted empty shell must stay hidden');
  assert.equal(main.options.webPreferences.backgroundThrottling, false, 'the hidden renderer can paint restored history');
  assert.equal(harness.splash.isVisible(), true);
  assert.equal(harness.getDialogWindow(), main, 'startup extension dialogs belong to the hidden main window even while splash has focus');
  harness.initialization.resolve();
  await settle();
  assert.equal(main.showCount, 0, 'the host finishing is not proof the restored conversation is painted');
  await harness.rendererReady(main);
  assert.equal(main.showCount, 1);
  assert.equal(harness.splash.isDestroyed(), true);
  assert.equal(main.backgroundThrottling, true, 'normal background throttling is restored after revealing');
  assert.equal(harness.calls.startUpdates, 1);
  await harness.rendererReady(main);
  assert.equal(main.showCount, 1, 'duplicate ready notifications do not reveal or restart services twice');
});

test('renderer readiness only reveals its own main window after load and first paint', async (t) => {
  const harness = await createStartupHarness(t);
  const main = await harness.start();
  await harness.rendererReady(harness.splash);
  main.emit('ready-to-show');
  main.load.resolve();
  await settle();
  assert.equal(main.showCount, 0, 'a different renderer cannot release the startup gate');
  await harness.rendererReady(main);
  assert.equal(main.showCount, 1);
});

test('renderer readiness arriving before first paint waits for both paint and load', async (t) => {
  const harness = await createStartupHarness(t);
  const main = await harness.start();
  await harness.rendererReady(main);
  assert.equal(main.showCount, 0);
  main.emit('ready-to-show');
  assert.equal(main.showCount, 0);
  main.load.resolve();
  await settle();
  assert.equal(main.showCount, 1);
});

test('closing the splash before bootstrap cancels initialization', async (t) => {
  const harness = await createStartupHarness(t);
  harness.splash.emit('ready-to-show');
  harness.splash.close();
  t.mock.timers.tick(1_000);
  await settle();
  assert.equal(harness.calls.quit, 1);
  assert.equal(harness.calls.registered, 0);
  assert.equal(harness.calls.init.length, 0);
  assert.equal(harness.windows.length, 1);
});

test('closing a hidden main window prevents a late ready notification from revealing it', async (t) => {
  const harness = await createStartupHarness(t);
  const main = await harness.start();
  main.close();
  main.load.resolve();
  main.emit('ready-to-show');
  await harness.rendererReady(main);
  assert.equal(main.showCount, 0);
});

test('closing the splash while the agent starts blocks late main-window readiness', async (t) => {
  const harness = await createStartupHarness(t);
  const main = await harness.start();
  harness.splash.close();
  main.load.resolve();
  main.emit('ready-to-show');
  await harness.rendererReady(main);
  assert.equal(main.showCount, 0);
  assert.equal(harness.calls.quit, 1);
});

test('workspace setup failure reports an error instead of leaving the startup logo waiting', async (t) => {
  const harness = await createStartupHarness(t, { workspaceError: new Error('Workspace is inaccessible') });
  await harness.start();
  await settle();
  assert.equal(harness.calls.init.length, 0);
  assert.match(harness.splash.url, /Workspace%20is%20inaccessible/);
  assert.equal(harness.calls.errors.length, 1, 'the startup failure reaches a user-visible error dialog');
});

test('agent initialization failure closes the hidden shell and reports the startup error', async (t) => {
  const harness = await createStartupHarness(t);
  const main = await harness.start();
  main.emit('ready-to-show');
  main.load.resolve();
  harness.initialization.reject(new Error('Failed to restore the last conversation'));
  await settle();
  assert.equal(main.isDestroyed(), true);
  assert.equal(main.showCount, 0);
  assert.match(harness.splash.url, /Failed%20to%20restore%20the%20last%20conversation/);
  assert.equal(harness.calls.errors.length, 1);
});

test('update preparation propagates shutdown failures instead of allowing installation', async (t) => {
  const harness = await createStartupHarness(t, { shutdown: async () => { throw new Error('Could not save final state'); } });
  const main = await harness.start();
  main.load.resolve();
  main.emit('ready-to-show');
  harness.initialization.resolve();
  await harness.rendererReady(main);
  await assert.rejects(harness.prepareInstall(), /Could not save final state/);
  assert.equal(harness.calls.dispose, 1);
  let prevented = false;
  harness.app.emit('before-quit', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'failed preparation must not set the ready-to-quit flag');
  await settle();
});
