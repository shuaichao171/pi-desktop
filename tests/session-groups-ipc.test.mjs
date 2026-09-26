import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const stubs = {
  electron: `
    export const app = { getPath: () => globalThis.__groupsRoot };
    export const BrowserWindow = { getAllWindows: () => [], fromWebContents: (sender) => globalThis.__reviewWindow?.webContents === sender ? globalThis.__reviewWindow : null };
    export const Menu = { buildFromTemplate: () => ({}) };
    export const nativeImage = { createFromPath: () => ({ isEmpty: () => true }) };
    export const Tray = class {};
    export const dialog = { showErrorBox: () => {} };
    export const Notification = class { static isSupported() { return false; } on() { return this; } show() {} };
    export const ipcMain = { handle: (channel, handler) => globalThis.__groupsHandlers.set(channel, handler) };
  `,
  './agentClient': 'export const createIsolatedAgentService = () => globalThis.__groupsAgent;',
  './updateService': 'export const updateService = { stop() {} };',
  './workbenchIpc': 'export const registerWorkbenchIpc = () => ({ reset: async () => {}, dispose: async () => {} });',
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (stubs[specifier]) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
    if (specifier.startsWith('./') && context.parentURL && new URL(context.parentURL).pathname.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

test('group IPC accepts sessions in registered projects and revalidates cached owners without altering metadata', async (t) => {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, 'pi-group-ipc-'));
  t.after(async () => {
    assert.equal(dirname(root), temp);
    await rm(root, { recursive: true, force: true });
  });
  const first = join(root, 'one');
  const second = join(root, 'two');
  const unknown = join(root, 'unknown');
  await Promise.all([mkdir(first), mkdir(second), mkdir(unknown)]);
  const firstPath = join(root, 'first.jsonl');
  const secondPath = join(root, 'second.jsonl');
  const unknownPath = join(root, 'unknown.jsonl');
  const workspaceFile = join(root, 'workspace.json');
  await writeFile(workspaceFile, JSON.stringify({ cwd: first, workspaces: [first, second] }));
  const metadata = JSON.stringify({ [secondPath]: { pinned: true, archived: true, unread: true } });
  await writeFile(join(root, 'sessions-meta.json'), metadata);
  globalThis.__groupsRoot = root;
  globalThis.__groupsHandlers = new Map();
  const calls = [];
  const renamed = [];
  globalThis.__groupsAgent = {
    onEvent() {}, onBackgroundActivity() {}, dispose: async () => {},
    getSnapshot: async () => ({ cwd: first, sessionPath: firstPath, sessionId: 'first' }),
    async listSessions(cwd) {
      calls.push(cwd);
      return [{ path: cwd === first ? firstPath : cwd === second ? secondPath : unknownPath }];
    },
    async renameSession(...args) { renamed.push(args); },
  };
  const ipc = await import('../packages/desktop/src/main/ipc.ts?group-ipc');
  const { IPC_CHANNELS } = await import('../packages/shared/src/index.ts');
  const win = { isDestroyed: () => false, webContents: { mainFrame: {}, isDestroyed: () => false } };
  globalThis.__reviewWindow = win;
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  ipc.registerIpc();
  t.after(() => ipc.disposeServices());
  const list = () => globalThis.__groupsHandlers.get(IPC_CHANNELS.agentListSessionGroups)(event);
  const update = (change) => globalThis.__groupsHandlers.get(IPC_CHANNELS.agentUpdateSessionGroups)(event, change);
  assert.deepEqual(await list(), []);
  const [group] = await update({ type: 'create', name: 'Project mix' });
  await update({ type: 'move-session', sessionPath: firstPath, groupId: group.id });
  await update({ type: 'move-session', sessionPath: secondPath, groupId: group.id });
  assert.deepEqual((await list())[0].sessionPaths, [firstPath, secondPath]);
  const saved = await readFile(join(root, 'session-groups.json'), 'utf8');
  await assert.rejects(update({ type: 'move-session', sessionPath: unknownPath, groupId: group.id }), /未找到会话/);
  await assert.rejects(update({ type: 'move-session', sessionPath: 42, groupId: group.id }), /会话路径无效/);
  assert.ok(calls.every((cwd) => [first, second].includes(cwd)), 'unregistered projects are never scanned');
  assert.equal(await readFile(join(root, 'session-groups.json'), 'utf8'), saved);
  assert.equal(await readFile(join(root, 'sessions-meta.json'), 'utf8'), metadata);

  await globalThis.__groupsHandlers.get(IPC_CHANNELS.agentUpdateSessionMeta)(event, secondPath, { name: 'Renamed conversation' });
  assert.deepEqual(renamed, [[secondPath, 'Renamed conversation', second]], 'existing session metadata uses the same owner validation');

  const draftPath = join(root, 'unsaved.jsonl');
  const metaUpdate = (path, patch) => globalThis.__groupsHandlers.get(IPC_CHANNELS.agentUpdateSessionMeta)(event, path, patch);
  globalThis.__groupsAgent.getSnapshot = async () => ({ cwd: first, sessionPath: draftPath, sessionId: 'draft' });
  await metaUpdate(draftPath, { name: 'Named empty conversation' });
  assert.deepEqual(renamed.at(-1), [draftPath, 'Named empty conversation', first]);
  await assert.rejects(metaUpdate(draftPath, { pinned: true }), /未找到会话/, 'only naming can materialize a draft');
  await assert.rejects(metaUpdate(join(root, 'other-draft.jsonl'), { name: 'Wrong draft' }), /未找到会话/);
  globalThis.__groupsAgent.getSnapshot = async () => ({ cwd: unknown, sessionPath: draftPath, sessionId: 'draft' });
  await assert.rejects(metaUpdate(draftPath, { name: 'Unknown project' }), /未找到会话/);

  const reordered = Array.from({ length: 500 }, (_, index) => ({ path: join(root, `batch-${index}.jsonl`), order: index }));
  const originalList = globalThis.__groupsAgent.listSessions;
  globalThis.__groupsAgent.listSessions = async (cwd) => {
    calls.push(cwd);
    return reordered.filter((_, index) => (index % 2 === 0 ? first : second) === cwd);
  };
  calls.length = 0;
  const reorder = (entries) => globalThis.__groupsHandlers.get(IPC_CHANNELS.agentUpdateSessionOrders)(event, entries);
  await reorder(reordered);
  assert.equal(calls.filter((cwd) => cwd === first).length, 1);
  assert.equal(calls.filter((cwd) => cwd === second).length, 1);
  const orderedMeta = JSON.parse(await readFile(join(root, 'sessions-meta.json'), 'utf8'));
  assert.equal(orderedMeta[reordered[499].path].order, 499);
  const persistedBeforeFailure = await readFile(join(root, 'sessions-meta.json'), 'utf8');
  await assert.rejects(reorder([reordered[0], { path: unknownPath, order: 0 }]), /未找到会话/);
  assert.equal(await readFile(join(root, 'sessions-meta.json'), 'utf8'), persistedBeforeFailure, 'failed ownership checks cannot partially persist a batch');
  for (const invalid of [null, 32, '', 'relative.jsonl', `${secondPath}\0`, `${secondPath}\n`]) {
    await assert.rejects(metaUpdate(invalid, { pinned: true }), /会话路径无效/);
    await assert.rejects(globalThis.__groupsHandlers.get(IPC_CHANNELS.agentSwitchSession)(event, invalid), /会话路径无效/);
    await assert.rejects(globalThis.__groupsHandlers.get(IPC_CHANNELS.sessionDelete)(event, invalid), /会话路径无效/);
  }
  await assert.rejects(metaUpdate(secondPath, { name: 'x'.repeat(201) }), /会话名称无效/);
  await assert.rejects(metaUpdate(secondPath, { order: 1e10 }), /会话顺序无效/);
  globalThis.__groupsAgent.listSessions = originalList;

  await writeFile(workspaceFile, JSON.stringify({ cwd: first, workspaces: [first] }));
  calls.length = 0;
  await assert.rejects(update({ type: 'move-session', sessionPath: secondPath, groupId: null }), /未找到会话/);
  assert.ok(calls.every((cwd) => cwd === first), 'a cached owner must still be a known project');
  assert.equal(await readFile(join(root, 'session-groups.json'), 'utf8'), saved);
});
