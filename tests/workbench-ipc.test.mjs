import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const electronStub = `
  export const app = { getPath: () => globalThis.__testUserData };
  export const BrowserWindow = {
    fromWebContents: () => globalThis.__testWindow,
    getAllWindows: () => [],
  };
  export const dialog = { showMessageBox: async (_window, options) => globalThis.__testDialog(options) };
  export const shell = { openPath: async path => globalThis.__testOpenPath(path), showItemInFolder: path => globalThis.__testRevealPath(path) };
  export const ipcMain = { handle: (channel, handler) => globalThis.__testHandlers.set(channel, handler) };
`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: `data:text/javascript,${encodeURIComponent(electronStub)}`, shortCircuit: true };
    if (specifier.startsWith('./') && context.parentURL?.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

globalThis.__testUserData = join(tmpdir(), `pi-desktop-workbench-ipc-${process.pid}-unused`);
globalThis.__testHandlers = new Map();
const { registerWorkbenchIpc } = await import('../packages/desktop/src/main/workbenchIpc.ts');
const { ResultFileService } = await import('../packages/desktop/src/main/resultFileService.ts');
const { IPC_CHANNELS } = await import('../packages/shared/src/index.ts');

test('workbench command requires main-frame native confirmation and checks the workspace again', async () => {
  let cwd = 'C:\\trusted-workspace';
  const mainFrame = {};
  const webContents = { mainFrame, isDestroyed: () => false };
  const win = { webContents, isDestroyed: () => false };
  globalThis.__testWindow = win;
  const service = registerWorkbenchIpc(() => cwd);
  const started = [];
  service.startCommand = async (command, approvedCwd) => { started.push([command, approvedCwd]); return 'command-1'; };
  const handler = globalThis.__testHandlers.get(IPC_CHANNELS.workspaceCommandStart);
  const event = { sender: webContents, senderFrame: mainFrame };

  globalThis.__testDialog = async (options) => {
    assert.match(options.detail, /trusted-workspace/);
    assert.match(options.detail, /Write-Output safe/);
    return { response: 0 };
  };
  assert.equal(await handler(event, 'Write-Output safe'), '');
  assert.deepEqual(started, []);

  globalThis.__testDialog = async () => { cwd = 'C:\\other-workspace'; return { response: 1 }; };
  await assert.rejects(async () => handler(event, 'Write-Output safe'), /工作区已切换/);
  assert.deepEqual(started, []);

  cwd = 'C:\\trusted-workspace';
  globalThis.__testDialog = async () => ({ response: 1 });
  await assert.rejects(async () => handler({ sender: webContents, senderFrame: {} }, 'Write-Output safe'), /renderer sender/);
  assert.equal(await handler(event, 'Write-Output safe'), 'command-1');
  assert.deepEqual(started, [['Write-Output safe', cwd]]);
});

test('opening the workspace folder rejects foreign frames and rechecks the sender before native dispatch', async () => {
  const mainFrame = {};
  let destroyed = false;
  const webContents = { mainFrame, isDestroyed: () => destroyed };
  const win = { webContents, isDestroyed: () => destroyed };
  globalThis.__testWindow = win;
  const service = registerWorkbenchIpc(() => 'C:\\project');
  const handler = globalThis.__testHandlers.get(IPC_CHANNELS.workspaceOpenFolder);
  const event = { sender: webContents, senderFrame: mainFrame };
  const opened = [];
  globalThis.__testOpenPath = async path => { opened.push(path); return ''; };
  service.openWorkspaceFolder = async (cwd, openPath) => { assert.equal(cwd, 'C:\\project'); await openPath('C:\\resolved-project'); };

  await assert.rejects(async () => handler({ sender: webContents, senderFrame: {} }, 'C:\\project'), /requesting window|renderer sender/);
  await assert.rejects(async () => handler({ sender: { isDestroyed: () => false }, senderFrame: mainFrame }, 'C:\\project'), /requesting window|renderer sender/);
  globalThis.__testWindow = null;
  await assert.rejects(async () => handler(event, 'C:\\project'), /requesting window|renderer sender/);
  assert.deepEqual(opened, []);
  globalThis.__testWindow = win;
  await handler(event, 'C:\\project');
  assert.deepEqual(opened, ['C:\\resolved-project']);

  service.openWorkspaceFolder = async (_cwd, openPath) => { destroyed = true; await openPath('C:\\resolved-project'); };
  await assert.rejects(async () => handler(event, 'C:\\project'), /requesting window|renderer sender/);
  assert.equal(opened.length, 1, 'destroyed renderers cannot open Explorer after path resolution');
  await service.dispose();
});

test('every workbench IPC rejects child frames, foreign senders and destroyed windows', async () => {
  const mainFrame = {};
  const webContents = { mainFrame, isDestroyed: () => false };
  globalThis.__testWindow = { webContents, isDestroyed: () => false };
  const service = registerWorkbenchIpc(() => 'C:\\project');
  for (const [channel, handler] of globalThis.__testHandlers) {
    await assert.rejects(async () => handler({ sender: webContents, senderFrame: {} }), /renderer sender/, channel);
    await assert.rejects(async () => handler({ sender: { isDestroyed: () => false }, senderFrame: mainFrame }), /requesting window/, channel);
  }
  globalThis.__testWindow = { webContents, isDestroyed: () => true };
  for (const [channel, handler] of globalThis.__testHandlers) {
    await assert.rejects(async () => handler({ sender: webContents, senderFrame: mainFrame }), /requesting window/, channel);
  }
  await service.dispose();
});

test('result file IPC rechecks the renderer after resolution and before native dispatch or preview delivery', async t => {
  const mainFrame = {};
  let destroyed = false;
  const webContents = { mainFrame, isDestroyed: () => destroyed };
  const win = { webContents, isDestroyed: () => destroyed };
  globalThis.__testWindow = win;
  const service = registerWorkbenchIpc(() => 'C:\\project');
  const event = { sender: webContents, senderFrame: mainFrame };
  const nativeCalls = [];
  globalThis.__testOpenPath = async path => { nativeCalls.push(path); return ''; };
  globalThis.__testRevealPath = path => nativeCalls.push(path);
  for (const [channel, method] of [[IPC_CHANNELS.resultFileOpen, 'openResultFile'], [IPC_CHANNELS.resultFileReveal, 'revealResultFile'], [IPC_CHANNELS.resultFilePreview, 'previewResultFile']]) {
    const original = ResultFileService.prototype[method];
    t.after(() => { ResultFileService.prototype[method] = original; });
    ResultFileService.prototype[method] = async (_target, dispatch) => {
      await Promise.resolve();
      destroyed = true;
      return dispatch ? dispatch('C:\\project\\file.txt') : { kind: 'text', path: 'C:\\project\\file.txt', text: 'preview' };
    };
    destroyed = false;
    await assert.rejects(globalThis.__testHandlers.get(channel)(event, { cwd: 'C:\\project', path: 'file.txt' }), /requesting window/);
    ResultFileService.prototype[method] = original;
  }
  assert.deepEqual(nativeCalls, []);
  await service.dispose();
});

test('a hosted pai window previews and lists files in its own folder instead of the active workspace', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pi-pai-workbench-'));
  const mainCwd = join(root, 'main-project');
  const hostedCwd = join(root, 'pai-project');
  await mkdir(mainCwd);
  await mkdir(hostedCwd);
  await writeFile(join(mainCwd, 'main.txt'), 'main note');
  await writeFile(join(hostedCwd, 'pai.txt'), 'pai note');
  t.after(() => rm(root, { recursive: true, force: true }));

  const mainFrame = {};
  const mainWebContents = { mainFrame, isDestroyed: () => false };
  const hostedWebContents = { mainFrame, isDestroyed: () => false };
  const service = registerWorkbenchIpc(() => mainCwd);
  const { setRendererSenderRestriction } = await import('../packages/desktop/src/main/rendererIpc.ts');
  setRendererSenderRestriction({
    isPaiSender: event => event.sender === hostedWebContents,
    mainOnlyChannels: new Set(),
    hostedWorkspace: event => (event.sender === hostedWebContents ? hostedCwd : undefined),
  });
  t.after(() => { setRendererSenderRestriction(null); return service.dispose(); });
  // The electron stub resolves every sender to one window, so point it at the caller.
  const send = (webContents, channel, ...args) => {
    globalThis.__testWindow = { webContents, isDestroyed: () => false };
    return globalThis.__testHandlers.get(channel)({ sender: webContents, senderFrame: mainFrame }, ...args);
  };

  const hostedPreview = await send(hostedWebContents, IPC_CHANNELS.resultFilePreview, { cwd: hostedCwd, path: 'pai.txt' });
  assert.equal(hostedPreview.text, 'pai note');
  const mainPreview = await send(mainWebContents, IPC_CHANNELS.resultFilePreview, { cwd: mainCwd, path: 'main.txt' });
  assert.equal(mainPreview.text, 'main note');
  // Neither window may preview the other one's folder.
  await assert.rejects(send(hostedWebContents, IPC_CHANNELS.resultFilePreview, { cwd: mainCwd, path: 'main.txt' }), /对话已切换/);
  await assert.rejects(send(mainWebContents, IPC_CHANNELS.resultFilePreview, { cwd: hostedCwd, path: 'pai.txt' }), /对话已切换/);
  // The composer's file picker lists the folder the requesting window belongs to.
  assert.deepEqual((await send(hostedWebContents, IPC_CHANNELS.workspaceListEntries)).map(entry => entry.name), ['pai.txt']);
  assert.deepEqual((await send(mainWebContents, IPC_CHANNELS.workspaceListEntries)).map(entry => entry.name), ['main.txt']);
});
