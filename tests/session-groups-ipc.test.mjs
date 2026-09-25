import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const stubs = {
  electron: `
    export const app = { getPath: () => globalThis.__groupsRoot };
    export const BrowserWindow = { getAllWindows: () => [] };
    export const Menu = { buildFromTemplate: () => ({}) };
    export const nativeImage = { createFromPath: () => ({ isEmpty: () => true }) };
    export const Tray = class {};
    export const dialog = { showErrorBox: () => {} };
    export const ipcMain = { handle: (channel, handler) => globalThis.__groupsHandlers.set(channel, handler) };
  `,
  './agentClient': 'export const createIsolatedAgentService = () => globalThis.__groupsAgent;',
  './updateService': 'export const updateService = {};',
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
  ipc.registerIpc();
  t.after(() => ipc.disposeServices());
  const list = () => globalThis.__groupsHandlers.get(IPC_CHANNELS.agentListSessionGroups)({});
  const update = (change) => globalThis.__groupsHandlers.get(IPC_CHANNELS.agentUpdateSessionGroups)({}, change);
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

  await globalThis.__groupsHandlers.get(IPC_CHANNELS.agentUpdateSessionMeta)({}, secondPath, { name: 'Renamed conversation' });
  assert.deepEqual(renamed, [[secondPath, 'Renamed conversation', second]], 'existing session metadata uses the same owner validation');

  const draftPath = join(root, 'unsaved.jsonl');
  const metaUpdate = (path, patch) => globalThis.__groupsHandlers.get(IPC_CHANNELS.agentUpdateSessionMeta)({}, path, patch);
  globalThis.__groupsAgent.getSnapshot = async () => ({ cwd: first, sessionPath: draftPath, sessionId: 'draft' });
  await metaUpdate(draftPath, { name: 'Named empty conversation' });
  assert.deepEqual(renamed.at(-1), [draftPath, 'Named empty conversation', first]);
  await assert.rejects(metaUpdate(draftPath, { pinned: true }), /未找到会话/, 'only naming can materialize a draft');
  await assert.rejects(metaUpdate(join(root, 'other-draft.jsonl'), { name: 'Wrong draft' }), /未找到会话/);
  globalThis.__groupsAgent.getSnapshot = async () => ({ cwd: unknown, sessionPath: draftPath, sessionId: 'draft' });
  await assert.rejects(metaUpdate(draftPath, { name: 'Unknown project' }), /未找到会话/);
  await writeFile(workspaceFile, JSON.stringify({ cwd: first, workspaces: [first] }));
  calls.length = 0;
  await assert.rejects(update({ type: 'move-session', sessionPath: secondPath, groupId: null }), /未找到会话/);
  assert.ok(calls.every((cwd) => cwd === first), 'a cached owner must still be a known project');
  assert.equal(await readFile(join(root, 'session-groups.json'), 'utf8'), saved);
});
