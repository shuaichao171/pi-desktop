import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: `data:text/javascript,${encodeURIComponent(`
    export const BrowserWindow = { fromWebContents: sender => globalThis.__dataWindow?.webContents === sender ? globalThis.__dataWindow : null };
    export const ipcMain = { handle: (channel, handler) => globalThis.__dataHandlers.set(channel, handler) };
    export const dialog = { showSaveDialog: (...args) => globalThis.__dataSaveDialog(...args), showOpenDialog: (...args) => globalThis.__dataOpenDialog(...args) };
  `)}`, shortCircuit: true };
  if (specifier.startsWith('./') && context.parentURL?.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
  return next(specifier, context);
} });
const { registerDataFeaturesIpc } = await import('../packages/desktop/src/main/dataFeaturesIpc.ts');
const { createSessionTrash } = await import('../packages/desktop/src/main/sessionTrash.ts');
const { piSessionDirectory } = await import('../packages/desktop/src/main/indexedSearch.ts');
const { DATA_FEATURE_CHANNELS: channels } = await import('../packages/shared/src/dataFeatures.ts');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-data-ipc-')), cwd = join(root, 'project'), sessionsRoot = join(root, 'sessions');
  t.after(() => rm(root, { recursive: true, force: true })); await mkdir(cwd); await mkdir(piSessionDirectory(sessionsRoot, cwd), { recursive: true });
  const source = join(piSessionDirectory(sessionsRoot, cwd), 'original.jsonl');
  await writeFile(source, JSON.stringify({ type: 'session', version: 3, id: 'original', cwd, timestamp: new Date().toISOString() }) + '\n');
  globalThis.__dataHandlers = new Map();
  const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false, mainFrame: {} } }; globalThis.__dataWindow = win;
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const trash = createSessionTrash(() => join(root, 'session-trash'));
  const context = { userData: root, sessionsRoot, trash, getWorkspace: () => cwd, getWorkspaces: async () => [cwd],
    listSources: async () => [{ path: source, cwd }], applyMetadata: async () => {}, removeMetadata: async () => {},
    isSessionRunning: async () => false, releaseSessionInputs: async () => {}, searchSessions: async () => {}, searchFiles: async () => {},
    rebuildIndex: async () => ({ indexed: 0 }), cancelSearch: async () => {}, getSearchRules: async () => ({}), setSearchRules: async () => {} };
  return { root, cwd, source, event, trash, context, invoke: (channel, ...args) => globalThis.__dataHandlers.get(channel)(event, ...args) };
}

test('restoration IPC rolls back partially written metadata before removing its destination and supports retry', async t => {
  const f = await fixture(t), applied = new Set(), rolledBack = []; let fail = true;
  const trashPath = await f.trash.trashSession(f.source, { cwd: f.cwd, metadata: { pinned: true } });
  f.context.applyMetadata = async items => { for (const item of items) applied.add(item.path); if (fail) throw new Error('group metadata failed'); };
  f.context.removeMetadata = async paths => { rolledBack.push(...paths); for (const path of paths) applied.delete(path); };
  registerDataFeaturesIpc(f.context);
  const request = { id: basename(trashPath), cwd: f.cwd };
  await assert.rejects(f.invoke(channels.restoreSessionTrash, request), /group metadata failed/);
  assert.deepEqual(rolledBack, [f.source]); assert.equal(applied.size, 0); await assert.rejects(readFile(f.source), { code: 'ENOENT' });
  assert.equal((await f.trash.list()).entries.length, 1);
  fail = false; assert.equal((await f.invoke(channels.restoreSessionTrash, request)).path, f.source);
  assert.equal(applied.has(f.source), true); assert.equal((await f.trash.list()).entries.length, 0);
});

test('backup IPC rechecks running sources after the picker and rejects foreign or destroyed renderers', async t => {
  const f = await fixture(t), output = join(f.root, 'export.pibackup'); let reads = 0;
  f.context.listSources = async () => { reads++; if (reads === 2) throw new Error('session started while picker open'); return [{ path: f.source, cwd: f.cwd }]; };
  globalThis.__dataSaveDialog = async () => ({ canceled: false, filePath: output });
  registerDataFeaturesIpc(f.context);
  assert.throws(() => globalThis.__dataHandlers.get(channels.listSessionTrash)({ ...f.event, senderFrame: {} }), /Invalid renderer/);
  await assert.rejects(f.invoke(channels.exportSessionsBackup), /session started/); assert.equal(reads, 2);
  await assert.rejects(readFile(output), { code: 'ENOENT' });
  globalThis.__dataSaveDialog = async () => { globalThis.__dataWindow = null; return { canceled: false, filePath: output }; };
  await assert.rejects(f.invoke(channels.exportSessionsBackup), /window is no longer/);
  assert.equal(reads, 3, 'destroyed sender is rejected before source enumeration resumes');
});

test('import IPC rejects a target workspace removed while the picker was open', async t => {
  const f = await fixture(t); let open = true;
  f.context.getWorkspaces = async () => open ? [f.cwd] : [];
  globalThis.__dataOpenDialog = async () => { open = false; return { canceled: false, filePaths: [f.source] }; };
  registerDataFeaturesIpc(f.context);
  await assert.rejects(f.invoke(channels.importSessions, 'native', f.cwd), /目标工作区/);
  await assert.rejects(readFile(join(f.root, 'session-import-journal')), { code: 'ENOENT' });
});
