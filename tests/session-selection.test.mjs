import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeEach, test } from 'node:test';
import vm from 'node:vm';
import { useChatStore } from '../packages/ui/src/store.ts';
import { clampWorkbenchWidth } from '../packages/ui/src/workbenchReading.ts';
import * as shortcutBindings from '../packages/ui/src/shortcuts/bindings.ts';

const desktopRequire = createRequire(new URL('../packages/desktop/package.json', import.meta.url));
const typescript = desktopRequire('typescript');
const source = typescript.transpileModule(readFileSync(new URL('../packages/ui/src/components/AppShell.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: typescript.ModuleKind.CommonJS, jsx: typescript.JsxEmit.ReactJSX, target: typescript.ScriptTarget.ES2022 },
}).outputText;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function mountSearch() {
  const states = [];
  const nodes = [];
  const updates = [];
  let cursor = 0;
  const jsx = (type, props) => { const node = { type, props }; nodes.push(node); return node; };
  const context = {
    exports: {}, navigator: { userAgent: 'Windows' }, localStorage: { getItem: () => null },
    window: { innerWidth: 1440, matchMedia: () => ({ matches: false }) },
    require: (specifier) => {
      if (specifier === 'react') return {
        useEffect() {}, useLayoutEffect() {}, useRef: (value) => ({ current: value }),
        useState: (initial) => {
          const index = cursor++;
          if (index >= states.length) states.push(typeof initial === 'function' ? initial() : initial);
          return [states[index], (value) => { states[index] = value; updates.push(value); }];
        },
      };
      if (specifier === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (specifier === '../store') return { useChatStore: Object.assign((select) => select(useChatStore.getState()), { getState: useChatStore.getState }) };
      if (specifier === '../i18n') return { useT: () => ({ t: (value) => value }) };
      if (specifier === '../useSessionNavigation') return { useSessionNavigation: () => ({}) };
      if (specifier === '../workbenchReading') return { clampWorkbenchWidth };
      if (specifier === '../shortcuts/bindings') return shortcutBindings;
      return new Proxy({}, { get: (_, name) => name });
    },
  };
  vm.runInNewContext(source, context);
  context.exports.AppShell();
  nodes.find((node) => node.type === 'Sidebar').props.onOpenSearch();
  cursor = 0;
  nodes.length = 0;
  context.exports.AppShell();
  updates.length = 0;
  return { select: nodes.find((node) => node.type === 'SearchDialog').props.onSelectSession, updates };
}

function fixture() {
  const calls = [];
  const bridge = {
    async switchWorkspace(cwd) {
      calls.push(['workspace', cwd]);
      useChatStore.setState({ cwd, sessionId: 'restored', sessionPath: `${cwd}/restored.jsonl` });
    },
    async switchSession(path) {
      calls.push(['session', path]);
      useChatStore.setState({ sessionId: path, sessionPath: path });
    },
    listWorkspaces: async () => ['C:/original', 'D:/other'],
    listSessions: async () => [],
  };
  useChatStore.setState({ bridge, cwd: 'C:/original', sessionId: 'original', sessionPath: 'C:/original/one.jsonl', status: 'idle' });
  return { bridge, calls };
}

beforeEach(() => useChatStore.setState(useChatStore.getInitialState(), true));

test('a superseded search selection cannot open its session after an older workspace switch completes', async () => {
  const host = fixture();
  const search = mountSearch();
  const switching = deferred();
  const switchWorkspace = host.bridge.switchWorkspace;
  host.bridge.switchWorkspace = async (cwd) => { await switchWorkspace(cwd); await switching.promise; };
  const selecting = search.select({ cwd: 'D:/other', path: 'D:/other/old.jsonl', snippet: 'old match' });
  await new Promise((resolve) => setImmediate(resolve));
  await useChatStore.getState().switchSession('D:/other/newer.jsonl');
  switching.resolve();
  await selecting;
  assert.deepEqual(host.calls.filter(([kind]) => kind === 'session'), [['session', 'D:/other/newer.jsonl']]);
  assert.equal(useChatStore.getState().sessionPath, 'D:/other/newer.jsonl');
  assert.deepEqual(search.updates, [], 'an obsolete result must not set a message highlight or change panels');
  assert.equal(useChatStore.getState().navigationPending, false);
});

test('search selection keeps one navigation intent pending until its final refresh and highlight', async () => {
  const host = fixture();
  const search = mountSearch();
  const refresh = deferred();
  host.bridge.listSessions = () => refresh.promise;
  const selecting = search.select({ cwd: 'D:/other', path: 'D:/other/target.jsonl', messageId: 'match', snippet: 'found' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(host.calls, [['workspace', 'D:/other'], ['session', 'D:/other/target.jsonl']]);
  assert.equal(useChatStore.getState().navigationRequestId, 1);
  assert.equal(useChatStore.getState().navigationPending, true);
  assert.deepEqual(search.updates, []);
  refresh.resolve([]);
  await selecting;
  assert.equal(useChatStore.getState().navigationPending, false);
  assert.ok(search.updates.includes('chat'), 'a completed search selection returns from automations to the conversation');
  const highlights = search.updates.filter((value) => value && typeof value === 'object' && 'messageId' in value);
  assert.equal(highlights.length, 1);
  assert.equal(highlights[0].messageId, 'match');
});

test('superseded selections discard late refresh completion, stale errors and replacement-bridge effects', async () => {
  for (const stage of ['refresh', 'workspace-error', 'replacement']) {
    useChatStore.setState(useChatStore.getInitialState(), true);
    const host = fixture();
    const search = mountSearch();
    const pending = deferred();
    if (stage === 'refresh') host.bridge.listSessions = () => pending.promise;
    else host.bridge.switchWorkspace = () => pending.promise;
    const selecting = search.select({ cwd: 'D:/other', path: 'D:/other/old.jsonl', snippet: 'old match' });
    await new Promise((resolve) => setImmediate(resolve));
    if (stage === 'replacement') { useChatStore.setState(useChatStore.getInitialState(), true); fixture(); }
    else {
      host.bridge.listSessions = async () => [];
      await useChatStore.getState().switchSession('newer.jsonl');
    }
    const previousCalls = host.calls.length;
    if (stage === 'workspace-error') pending.reject(new Error('obsolete workspace unavailable'));
    else pending.resolve([]);
    await selecting;
    assert.equal(host.calls.length, previousCalls, stage);
    assert.deepEqual(search.updates, [], stage);
    assert.equal(useChatStore.getState().error, null, stage);
    assert.equal(useChatStore.getState().navigationPending, false, stage);
  }
});

test('a current selection failure reaches the caller and releases navigation pending state', async () => {
  const host = fixture();
  host.bridge.switchSession = async () => { throw new Error('session removed'); };
  await assert.rejects(useChatStore.getState().selectSession('D:/other', 'missing.jsonl'), /session removed/);
  assert.equal(useChatStore.getState().error, 'session removed');
  assert.equal(useChatStore.getState().navigationPending, false);
});
