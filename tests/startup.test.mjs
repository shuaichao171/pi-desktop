import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

let harnessId = 0;
const stubs = {
  './diagnostics.ts': `export const initializeDiagnostics=()=>({}); export const recordDiagnostic=(event)=>{ globalThis.__startupTest.calls.diagnostics.push(event); };`,
  electron: `
    const env = globalThis.__startupTest;
    export const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } = env;
    export const nativeImage = { createFromPath: () => ({ isEmpty: () => false }) };
    export const nativeTheme = { shouldUseDarkColors: env.prefersDark ?? true };
  `,
  './ipc': `
    const env = globalThis.__startupTest;
    export const { agentService, updateService, registerIpc, defaultWorkspaceAsync, disposeServices, readCurrentDesktopSettings, isAgentWorkActive, saveCloseChoice, sendAppCommand, openPaiWindow } = env;
  `,
  './appLocale': `export const getAppLocale = () => 'en-US';`,
  './tray': `export const appIconPath = () => ''; export const createAppTray = (options) => { globalThis.__startupTest.calls.trays += 1; globalThis.__startupTest.calls.trayOptions = options; }; export const destroyAppTray = () => {};`,
  './windowState': `
    export const MAIN_WINDOW_MIN_WIDTH = 680;
    export const MAIN_WINDOW_MIN_HEIGHT = 520;
    export const resolveStartupWindowState = (_path, _environment, preloaded) => { globalThis.__startupTest.calls.windowStatePreloaded = preloaded; return { bounds: { x: 40, y: 30, width: 1280, height: 820 }, maximized: false }; };
    export const readWindowStateAsync = async () => globalThis.__startupTest.savedWindowState ?? null;
    export const windowStateFromWindow = () => ({ bounds: { x: 40, y: 30, width: 1280, height: 820 }, maximized: false });
    export const windowStatePath = (dir) => dir + '/window-state.json';
    export const trackWindowState = () => {};
  `,
  './splash': `
    export const createBootHtml = () => '<html>Boot</html>';
    export const createBootErrorHtml = (message) => '<html>' + message + '</html>';
  `,
  './paiPipe.ts': `
    export const paiPipeName = () => 'pi-desktop-pai-test';
    export const startPaiPipeServer = () => { globalThis.__startupTest.calls.pipeStarts += 1; return { stop() {} } };
  `,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (stubs[specifier]) {
      return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}#${harnessId}`, shortCircuit: true };
    }
    // Real modules behind the stubs (appearance, state files, startup helpers)
    // use extensionless relative imports; resolve them the way the other
    // harnesses do so the real module graph can load under this stub set.
    if (specifier.startsWith('./') && context.parentURL && new URL(context.parentURL).pathname.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
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
  // Native module imports and threadpool stat calls can cross several event-loop
  // turns; this advances real I/O without touching the fake startup timers
  // controlled by each test.
  for (let i = 0; i < 25; i++) await new Promise((resolve) => setImmediate(resolve));
}

// The startup path performs real threadpool I/O (appearance/state prefetch,
// workspace stat) whose latency a fixed setImmediate budget cannot bound on
// loaded CI runners. Wait on a condition against a wall-clock deadline
// instead; the fake timers only replace setTimeout, so performance.now and
// setImmediate stay real and each round still yields to pending I/O.
async function waitFor(condition, label) {
  const deadline = performance.now() + 10_000;
  while (!condition()) {
    if (performance.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function createStartupHarness(t, { workspaceError, workspace, initialization = deferred(), shutdown = async () => {}, closeBehavior = 'quit', confirmBusyClose = true, busy = false, closeChoice = 1, checkboxChecked = false, launchArgs, userData = 'test-user-data', startupLog, prefersDark = true, expectedSplashBackground } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const windows = [];
  const calls = { init: [], startUpdates: 0, dispose: 0, quit: 0, errors: [], logs: [], consoleLogs: [], diagnostics: [], registered: 0, trays: 0, trayOptions: null, appCommands: [], singleInstanceLocks: 0, paths: {}, windowMode: null, messageBoxes: [], closeChoices: [], paiWindows: [], pipeStarts: 0, workspaces: 0 };
  const desktopSettingsState = { notificationsEnabled: true, closeBehavior, confirmBusyClose };
  t.mock.method(console, 'error', (...args) => calls.logs.push(args));
  t.mock.method(console, 'log', (...args) => calls.consoleLogs.push(args));
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
      this.focusCount = 0;
      this.minimized = false;
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
    // Only the splash loads data: URLs, which settle immediately in Chromium;
    // real page loads stay deferred so tests can control the reveal timing.
    loadURL(url) { this.url = url; return Promise.resolve(); }
    loadFile(path, options) { this.url = path; this.query = options?.query; return this.load.promise; }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    isMaximized() { return false; }
    show() { assert.equal(this.destroyed, false); this.visible = true; this.showCount += 1; this.emit('show'); }
    hide() { this.visible = false; }
    restore() { this.minimized = false; }
    close() { this.destroy(); }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.visible = false; this.emit('closed'); }
    setSize() {}
    getBounds() { return { x: this.options.x ?? 0, y: this.options.y ?? 0, width: this.options.width, height: this.options.height }; }
    setPosition(x, y) { this.options.x = x; this.options.y = y; }
    maximize() { this.maximized = true; }
    center() {}
    focus() { this.focusCount += 1; }
    reload() {}
  }
  const app = Object.assign(new EventEmitter(), {
    getPath: (name) => calls.paths[name] ?? userData,
    setPath: (name, value) => { calls.paths[name] = value; },
    isPackaged: true,
    requestSingleInstanceLock: () => { calls.singleInstanceLocks += 1; return true; },
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
    calls,
    app,
    prefersDark,
    BrowserWindow: TestWindow,
    ipcMain,
    dialog: {
      showErrorBox: (...args) => calls.errors.push(args),
      showMessageBox: (...args) => { calls.errors.push(args); calls.messageBoxes.push(args); return Promise.resolve({ response: closeChoice, checkboxChecked }); },
    },
    Menu: { setApplicationMenu: () => {} },
    session: { defaultSession: { setPermissionRequestHandler: () => {} } },
    shell: { openExternal: async () => {} },
    registerIpc: (options) => {
      calls.registered += 1;
      calls.windowMode = options?.windowMode;
      rendererReady = options?.onRendererReady;
      getDialogWindow = options?.getDialogWindow;
    },
    defaultWorkspaceAsync: async (initial) => {
      calls.workspaces += 1;
      if (workspaceError) throw workspaceError;
      if (workspace) { const cwd = await workspace.promise; return initial ?? cwd; }
      return initial ?? process.cwd();
    },
    disposeServices: async () => { calls.dispose += 1; await shutdown(); },
    readCurrentDesktopSettings: () => ({ ...desktopSettingsState }),
    isAgentWorkActive: async () => busy,
    // Mirrors ipc.saveCloseChoice: the behavior remembered in the dialog is what Settings then shows.
    saveCloseChoice: async (behavior) => { calls.closeChoices.push(behavior); Object.assign(desktopSettingsState, { closeBehavior: behavior, confirmBusyClose: false }); },
    sendAppCommand: (command) => calls.appCommands.push(command),
    openPaiWindow: (request) => { calls.paiWindows.push(request); },
    agentService: { init: (...args) => { calls.init.push(args); return initialization.promise; } },
    updateService: {
      setBeforeInstall: (callback) => { beforeInstall = callback; },
      start: () => { calls.startUpdates += 1; },
      stop: () => {},
    },
  };
  harnessId += 1;
  t.after(() => { t.mock.timers.reset(); delete globalThis.__startupTest; });
  const originalArgv = process.argv;
  const originalStartupLog = process.env.PI_STARTUP_LOG;
  const originalExitListeners = new Set(process.listeners('exit'));
  if (startupLog !== undefined) process.env.PI_STARTUP_LOG = startupLog;
  try {
    if (launchArgs) process.argv = [process.execPath, ...launchArgs];
    await import(`../packages/desktop/src/main/index.ts?startup-test=${harnessId}`);
  } finally {
    process.argv = originalArgv;
    if (startupLog !== undefined) {
      if (originalStartupLog === undefined) delete process.env.PI_STARTUP_LOG;
      else process.env.PI_STARTUP_LOG = originalStartupLog;
    }
    const ownedExitListeners = process.listeners('exit').filter(listener => !originalExitListeners.has(listener));
    t.after(() => { for (const listener of ownedExitListeners) { process.removeListener('exit', listener); listener(); } });
  }
  await settle();
  // The splash appears only after the real state prefetch resolves; on a busy
  // runner that I/O can outlast settle()'s fixed budget (the historical flake).
  await waitFor(() => windows.length > 0, 'the boot splash to be created');
  const splash = windows[0];
  assert.equal(splash.options.backgroundColor, expectedSplashBackground ?? (prefersDark === false ? '#f8f8f8' : '#161616'), 'the boot splash follows the resolved window theme');
  assert.equal(splash.options.width, 1280, 'the boot splash matches the main window size');
  assert.equal(splash.options.transparent, undefined, 'the boot splash is opaque');
  return {
    app, windows, splash, calls, initialization, ipcMain,
    getDialogWindow: () => getDialogWindow?.(),
    prepareInstall: () => beforeInstall(),
    async start() {
      splash.emit('ready-to-show');
      t.mock.timers.tick(100);
      // The main window comes from the bootstrap that the 100ms fake timer
      // starts; its module compilation crosses many real event-loop turns.
      await waitFor(() => windows.length > 1, 'the main window to be created');
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
  // init fires only after the real workspace stat resolves.
  await waitFor(() => harness.calls.init.length === 1, 'the agent boot to start');
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

test('tray settings requested during startup open once the renderer is ready', { skip: process.platform !== 'win32' }, async (t) => {
  const harness = await createStartupHarness(t);
  harness.calls.trayOptions.onOpenSettings();
  assert.deepEqual(harness.calls.appCommands, [], 'the request is retained before the IPC bridge loads');
  const main = await harness.start();
  harness.calls.trayOptions.onOpenSettings();
  main.load.resolve();
  main.emit('ready-to-show');
  harness.initialization.resolve();
  await settle();
  assert.equal(main.showCount, 0, 'opening settings must not bypass the startup reveal gate');
  assert.deepEqual(harness.calls.appCommands, []);
  await harness.rendererReady(main);
  assert.deepEqual(harness.calls.appCommands, [{ type: 'open-settings' }]);
  await harness.rendererReady(main);
  assert.equal(harness.calls.appCommands.length, 1, 'duplicate clicks or readiness notifications do not reopen settings');
});

test('tray settings restore a hidden or minimized window before opening settings', { skip: process.platform !== 'win32' }, async (t) => {
  const harness = await createStartupHarness(t, { closeBehavior: 'tray' });
  const main = await harness.start();
  main.load.resolve();
  main.emit('ready-to-show');
  harness.initialization.resolve();
  await harness.rendererReady(main);
  main.emit('close', { preventDefault() {} });
  await settle();
  assert.equal(main.isVisible(), false);
  assert.equal(main.isDestroyed(), false);
  harness.calls.trayOptions.onOpenSettings();
  assert.equal(main.isVisible(), true);
  assert.equal(main.focusCount, 1);
  assert.deepEqual(harness.calls.appCommands, [{ type: 'open-settings' }]);
  main.minimized = true;
  harness.calls.trayOptions.onOpenSettings();
  assert.equal(main.isMinimized(), false);
  assert.equal(main.focusCount, 2);
  assert.equal(harness.calls.appCommands.length, 2);
});

test('cold pai boot joins the main instance and hands its window request to IPC', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-pai-startup-'));
  const cwd = join(root, 'project');
  await mkdir(cwd);
  const harness = await createStartupHarness(t, { launchArgs: ['--pai', '--cwd', cwd], userData: root, closeBehavior: 'tray' });
  t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 4 }); });
  const main = await harness.start();
  // The process boots as the main instance: default workspace, singleton, tray, updater.
  await waitFor(() => harness.calls.init.length === 1, 'the agent boot to start');
  assert.deepEqual(harness.calls.init, [[{ cwd: process.cwd() }]], 'the main agent keeps the default workspace');
  assert.equal(harness.calls.windowMode, 'full');
  assert.equal(harness.calls.singleInstanceLocks, 1, 'a cold pai boot contends for the singleton like a normal launch');
  assert.equal(harness.calls.trays, process.platform === 'win32' ? 1 : 0);
  assert.equal(harness.calls.startUpdates, 1);
  assert.equal(harness.calls.paths.userData, undefined, 'no isolated pai profile is reserved anymore');
  assert.equal(harness.calls.pipeStarts, process.platform === 'win32' ? 1 : 0, 'the pai pipe server starts with the main instance');
  // The pai request is handed to the IPC bridge, which opens a hosted window.
  assert.deepEqual(harness.calls.paiWindows, [{ cwd }]);
  main.load.resolve(); main.emit('ready-to-show'); harness.initialization.resolve();
  await harness.rendererReady(main);
  // Later pai spawns reach the running instance through the second-instance handoff.
  harness.app.emit('second-instance', undefined, ['pi.exe', '--pai', '--cwd', cwd]);
  await settle(); await settle();
  assert.deepEqual(harness.calls.paiWindows, [{ cwd }, { cwd }]);
  // A plain second launch reveals the main window instead.
  main.hide();
  harness.app.emit('second-instance', undefined, ['pi.exe']);
  await settle(); await settle();
  assert.equal(main.isVisible(), true);
  // The full-window close policy still applies (tray here), and shutdown disposes once.
  let prevented = false;
  main.emit('close', { preventDefault() { prevented = true; } });
  await settle();
  assert.equal(prevented, true);
  assert.equal(harness.calls.quit, 0, 'closing the main window follows the tray policy');
  harness.app.emit('before-quit', { preventDefault() {} });
  await settle();
  assert.equal(harness.calls.dispose, 1);
  assert.equal(harness.calls.quit, 1);
});

test('pai boot accepts a Windows drive root workspace without trying to mkdir it', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-pai-drive-root-'));
  // Windows drive roots already exist and reject even recursive mkdir with
  // EPERM, which used to fail the whole workspace startup.
  const drive = `${root.slice(0, root.indexOf(':') + 1)}\\`;
  const harness = await createStartupHarness(t, { launchArgs: ['--pai', '--cwd', drive], userData: root, closeBehavior: 'tray' });
  t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 4 }); });
  const main = await harness.start();
  assert.ok(main, 'the main window is created for a drive-root pai request');
  assert.deepEqual(harness.calls.paiWindows, [{ cwd: drive }], 'the drive root is handed to the hosted pai window untouched');
  assert.equal(harness.calls.errors.length, 0, 'no startup failure is reported');
  assert.doesNotMatch(harness.splash.url, /EPERM/, 'the splash does not fall back to the startup error page');
});

test('multi boot opens a full-size isolated instance without the singleton, tray or updater', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-multi-startup-'));
  const harness = await createStartupHarness(t, { launchArgs: ['--multi'], userData: root, closeBehavior: 'tray' });
  t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 4 }); });
  const main = await harness.start();
  await waitFor(() => harness.calls.init.length === 1, 'the agent boot to start');
  assert.deepEqual(harness.calls.init, [[{ cwd: process.cwd(), fresh: true }]], 'a multi instance starts a fresh conversation in the default workspace');
  assert.equal(harness.calls.windowMode, 'multi');
  assert.equal(harness.calls.singleInstanceLocks, 0, 'multi does not contend for the main application singleton');
  assert.equal(harness.calls.trays, 0);
  assert.equal(harness.calls.startUpdates, 0);
  assert.equal(main.options.width, 1280);
  assert.equal(main.options.height, 820);
  assert.equal(main.options.title, 'Pi Desktop');
  assert.ok(harness.calls.paths.userData.startsWith(join(root, 'multi-profiles')));
  assert.equal(main.query, undefined, 'the full renderer launches without a mode parameter');
  main.load.resolve(); main.emit('ready-to-show'); harness.initialization.resolve();
  await harness.rendererReady(main);
  let prevented = false;
  main.emit('close', { preventDefault() { prevented = true; } });
  await settle();
  assert.equal(prevented, true);
  assert.equal(harness.calls.quit, 1, 'multi exits even if the saved close behavior requests a tray');
  harness.app.emit('before-quit', { preventDefault() {} });
  await settle();
  assert.equal(harness.calls.dispose, 1);
  assert.equal(harness.calls.quit, 2);
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
  // init fires only after the real workspace stat resolves; rejecting before
  // startup attaches its handler is an unhandled rejection on slow runners.
  await waitFor(() => harness.calls.init.length === 1, 'the agent boot to start');
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

for (const { closeBehavior, busy } of [{ closeBehavior: 'quit', busy: false }, { closeBehavior: 'quit', busy: true }, { closeBehavior: 'tray', busy: true }]) {
  test(`Windows close (${closeBehavior}, busy=${busy}) waits for service disposal before quitting`, { skip: process.platform !== 'win32' }, async (t) => {
    const cleanup = deferred();
    const harness = await createStartupHarness(t, { closeBehavior, busy, shutdown: () => cleanup.promise });
    const main = await harness.start();
    main.load.resolve();
    main.emit('ready-to-show');
    harness.initialization.resolve();
    await harness.rendererReady(main);
    let closePrevented = false;
    main.emit('close', { preventDefault() { closePrevented = true; } });
    await settle();
    assert.equal(closePrevented, true);
    assert.equal(harness.calls.quit, 1);
    let quitPrevented = false;
    harness.app.emit('before-quit', { preventDefault() { quitPrevented = true; } });
    assert.equal(quitPrevented, true, 'choosing quit must not mark cleanup complete early');
    assert.equal(harness.calls.dispose, 1);
    assert.equal(harness.calls.quit, 1);
    cleanup.resolve();
    await settle();
    assert.equal(harness.calls.quit, 2);
  });
}

test('Windows close remembers the busy-close choice and stops asking', { skip: process.platform !== 'win32' }, async (t) => {
  const harness = await createStartupHarness(t, { closeBehavior: 'tray', busy: true, closeChoice: 0, checkboxChecked: true });
  const main = await harness.start();
  main.load.resolve();
  main.emit('ready-to-show');
  harness.initialization.resolve();
  await harness.rendererReady(main);
  main.emit('close', { preventDefault() {} });
  await settle();
  assert.equal(harness.calls.messageBoxes.length, 1, 'the first busy close asks');
  assert.equal(harness.calls.messageBoxes[0][1].checkboxLabel, 'Remember my choice', 'the full window offers to remember the choice');
  assert.deepEqual(harness.calls.closeChoices, ['tray'], 'the remembered behavior matches what the dialog offered');
  assert.equal(main.isVisible(), false, 'minimize to tray hides the window');
  // Second close: the remembered choice applies without a dialog.
  main.show();
  main.emit('close', { preventDefault() {} });
  await settle();
  assert.equal(harness.calls.messageBoxes.length, 1, 'a remembered choice is not asked again');
  assert.equal(main.isVisible(), false);
  assert.equal(harness.calls.quit, 0);
});

test('Windows close remembers quitting so later busy closes stop asking', { skip: process.platform !== 'win32' }, async (t) => {
  const harness = await createStartupHarness(t, { closeBehavior: 'tray', busy: true, closeChoice: 1, checkboxChecked: true });
  const main = await harness.start();
  main.load.resolve();
  main.emit('ready-to-show');
  harness.initialization.resolve();
  await harness.rendererReady(main);
  main.emit('close', { preventDefault() {} });
  await settle();
  assert.deepEqual(harness.calls.closeChoices, ['quit'], 'quitting from the dialog is remembered as the Settings behavior');
  assert.equal(harness.calls.quit, 1);
});

test('Windows close stops asking once the busy-close prompt was dismissed', { skip: process.platform !== 'win32' }, async (t) => {
  const harness = await createStartupHarness(t, { closeBehavior: 'quit', confirmBusyClose: false, busy: true });
  const main = await harness.start();
  main.load.resolve();
  main.emit('ready-to-show');
  harness.initialization.resolve();
  await harness.rendererReady(main);
  main.emit('close', { preventDefault() {} });
  await settle();
  assert.equal(harness.calls.messageBoxes.length, 0, 'a dismissed prompt quits straight away');
  assert.equal(harness.calls.quit, 1);
});

// The old "pai keeps its quit confirmation" case moved with hosted windows:
// the busy-close confirm for a pai window now lives in ipc.ts (closePaiWindow)
// and never offers a remembered choice; the process here always boots the
// main window, whose close policy is covered by the tests above.

test('the renderer starts loading while the startup workspace is still resolving', async (t) => {
  const workspace = deferred();
  const harness = await createStartupHarness(t, { workspace });
  const main = await harness.start();
  assert.ok(main, 'the main window exists before the workspace resolves');
  assert.equal(harness.calls.workspaces, 1, 'the workspace branch runs exactly once');
  assert.equal(harness.calls.init.length, 0, 'the agent boot waits for its workspace');
  assert.equal(main.options.backgroundColor, '#161616', 'the main window shares the boot splash background');
  workspace.resolve(process.cwd());
  await waitFor(() => harness.calls.init.length === 1, 'the agent to boot once its workspace resolves');
  assert.deepEqual(harness.calls.init, [[{ cwd: process.cwd() }]], 'the agent boots once the workspace resolves');
  main.load.resolve();
  main.emit('ready-to-show');
  harness.initialization.resolve();
  await harness.rendererReady(main);
  assert.equal(main.showCount, 1);
});

test('the boot window disappears only once the main window is on screen', async (t) => {
  const harness = await createStartupHarness(t);
  const main = await harness.start();
  let showCountWhenSplashClosed = -1;
  harness.splash.on('closed', () => { showCountWhenSplashClosed = main.showCount; });
  main.load.resolve();
  main.emit('ready-to-show');
  assert.equal(harness.splash.isDestroyed(), false, 'a painted but unacknowledged shell keeps the boot window');
  harness.initialization.resolve();
  await harness.rendererReady(main);
  assert.equal(main.showCount, 1);
  assert.equal(harness.splash.isDestroyed(), true);
  assert.equal(showCountWhenSplashClosed, 1, 'the swap never leaves a gap with neither window visible');
});

test('cold-start phases are recorded once, in order, with monotonic durations', async (t) => {
  const harness = await createStartupHarness(t);
  const main = await harness.start();
  // The workspace branch ends with the real stat; let its mark land before
  // the renderer branch so the recorded phase order is deterministic.
  await waitFor(() => harness.calls.init.length === 1, 'the agent boot to start');
  main.load.resolve();
  await settle();
  main.emit('ready-to-show');
  harness.initialization.resolve();
  await harness.rendererReady(main);
  const events = harness.calls.diagnostics.filter((event) => event.action.startsWith('boot-'));
  assert.deepEqual(events.map((event) => event.action), [
    'boot-main-start', 'boot-app-ready', 'boot-state-read', 'boot-splash-created', 'boot-splash-shown',
    'boot-ipc-ready', 'boot-window-created', 'boot-workspace-ready',
    'boot-renderer-loaded', 'boot-ready-to-show', 'boot-renderer-ready', 'boot-first-frame',
  ]);
  assert.ok(events.every((event) => event.stage === 'startup' && event.outcome === 'success'));
  const durations = events.map((event) => event.durationMs);
  assert.ok(durations.every((value) => Number.isFinite(value) && value >= 0));
  assert.deepEqual([...durations].sort((a, b) => a - b), durations, 'phase times are monotonic from process start');
  assert.equal(harness.calls.consoleLogs.length, 0, 'packaged builds stay silent without PI_STARTUP_LOG');
});

test('a startup failure records the phases reached with a failure outcome', async (t) => {
  const harness = await createStartupHarness(t, { workspaceError: new Error('Workspace is inaccessible') });
  await harness.start();
  await settle();
  const events = harness.calls.diagnostics.filter((event) => event.action.startsWith('boot-'));
  assert.deepEqual(events.map((event) => event.action), [
    'boot-main-start', 'boot-app-ready', 'boot-state-read', 'boot-splash-created', 'boot-splash-shown', 'boot-ipc-ready', 'boot-window-created',
  ]);
  assert.ok(events.every((event) => event.outcome === 'failure'));
  assert.equal(harness.calls.consoleLogs.length, 0);
});

test('PI_STARTUP_LOG prints a single one-line cold-start summary', async (t) => {
  const harness = await createStartupHarness(t, { startupLog: '1' });
  const main = await harness.start();
  main.load.resolve();
  await settle();
  main.emit('ready-to-show');
  harness.initialization.resolve();
  await harness.rendererReady(main);
  assert.equal(harness.calls.consoleLogs.length, 1, 'exactly one summary line for the whole cold start');
  assert.match(String(harness.calls.consoleLogs[0][0]), /^\[pi-startup\] cold start \d+ms main-start=\d+ app-ready=\d+.*first-frame=\d+$/);
});

test('a light system preference themes the boot and main windows light', async (t) => {
  const harness = await createStartupHarness(t, { prefersDark: false });
  const main = await harness.start();
  assert.equal(harness.splash.options.backgroundColor, '#f8f8f8');
  assert.equal(main.options.backgroundColor, '#f8f8f8');
});

test('a saved appearance surface drives the boot window background', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-startup-appearance-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const colors = { light: { preset: 'default', accent: '#4a5fc1', surface: '#f8f8f8', ink: '#262626', contrast: 50 }, dark: { preset: 'custom', accent: '#8aa4f8', surface: '#101c26', ink: '#e5e5e5', contrast: 50 } };
  await writeFile(join(root, 'appearance.json'), JSON.stringify({ theme: 'dark', colors }));
  const harness = await createStartupHarness(t, { userData: root, expectedSplashBackground: '#101c26' });
  const main = await harness.start();
  assert.equal(harness.splash.options.backgroundColor, '#101c26', 'the boot window uses the saved dark surface');
  assert.equal(main.options.backgroundColor, '#101c26', 'the main window uses the same constant');
});
