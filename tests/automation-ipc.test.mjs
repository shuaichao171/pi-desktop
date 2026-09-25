import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const stubs = {
  electron: `
    export const app = { getPath: () => globalThis.__automationRoot };
    export const Menu = { buildFromTemplate: () => ({}) };
    export const nativeImage = { createFromPath: () => ({ isEmpty: () => true }) };
    export const Tray = class {};
    export const BrowserWindow = { getAllWindows: () => [] };
    export const dialog = { showErrorBox: () => {} };
    export const ipcMain = { handle: (channel, handler) => globalThis.__automationHandlers.set(channel, handler) };
  `,
  './agentClient': 'export const createIsolatedAgentService = () => ({ onEvent() {}, onBackgroundActivity() {}, async dispose() {} });',
  './updateService': 'export const updateService = {};',
  './workbenchIpc': 'export const registerWorkbenchIpc = () => ({ async dispose() {} });',
};
registerHooks({ resolve(specifier, context, nextResolve) {
  if (stubs[specifier]) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
  if (specifier.startsWith('./') && context.parentURL?.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
  return nextResolve(specifier, context);
} });

test('automation IPC authenticates every sender and only saves validated registered projects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-automation-ipc-'));
  const cwd = join(root, 'project');
  await mkdir(cwd);
  await writeFile(join(root, 'workspace.json'), JSON.stringify({ cwd, workspaces: [cwd] }));
  globalThis.__automationRoot = root;
  globalThis.__automationHandlers = new Map();
  const { IPC_CHANNELS: channels } = await import('../packages/shared/src/index.ts');
  const ipc = await import('../packages/desktop/src/main/ipc.ts');
  const sent = [];
  const owner = { isDestroyed: () => false, webContents: { mainFrame: {}, isDestroyed: () => false, send: (...args) => sent.push(args) } };
  const valid = { sender: owner.webContents, senderFrame: owner.webContents.mainFrame };
  ipc.registerIpc({ getDialogWindow: () => owner });
  const call = (channel, ...args) => globalThis.__automationHandlers.get(channel)(valid, ...args);
  try {
    for (const channel of [channels.automationSnapshot, channels.automationSave, channels.automationSetEnabled, channels.automationDelete, channels.automationRun, channels.automationCancelRun]) {
      const handler = globalThis.__automationHandlers.get(channel);
      assert.throws(() => handler({ sender: {}, senderFrame: owner.webContents.mainFrame }), /Invalid automation sender/);
      assert.throws(() => handler({ sender: owner.webContents, senderFrame: {} }), /Invalid automation sender/);
    }
    const input = { name: 'Daily review', prompt: 'Review changes.', cwd, model: null, thinkingLevel: null, schedule: { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' }, timeZone: 'Asia/Shanghai', enabled: false };
    assert.equal((await call(channels.automationSnapshot)).automations.length, 0);
    await assert.rejects(call(channels.automationSave, { ...input, cwd: join(root, 'unregistered') }), /未知工作区/);
    await assert.rejects(call(channels.automationSave, { ...input, prompt: '' }), /任务指令/);
    const saved = await call(channels.automationSave, input);
    assert.equal(saved.automations.length, 1);
    assert.equal(saved.automations[0].nextRunAt, null);
    assert.equal(sent.at(-1)[0], channels.automationChanged);
    assert.deepEqual(sent.at(-1)[1], saved);
    await assert.rejects(call(channels.automationSetEnabled, saved.automations[0].id, 'true'), /启用状态/);
    const enabled = await call(channels.automationSetEnabled, saved.automations[0].id, true);
    assert.ok(Date.parse(enabled.automations[0].nextRunAt) > Date.now());
    assert.equal((await call(channels.automationDelete, saved.automations[0].id)).automations.length, 0);
  } finally {
    await ipc.disposeServices();
    assert.throws(() => call(channels.automationSnapshot), /Invalid automation sender/);
    await rm(root, { recursive: true, force: true });
  }
});
