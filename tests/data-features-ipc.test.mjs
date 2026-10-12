import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: `data:text/javascript,${encodeURIComponent(`
    export const BrowserWindow = { fromWebContents: sender => globalThis.__dataWindow?.webContents === sender ? globalThis.__dataWindow : null };
    export const ipcMain = { handle: (channel, handler) => globalThis.__dataHandlers.set(channel, handler) };
  `)}`, shortCircuit: true };
  if (specifier.startsWith('./') && context.parentURL?.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
  return next(specifier, context);
} });
const { registerDataFeaturesIpc } = await import('../packages/desktop/src/main/dataFeaturesIpc.ts');
const { DATA_FEATURE_CHANNELS: channels } = await import('../packages/shared/src/dataFeatures.ts');

const event = () => {
  const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false, mainFrame: {} } };
  globalThis.__dataWindow = win;
  return { sender: win.webContents, senderFrame: win.webContents.mainFrame };
};

function harness() {
  globalThis.__dataHandlers = new Map();
  const calls = [];
  const cwd = 'C:/review/project';
  const context = {
    getWorkspace: () => cwd,
    getWorkspaces: async () => [cwd],
    searchSessions: async request => { calls.push(['sessions', request]); return { sessions: [], total: 0, truncated: false, diagnostics: { elapsedMs: 0, filesRead: 0, bytesRead: 0, indexed: 0 } }; },
    searchFiles: async (target, request) => { calls.push(['files', target, request]); return { files: [], total: 0, truncated: false, ignoredDirectories: [], skipReasons: { binary: 0, large: 0, unreadable: 0, ignored: 0 }, rules: { ignoredDirectories: [], include: [], exclude: [], maxFileBytes: 0 }, diagnostics: { elapsedMs: 0, filesRead: 0, bytesRead: 0, indexed: 0 } }; },
    cancelSearch: async id => { calls.push(['cancel', id]); },
  };
  registerDataFeaturesIpc(context);
  return { calls, invoke: (channel, ...args) => globalThis.__dataHandlers.get(channel)(event(), ...args) };
}

test('search IPC forwards session searches and forwards cancellation', async () => {
  const { calls, invoke } = harness();
  const page = await invoke(channels.searchSessionsPage, { query: 'hover' });
  assert.equal(page.total, 0);
  await invoke(channels.cancelDataSearch, 'request-1');
  assert.deepEqual(calls.map(call => call[0]), ['sessions', 'cancel']);
});

function harnessWithWorkspace(workspace, registered) {
  globalThis.__dataHandlers = new Map();
  const calls = [];
  registerDataFeaturesIpc({
    getWorkspace: () => workspace,
    getWorkspaces: async () => registered,
    searchSessions: async () => { throw new Error('unused'); },
    searchFiles: async (target, request) => { calls.push([target, request]); return { files: [], total: 0, truncated: false, ignoredDirectories: [], skipReasons: { binary: 0, large: 0, unreadable: 0, ignored: 0 }, rules: { ignoredDirectories: [], include: [], exclude: [], maxFileBytes: 0 }, diagnostics: { elapsedMs: 0, filesRead: 0, bytesRead: 0, indexed: 0 } }; },
    cancelSearch: async () => {},
  });
  return { calls, invoke: (channel, ...args) => globalThis.__dataHandlers.get(channel)(event(), ...args) };
}

test('project search forwards the registered workspace and rejects unknown ones', async () => {
  const registered = harnessWithWorkspace('C:/review/project', ['C:/review/project']);
  await registered.invoke(channels.searchProjectFiles, { query: 'maskImage' });
  assert.equal(registered.calls[0][0], 'C:/review/project');
  const unknown = harnessWithWorkspace('C:/unknown/workspace', ['C:/review/project']);
  await assert.rejects(unknown.invoke(channels.searchProjectFiles, { query: 'x' }), /请选择已打开的目标工作区/);
  assert.equal(unknown.calls.length, 0);
});

test('the removed trash, import, rules and rebuild channels are no longer registered', () => {
  harness();
  for (const channel of ['data:trash:list', 'data:trash:restore', 'data:trash:cleanup', 'data:trash:retention', 'data:sessions:import', 'data:sessions:backup', 'data:search:rules:get', 'data:search:rules:set', 'data:search:rebuild']) {
    assert.equal(globalThis.__dataHandlers.has(channel), false, `${channel} should be gone`);
  }
});
