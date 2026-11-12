import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

const stubs = {
  electron: `
    export const app = { getPath: () => globalThis.__hcRoot };
    export const nativeTheme = { shouldUseDarkColors: false };
    export const shell = { showItemInFolder: () => {} };
    export const powerSaveBlocker = { start: () => 1, stop: () => {}, isStarted: () => false };
    export const BrowserWindow = { getAllWindows: () => globalThis.__hcWindows ?? [], fromWebContents: (sender) => globalThis.__hcWindows?.find((win) => win.webContents === sender) ?? null };
    export const Menu = { buildFromTemplate: () => ({}) };
    export const nativeImage = { createFromPath: () => ({ isEmpty: () => true }) };
    export const Tray = class {};
    export const WebContentsView = class {};
    export const dialog = { showErrorBox: () => {} };
    export const Notification = class { static isSupported() { return false; } on() { return this; } show() {} };
    export const ipcMain = { handle: (channel, handler) => globalThis.__hcHandlers.set(channel, handler) };
  `,
  './agentClient': 'export const createIsolatedAgentService = () => globalThis.__hcAgent;',
  './updateService': 'export const updateService = { stop() {}, setAutoInstallSource() {} };',
  './workbenchIpc': 'export const registerWorkbenchIpc = () => ({ reset: async () => {}, dispose: async () => {} });',
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (stubs[specifier]) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
    if (specifier.startsWith('./') && context.parentURL && new URL(context.parentURL).pathname.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

function createWindow() {
  const win = Object.assign(new EventEmitter(), {
    sent: [],
    isDestroyed: () => false,
    webContents: { mainFrame: {}, isDestroyed: () => false, send: (...args) => win.sent.push(args) },
  });
  return win;
}

test('hidden-context IPC round-trips, broadcasts, enforces the cap, and clears on session deletion', async (t) => {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, 'pi-hidden-ipc-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const workspace = join(root, 'project');
  const sessionPath = join(root, 'project', 'a.jsonl');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(root, 'workspace.json'), JSON.stringify({ cwd: workspace, workspaces: [workspace] }));
  await writeFile(sessionPath, '{"type":"session","cwd":' + JSON.stringify(workspace) + '}\n');

  const win = createWindow();
  globalThis.__hcRoot = root;
  globalThis.__hcWindows = [win];
  globalThis.__hcHandlers = new Map();
  globalThis.__hcAgent = {
    onEvent() {}, onBackgroundActivity() {}, dispose: async () => {},
    getSnapshot: async () => ({ cwd: workspace, sessionPath: join(root, 'project', 'other.jsonl'), sessionId: 'other' }),
    listSessions: async () => [{ path: sessionPath }, { path: join(root, 'project', 'other.jsonl') }],
    prepareSessionDeletion: async () => {},
    releaseSessionDeletion: async () => {},
  };
  const ipc = await import('../packages/desktop/src/main/ipc.ts?hidden-context');
  const { HIDDEN_CONTEXT_CHANNELS } = await import('../packages/shared/src/hiddenContext.ts');
  const { HIDDEN_CONTEXT_MAX_CHARS } = await import('../packages/shared/src/hiddenContext.ts');
  const { IPC_CHANNELS } = await import('../packages/shared/src/index.ts');
  ipc.registerIpc();
  t.after(() => ipc.disposeServices());
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const storeFile = join(root, 'hidden-context.json');

  // get before any write: no instruction, no placeholder record.
  assert.equal(await globalThis.__hcHandlers.get(HIDDEN_CONTEXT_CHANNELS.get)(event, sessionPath), '');

  await globalThis.__hcHandlers.get(HIDDEN_CONTEXT_CHANNELS.set)(event, sessionPath, '回答前先列出计划');
  assert.deepEqual(JSON.parse(await readFile(storeFile, 'utf8')), { version: 1, contexts: { [sessionPath]: '回答前先列出计划' } });
  assert.equal(await globalThis.__hcHandlers.get(HIDDEN_CONTEXT_CHANNELS.get)(event, sessionPath), '回答前先列出计划');
  assert.deepEqual(win.sent.at(-1), [HIDDEN_CONTEXT_CHANNELS.changed, sessionPath, '回答前先列出计划'], 'every renderer hears the change');

  await assert.rejects(async () => { await globalThis.__hcHandlers.get(HIDDEN_CONTEXT_CHANNELS.set)(event, sessionPath, 'x'.repeat(HIDDEN_CONTEXT_MAX_CHARS + 1)); }, /不能超过 8000 字符/);
  await assert.rejects(async () => { await globalThis.__hcHandlers.get(HIDDEN_CONTEXT_CHANNELS.set)(event, sessionPath, '带\u0000空字节'); }, /隐藏指令内容无效/);
  await assert.rejects(async () => { await globalThis.__hcHandlers.get(HIDDEN_CONTEXT_CHANNELS.get)(event, 'relative\\path.jsonl'); }, /会话路径无效/, 'keys are normalized session paths');

  // Session deletion forgets the instruction alongside the branch/side-question records.
  // No changed broadcast is needed here: main refuses to delete the loaded session,
  // so no pane is still bound to the deleted path (same as side-question clears).
  win.sent.length = 0;
  await globalThis.__hcHandlers.get(IPC_CHANNELS.sessionDelete)(event, sessionPath);
  assert.equal(existsSync(sessionPath), false, 'the transcript itself is gone');
  assert.deepEqual(JSON.parse(await readFile(storeFile, 'utf8')), { version: 1, contexts: {} }, 'deleting a conversation clears its hidden instruction');
  assert.deepEqual(win.sent.filter(([channel]) => channel === HIDDEN_CONTEXT_CHANNELS.changed), []);
});
