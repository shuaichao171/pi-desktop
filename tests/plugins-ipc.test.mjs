import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const stubs = {
  electron: `
    export const app = { getPath: () => globalThis.__pluginRoot };
    export const BrowserWindow = { getAllWindows: () => [] };
    export const Menu = { buildFromTemplate: () => ({}) };
    export const nativeImage = { createFromPath: () => ({ isEmpty: () => true }) };
    export const Tray = class {};
    export const dialog = { showErrorBox() {}, async showOpenDialog(owner) { globalThis.__pluginPickerOwner = owner; return { canceled: false, filePaths: [globalThis.__pluginRoot] }; } };
    export const ipcMain = { handle: (name, fn) => globalThis.__pluginHandlers.set(name, fn) };
  `,
  './agentClient': 'export const createIsolatedAgentService = () => globalThis.__pluginAgent;',
  './automationExecutor': `export const createAutomationExecutor = () => ({
    execute: (...args) => globalThis.__pluginExecute(...args),
    hasActiveWorkers: () => globalThis.__pluginWorkerStuck,
    hasUnreleasedWorkers: () => globalThis.__pluginWorkerStuck,
    sessionPaths: () => [], isSessionRunning: () => false,
  });`,
  './pluginDiscovery': 'export const createPluginDiscovery = () => async () => ({ items: [], total: 0 });',
  './updateService': 'export const updateService = {};',
  './workbenchIpc': 'export const registerWorkbenchIpc = () => ({ async reset() {}, async dispose() {} });',
};
registerHooks({ resolve(specifier, context, nextResolve) {
  if (stubs[specifier]) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
  if (specifier.startsWith('./') && context.parentURL?.includes('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
  return nextResolve(specifier, context);
} });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('settings and plugin IPC authenticate senders; plugin mutations coordinate with automation claims', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-plugin-ipc-'));
  const cwd = join(root, 'project');
  await mkdir(cwd);
  await writeFile(join(root, 'workspace.json'), JSON.stringify({ cwd, workspaces: [cwd] }));
  globalThis.__pluginRoot = root;
  globalThis.__pluginHandlers = new Map();
  globalThis.__pluginWorkerStuck = false;
  const catalog = { cwd, packages: [], resources: [], warnings: [], projectTrusted: true };
  const instructions = [{ id: 'user', path: join(root, 'AGENTS.md'), content: 'Use Chinese.', exists: true, revision: 'initial' }];
  let mutations = 0;
  let mutate = async () => catalog;
  globalThis.__pluginAgent = {
    onEvent() {}, onBackgroundActivity() {}, async dispose() {},
    async getPersonalization() { return instructions; },
    async discoverProviderModels(request) { assert.deepEqual(request, { provider: 'custom-test' }); return { models: [{ id: 'remote-model' }], warnings: [] }; },
    async saveInstruction(request) { assert.deepEqual(request, { id: 'user', content: 'Updated.', revision: 'initial' }); return { status: 'saved', document: { ...instructions[0], content: request.content, revision: 'saved' } }; },
    async getPluginCatalog(requested) { assert.equal(requested, cwd); return catalog; },
    async previewPluginResource(request) { return { path: request.path, text: 'preview', truncated: false }; },
    async mutatePlugin(input) { mutations++; return mutate(input); },
    async setExtensionEnabled() { mutations++; return mutate(); },
    async executeSlashCommand() { mutations++; return mutate(); },
  };
  const runStarted = deferred();
  globalThis.__pluginExecute = async (_task, signal) => {
    runStarted.resolve();
    await new Promise(done => { if (signal.aborted) done(); else signal.addEventListener('abort', done, { once: true }); });
    return { summary: 'cancelled', sessionId: null, sessionPath: null };
  };
  const owner = { isDestroyed: () => false, webContents: { mainFrame: {}, isDestroyed: () => false, send() {} } };
  const event = { sender: owner.webContents, senderFrame: owner.webContents.mainFrame };
  const ipc = await import('../packages/desktop/src/main/ipc.ts');
  const { IPC_CHANNELS: ch } = await import('../packages/shared/src/index.ts');
  ipc.registerIpc({ getDialogWindow: () => owner });
  ipc.defaultWorkspace();
  const call = (channel, ...args) => globalThis.__pluginHandlers.get(channel)(event, ...args);
  const reload = { cwd, action: 'reload' };
  let release;
  try {
    for (const channel of [ch.personalizationRead, ch.personalizationSave, ch.agentDiscoverProviderModels, ch.pluginCatalog, ch.pluginMutate, ch.pluginPreview, ch.pluginDiscover, ch.pluginPickDirectory, ch.agentSetExtensionEnabled]) {
      const handler = globalThis.__pluginHandlers.get(channel);
      await assert.rejects(async () => handler({ sender: {}, senderFrame: event.senderFrame }), /Invalid plugin sender/);
      await assert.rejects(async () => handler({ sender: event.sender, senderFrame: {} }), /Invalid plugin sender/);
    }
    for (const [channel, input] of [[ch.pluginCatalog, root], [ch.pluginMutate, { ...reload, cwd: root }], [ch.pluginPreview, { cwd: root }]]) {
      assert.throws(() => call(channel, input), /项目已切换/);
    }
    assert.deepEqual(await call(ch.pluginCatalog, cwd), catalog);
    assert.deepEqual(await call(ch.personalizationRead), instructions);
    assert.deepEqual(await call(ch.agentDiscoverProviderModels, { provider: 'custom-test' }), { models: [{ id: 'remote-model' }], warnings: [] });
    assert.equal((await call(ch.personalizationSave, { id: 'user', content: 'Updated.', revision: 'initial' })).document.revision, 'saved');
    assert.equal(await call(ch.pluginPickDirectory), root);
    assert.equal(globalThis.__pluginPickerOwner, owner);
    assert.equal((await call(ch.pluginPreview, { cwd, path: 'known.md' })).text, 'preview');

    const task = (await call(ch.automationSave, { name: 'review', prompt: 'Review changes', cwd, model: null, thinkingLevel: null,
      schedule: { kind: 'weekly', days: [1], time: '09:00' }, timeZone: 'Asia/Shanghai', enabled: false })).automations[0];
    const gate = deferred();
    const entered = deferred();
    release = gate.resolve;
    mutate = async () => { entered.resolve(); await gate.promise; return catalog; };
    const pending = call(ch.pluginMutate, reload);
    await assert.rejects(call(ch.pluginMutate, reload), /已有插件操作/);
    await entered.promise;
    await assert.rejects(call(ch.workspaceSwitch, cwd), /插件正在更新/);
    await assert.rejects(call(ch.automationRun, task.id), /插件/);
    assert.equal(mutations, 1);
    release();
    await pending;

    mutate = async () => { throw new Error('disk failure'); };
    await assert.rejects(call(ch.pluginMutate, reload), /disk failure/);
    mutate = async () => catalog;
    assert.deepEqual(await call(ch.pluginMutate, reload), catalog, 'failure releases reservation');
    const run = await call(ch.automationRun, task.id);
    await runStarted.promise;
    const before = mutations;
    await assert.rejects(call(ch.pluginMutate, reload), /自动化仍在运行/);
    await assert.rejects(call(ch.agentSetExtensionEnabled, 'known.ts', false), /自动化仍在运行/);
    await assert.rejects(call(ch.agentExecuteSlashCommand, { cwd, sessionId: 'test', name: 'reload' }), /自动化仍在运行/);
    assert.equal(mutations, before);
    await call(ch.automationCancelRun, run.runs[0].id);
    // A worker whose exit was not confirmed must remain protected even after
    // the durable automation run has reached its final status.
    globalThis.__pluginWorkerStuck = true;
    await assert.rejects(call(ch.pluginMutate, reload), /自动化仍在运行/);
    await assert.rejects(call(ch.automationRun, task.id), /上次自动化执行进程尚未退出/);
    globalThis.__pluginWorkerStuck = false;
    await ipc.disposeServices();
    assert.throws(() => call(ch.pluginCatalog, cwd), /Invalid plugin sender/);
  } finally {
    release?.();
    await ipc.disposeServices();
    await rm(root, { recursive: true, force: true });
  }
});
