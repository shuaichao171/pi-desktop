import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const stubs = {
  electron: `
    export const app = { getPath: () => globalThis.__searchRoot };
    export const BrowserWindow = { getAllWindows: () => [] };
    export const Menu = { buildFromTemplate: () => ({}) };
    export const nativeImage = { createFromPath: () => ({ isEmpty: () => true }) };
    export const Tray = class {};
    export const dialog = { showErrorBox: () => {} };
    export const ipcMain = { handle: (channel, handler) => globalThis.__searchHandlers.set(channel, handler) };
  `,
  './agentClient': `export const createIsolatedAgentService = () => globalThis.__searchAgent;`,
  './updateService': `export const updateService = {};`,
  './workbenchIpc': `export const registerWorkbenchIpc = () => ({ reset: async () => {}, dispose: async () => {} });`,
  './stateFiles': `
    export class CorruptStateFileError extends Error {}
    export const backupCorruptStateFile = () => '';
    export const backupCorruptStateFileAsync = async () => '';
    export const readStateFile = () => globalThis.__searchWorkspaces;
    export async function readStateFileAsync(path) {
      if (path.endsWith('sessions-meta.json')) return globalThis.__searchMeta;
      if (globalThis.__searchWorkspaceGate) {
        const gate = globalThis.__searchWorkspaceGate;
        globalThis.__searchWorkspaceGate = null;
        await gate;
      }
      return globalThis.__searchWorkspaces;
    }
    export const writeStateFile = () => {};
    export const writeStateFileAsync = async () => {};
  `,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (stubs[specifier]) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
    if (specifier.startsWith('./') && context.parentURL && new URL(context.parentURL).pathname.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

test('search IPC uses registered workspaces, preserves metadata and does not dispatch outdated searches', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-search-ipc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'one');
  const second = join(root, 'two');
  await Promise.all([mkdir(first), mkdir(second)]);
  const path = join(root, 'session.jsonl');
  const calls = [];
  const contextCalls = [];
  const fileSearchCalls = [];
  globalThis.__searchRoot = root;
  globalThis.__searchHandlers = new Map();
  globalThis.__searchWorkspaces = { cwd: first, workspaces: [first, second, join(root, 'missing')] };
  globalThis.__searchMeta = { [path]: { pinned: true, archived: true, unread: true } };
  globalThis.__searchAgent = {
    onEvent() {}, onBackgroundActivity() {}, dispose: async () => {},
    async searchSessions(workspaces, query) {
      calls.push({ workspaces, query });
      return { sessions: [{ path, id: 'session', cwd: second, firstMessage: 'result', modified: new Date().toISOString(), messageCount: 1, messageId: 'message', snippet: 'needle result' }], truncated: false };
    },
    async searchWorkspaceFiles(cwd, query, options) { fileSearchCalls.push({ cwd, query, options }); return { files: [{ name: query, path: cwd, kind: 'file' }], truncated: false }; },
    async listSessions(cwd) { return cwd === second ? [{ path, id: 'session' }] : []; },
    async readSessionContext(cwd, sessionPath) { contextCalls.push({ cwd, path: sessionPath }); return { kind: 'text', name: 'context.txt', mimeType: 'text/x-pi-session-context', text: 'Visible context', source: { kind: 'session', workspace: cwd, path: sessionPath } }; },
  };
  const ipc = await import('../packages/desktop/src/main/ipc.ts?search-ipc');
  const { IPC_CHANNELS } = await import('../packages/shared/src/index.ts');
  ipc.defaultWorkspace();
  ipc.registerIpc();
  const search = globalThis.__searchHandlers.get(IPC_CHANNELS.agentSearchSessions);
  const result = await search({}, 'needle');
  assert.deepEqual(calls[0], { workspaces: [first, second], query: 'needle' });
  assert.deepEqual({ pinned: result.sessions[0].pinned, archived: result.sessions[0].archived, unread: result.sessions[0].unread }, { pinned: true, archived: true, unread: true });
  assert.equal(result.sessions[0].messageId, 'message');
  const files = await globalThis.__searchHandlers.get(IPC_CHANNELS.workspaceSearchFiles)({}, 'file.ts');
  assert.equal(files.files[0].path, first);
  assert.equal(fileSearchCalls[0].options, undefined);
  await globalThis.__searchHandlers.get(IPC_CHANNELS.workspaceSearchFiles)({}, 'src', { includeDirectories: true });
  assert.deepEqual(fileSearchCalls.at(-1), { cwd: first, query: 'src', options: { includeDirectories: true } });

  let release;
  globalThis.__searchWorkspaceGate = new Promise((resolve) => { release = resolve; });
  const stale = search({}, 'old');
  await search({}, 'new');
  release();
  assert.deepEqual(await stale, { sessions: [], truncated: true });
  assert.deepEqual(calls.map((call) => call.query), ['needle', 'new']);

  const context = globalThis.__searchHandlers.get(IPC_CHANNELS.contextRead);
  await assert.rejects(context({}, { kind: 'file', workspace: root, path: 'private.txt' }), /未知工作区/);
  await assert.rejects(context({}, { kind: 'session', workspace: first, path }), /不属于/);
  await assert.rejects(context({}, { kind: 'session', workspace: second, path: join(root, 'unknown.jsonl') }), /未找到会话/);
  assert.equal(contextCalls.length, 0, 'unregistered and mismatched owners must be rejected before dispatch');
  const sessionContext = await context({}, { kind: 'session', workspace: second, path });
  assert.deepEqual(contextCalls, [{ cwd: second, path }]);
  assert.equal(sessionContext.source.workspace, second, 'context from an inactive workspace must not switch the active workspace');
  await writeFile(join(first, 'known.txt'), 'not read into context');
  const fileContext = await context({}, { kind: 'file', workspace: first, path: 'known.txt' });
  assert.equal(fileContext.source.path, 'known.txt');
  assert.doesNotMatch(fileContext.text, /not read into context/);
  assert.equal((await globalThis.__searchHandlers.get(IPC_CHANNELS.workspaceSearchFiles)({}, 'after.txt')).files[0].path, first);
  await ipc.disposeServices();
});
