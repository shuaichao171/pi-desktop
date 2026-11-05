import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// 会话列表分页/快照缓存（agentListSessionsPage）：
// 同一刷新的各页共享一次重建的快照；元数据（置顶等）实时合并不触发重列；
// sessions-changed 按工作区失效并换发新 revision；错误文案保持不变。

const stubs = {
  electron: `
    export const app = { getPath: () => globalThis.__ipcUserData, getVersion: () => '0.1.7-test' };
    export const nativeTheme = { shouldUseDarkColors: false };
    export const shell = { showItemInFolder: () => {} };
    export const Menu = { buildFromTemplate: () => ({}) };
    export const nativeImage = { createFromPath: () => ({ isEmpty: () => true }) };
    export const Tray = class {};
    export const BrowserWindow = {
      getAllWindows: () => globalThis.__ipcWindows ?? [],
      fromWebContents: (sender) => globalThis.__ipcWindows?.find((win) => win.webContents === sender),
    };
    export const dialog = { showErrorBox: () => {}, showOpenDialog: async () => ({ canceled: true }) };
    export const Notification = class { static isSupported() { return false; } on() { return this; } show() {} };
    export const ipcMain = { handle: (channel, handler) => globalThis.__ipcHandlers.set(channel, handler) };
    export const powerSaveBlocker = { start: () => 1, stop: () => {}, isStarted: () => false };
  `,
  './agentClient': `
    export function createIsolatedAgentService(ui) { return globalThis.__ipcAgent; }
  `,
  './updateService': 'export const updateService = { stop() {}, setAutoInstallSource: async () => {}, getState: () => ({ phase: "idle" }) };',
  './workbenchIpc': 'export const registerWorkbenchIpc = () => ({ reset: async () => {}, dispose: async () => {} });',
  './workbenchFeatureIpc': `export const registerWorkbenchFeatureIpc = () => ({ closeTerminalForWorkspace: async () => {}, dispose: async () => {} });`,
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
    isDestroyed: () => win.destroyed,
    isVisible: () => true,
    close: () => { win.destroyed = true; win.emit('closed'); },
    webContents: { mainFrame: {}, isDestroyed: () => win.destroyed, send: () => {} },
  });
  return win;
}

const row = (project, id) => ({ path: join(project, `${id}.jsonl`), id: String(id), firstMessage: String(id), modified: `2026-10-0${(Number(id) % 9) + 1}T00:00:00Z`, messageCount: 2 });

test('会话列表分页共享快照；元数据实时合并；sessions-changed 按工作区失效', async (t) => {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, 'pi-ipc-session-pages-'));
  const project = join(root, 'project');
  const other = join(root, 'other');
  await Promise.all([mkdir(project), mkdir(other)]);
  await writeFile(join(root, 'workspace.json'), JSON.stringify({ cwd: project, workspaces: [project, other] }));

  const agentRows = [row(project, 1), row(project, 2), row(project, 3), row(project, 4), row(project, 5)];
  let listCalls = 0;
  let agentEvents = null;
  globalThis.__ipcUserData = root;
  globalThis.__ipcWindows = [createIpcWindow()];
  globalThis.__ipcHandlers = new Map();
  globalThis.__ipcAgent = {
    onEvent(callback) { agentEvents = callback; },
    onBackgroundActivity() {},
    async dispose() {},
    getSnapshot: async () => ({ sessionPath: null }),
    async listSessions(cwd) { listCalls += 1; return cwd === project ? agentRows.map((entry) => ({ ...entry })) : []; },
  };
  t.after(async () => {
    await ipc.disposeServices();
    await rm(root, { recursive: true, force: true });
  });

  const ipc = await import('../packages/desktop/src/main/ipc.ts?session-pages');
  const { IPC_CHANNELS } = await import('../packages/shared/src/index.ts');
  ipc.registerIpc();
  const valid = { sender: globalThis.__ipcWindows[0].webContents, senderFrame: globalThis.__ipcWindows[0].webContents.mainFrame };
  const handlers = globalThis.__ipcHandlers;
  const page = (cwd, offset, limit) => handlers.get(IPC_CHANNELS.agentListSessionsPage)(valid, cwd, offset, limit);
  const full = (cwd) => handlers.get(IPC_CHANNELS.agentListSessions)(valid, cwd);
  const updateMeta = (path, patch) => handlers.get(IPC_CHANNELS.agentUpdateSessionMeta)(valid, path, patch);

  // 全量与分页都由同一次快照构建，页间不再重列。
  assert.deepEqual((await full(project)).map((entry) => entry.id), ['1', '2', '3', '4', '5']);
  assert.equal(listCalls, 1);
  const firstPage = await page(project, 0, 2);
  assert.deepEqual(firstPage.sessions.map((entry) => entry.id), ['1', '2']);
  assert.equal(firstPage.total, 5);
  assert.equal(firstPage.hasMore, true);
  const restPage = await page(project, 2, 500);
  assert.deepEqual(restPage.sessions.map((entry) => entry.id), ['3', '4', '5']);
  assert.equal(restPage.hasMore, false);
  assert.equal(restPage.revision, firstPage.revision, '同一快照的各页 revision 一致');
  assert.equal(listCalls, 1, '分页只读快照，不重复请求 agent');

  // 元数据（置顶）实时合入：不需要重列工作区。
  await updateMeta(join(project, '3.jsonl'), { pinned: true });
  const listCallsAfterMeta = listCalls; // requireSessionOwner 的所有权校验会自行列一次
  const pinnedPage = await page(project, 2, 1);
  assert.equal(pinnedPage.sessions[0].pinned, true, '置顶标记实时合并');
  assert.equal(listCalls, listCallsAfterMeta, '元数据变更不触发重列');

  // sessions-changed 按工作区失效：换发 revision 并可见新增会话；其他工作区不受影响。
  agentRows.unshift(row(project, 0));
  agentEvents({ sequence: 2, event: { type: 'sessions-changed', cwd: project } });
  const rebuilt = await page(project, 0, 2);
  assert.deepEqual(rebuilt.sessions.map((entry) => entry.id), ['0', '1']);
  assert.equal(rebuilt.total, 6);
  assert.notEqual(rebuilt.revision, firstPage.revision, '重建后 revision 变化');
  assert.ok(listCalls > listCallsAfterMeta, '失效后重新列出工作区');
  // 失效后的全量结果与分页拼接一致。
  assert.deepEqual((await full(project)).map((entry) => entry.id), ['0', '1', '2', '3', '4', '5']);
  assert.equal(rebuilt.sessions.find((entry) => entry.id === undefined), undefined);
});

test('分页参数与未知工作区沿用既有错误文案', async (t) => {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, 'pi-ipc-session-pages-args-'));
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(root, 'workspace.json'), JSON.stringify({ cwd: project, workspaces: [project] }));
  globalThis.__ipcUserData = root;
  globalThis.__ipcWindows = [createIpcWindow()];
  globalThis.__ipcHandlers = new Map();
  globalThis.__ipcAgent = {
    onEvent() {}, onBackgroundActivity() {}, async dispose() {},
    getSnapshot: async () => ({ sessionPath: null }),
    listSessions: async () => [],
  };
  t.after(async () => {
    await ipc.disposeServices();
    await rm(root, { recursive: true, force: true });
  });
  const ipc = await import('../packages/desktop/src/main/ipc.ts?session-pages-args');
  const { IPC_CHANNELS } = await import('../packages/shared/src/index.ts');
  ipc.registerIpc();
  const valid = { sender: globalThis.__ipcWindows[0].webContents, senderFrame: globalThis.__ipcWindows[0].webContents.mainFrame };
  const page = (cwd, offset, limit) => globalThis.__ipcHandlers.get(IPC_CHANNELS.agentListSessionsPage)(valid, cwd, offset, limit);
  await assert.rejects(page(join(root, 'missing'), 0, 10), /未知工作区/);
  await assert.rejects(page(project, -1, 10), /会话分页参数无效/);
  await assert.rejects(page(project, 0, 0), /会话分页参数无效/);
  await assert.rejects(page(project, 0, 501), /会话分页参数无效/);
  await assert.rejects(page(project, 1.5, 10), /会话分页参数无效/);
  await assert.rejects(page('', 0, 10), /会话分页参数无效/);
  const empty = await page(project, 0, 10);
  assert.deepEqual(empty, { sessions: [], total: 0, hasMore: false, revision: empty.revision });
});

test('在途重列期间到达的 sessions-changed 失效不会被完成的重列吞掉', async (t) => {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, 'pi-ipc-session-race-'));
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(root, 'workspace.json'), JSON.stringify({ cwd: project, workspaces: [project] }));

  const agentRows = [row(project, 1)];
  let listCalls = 0;
  let releaseList = null;
  let agentEvents = null;
  globalThis.__ipcUserData = root;
  globalThis.__ipcWindows = [createIpcWindow()];
  globalThis.__ipcHandlers = new Map();
  globalThis.__ipcAgent = {
    onEvent(callback) { agentEvents = callback; },
    onBackgroundActivity() {},
    async dispose() {},
    getSnapshot: async () => ({ sessionPath: null }),
    listSessions(cwd) {
      listCalls += 1;
      return new Promise((resolve) => { releaseList = () => resolve(cwd === project ? agentRows.map((entry) => ({ ...entry })) : []); });
    },
  };
  t.after(async () => {
    await ipc.disposeServices();
    await rm(root, { recursive: true, force: true });
  });
  const ipc = await import('../packages/desktop/src/main/ipc.ts?session-race');
  const { IPC_CHANNELS } = await import('../packages/shared/src/index.ts');
  ipc.registerIpc();
  const valid = { sender: globalThis.__ipcWindows[0].webContents, senderFrame: globalThis.__ipcWindows[0].webContents.mainFrame };
  const full = (cwd) => globalThis.__ipcHandlers.get(IPC_CHANNELS.agentListSessions)(valid, cwd);

  const first = full(project); // 开始在途重列（listSessions 未完成）
  for (let i = 0; i < 1000 && !releaseList; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listCalls, 1, '重列已在途');
  agentRows.unshift(row(project, 0)); // 新会话落盘…
  agentEvents({ sequence: 2, event: { type: 'sessions-changed', cwd: project } }); // …失效恰在重列完成前到达
  releaseList();
  const firstResult = await first;
  assert.deepEqual(firstResult.map((entry) => entry.id), ['0', '1']);
  assert.equal(listCalls, 1);
  // 关键：在途期间到达的失效不被完成的重列吞掉——下一次服务必须重新列出（保守多列一次）。
  const second = full(project);
  for (let i = 0; i < 1000 && listCalls < 2; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listCalls, 2, '在途期间到达的失效触发了重新列出');
  releaseList(); // 释放第二次列表，避免悬挂
  const secondResult = await second;
  assert.deepEqual(secondResult.map((entry) => entry.id), ['0', '1']);
});
