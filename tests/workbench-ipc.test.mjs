import assert from 'node:assert/strict';
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
  await assert.rejects(handler(event, 'Write-Output safe'), /工作区已切换/);
  assert.deepEqual(started, []);

  cwd = 'C:\\trusted-workspace';
  globalThis.__testDialog = async () => ({ response: 1 });
  await assert.rejects(handler({ sender: webContents, senderFrame: {} }, 'Write-Output safe'), /无法确认命令来源/);
  assert.equal(await handler(event, 'Write-Output safe'), 'command-1');
  assert.deepEqual(started, [['Write-Output safe', cwd]]);
});
