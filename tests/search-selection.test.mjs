import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

const desktopRequire = createRequire(new URL('../packages/desktop/package.json', import.meta.url));
const typescript = desktopRequire('typescript');
const source = typescript.transpileModule(readFileSync(new URL('../packages/ui/src/components/SearchDialog.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: typescript.ModuleKind.CommonJS, jsx: typescript.JsxEmit.ReactJSX, target: typescript.ScriptTarget.ES2022 },
}).outputText;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// Exercise the component's event handlers and asynchronous effects without opening an app.
function mountSearch(bridge) {
  const hooks = [];
  const nodes = [];
  const effects = [];
  const timers = new Set();
  const opened = [];
  const document = { body: {}, activeElement: null, getElementById: () => null };
  const input = { focus() { document.activeElement = input; } };
  let cursor = 0;
  const jsx = (type, props) => {
    const node = { type, props };
    if (type === 'input' && props.ref) props.ref.current = input;
    nodes.push(node);
    return node;
  };
  const context = {
    exports: {}, document,
    setTimeout: (callback) => { timers.add(callback); return callback; },
    clearTimeout: (callback) => timers.delete(callback),
    require: (specifier) => {
      if (specifier === 'react') return {
        useState: (initial) => {
          const index = cursor++;
          if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
          return [hooks[index], (value) => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }];
        },
        useRef: (initial) => { const index = cursor++; return hooks[index] ??= { current: initial }; },
        useId: () => 'search-test', useMemo: (callback) => callback(), useLayoutEffect() {},
        useEffect: (callback, dependencies) => {
          const index = cursor++;
          const previous = hooks[index];
          if (previous && dependencies.every((value, offset) => Object.is(value, previous.dependencies[offset]))) return;
          effects.push(() => { previous?.cleanup?.(); hooks[index] = { dependencies, cleanup: callback() }; });
        },
      };
      if (specifier === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (specifier === 'react-dom') return { createPortal: (node) => node };
      if (specifier === '../store') return { useChatStore: (select) => select({ bridge, cwd: 'C:/project', workspaces: ['C:/project'] }) };
      if (specifier === '../i18n') return { useT: () => ({ t: (key) => key, locale: 'en-US' }) };
      if (specifier === './Icons') return { Icon: 'Icon' };
      return {};
    },
  };
  vm.runInNewContext(source, context);
  const render = () => {
    cursor = 0;
    nodes.length = 0;
    context.exports.SearchDialog({ commands: [], onClose() {}, onSelectSession: async (session) => opened.push(['session', session.path]), onSelectFile: (file) => opened.push(['file', file.path]) });
    for (const effect of effects.splice(0)) effect();
  };
  render();
  return {
    render, opened, nodes: () => nodes,
    query(value) { nodes.find((node) => node.type === 'input').props.onChange({ target: { value } }); render(); },
    runTimers() { for (const timer of Array.from(timers)) { timers.delete(timer); timer(); } },
    options: () => nodes.filter((node) => node.props.role === 'option'),
    labels: () => nodes.filter((node) => typeof node.props.children === 'string').map((node) => node.props.children),
    key(key) { input.focus(); nodes.find((node) => node.props.role === 'dialog').props.onKeyDown({ key, nativeEvent: {}, stopPropagation() {}, preventDefault() {} }); },
  };
}

test('search keeps the selected file when delayed session matches are inserted above it', async () => {
  const sessions = deferred();
  const files = deferred();
  const search = mountSearch({ searchSessions: () => sessions.promise, searchWorkspaceFiles: () => files.promise });
  search.query('match');
  search.runTimers();
  files.resolve({ files: [
    { kind: 'file', path: 'first-match.ts', name: 'first-match.ts' },
    { kind: 'file', path: 'selected-match.ts', name: 'selected-match.ts' },
  ], truncated: false });
  await new Promise((resolve) => setImmediate(resolve));
  search.render();
  search.key('ArrowDown');
  search.render();
  const selectedId = search.options().find((node) => node.props['aria-selected']).props.id;
  assert.match(selectedId, /selected-match/);

  sessions.resolve({ sessions: [{ path: 'session.jsonl', cwd: 'C:/project', firstMessage: 'Earlier match', modified: '2026-09-24T00:00:00Z' }], truncated: false });
  await new Promise((resolve) => setImmediate(resolve));
  search.render();
  assert.equal(search.options().find((node) => node.props['aria-selected']).props.id, selectedId);
  search.key('Enter');
  assert.deepEqual(search.opened, [['file', 'selected-match.ts']]);

  search.query('different');
  search.render();
  assert.equal(search.options().length, 0, 'changing the query must clear the previous result selection');
});

test('indexed search pages append stable identities and obsolete pages cannot overwrite a newer query', async () => {
  const oldPage = deferred();
  const row = (id) => ({ resultId: id, path: `${id}.jsonl`, cwd: 'C:/project', firstMessage: id, modified: '2026-09-26T00:00:00Z' });
  const calls = [], cancelled = [];
  const search = mountSearch({
    searchSessionsPage: async request => { calls.push(request); if (request.cursor) return oldPage.promise; return { sessions: [row(request.query)], total: 2, nextCursor: 'page-2', truncated: true }; },
    cancelDataSearch: async id => cancelled.push(id),
  });
  search.query('# old'); search.runTimers(); await new Promise(resolve => setImmediate(resolve)); search.render();
  search.nodes().find(node => node.props.className === 'pd-search-load-more').props.onClick();
  search.query('# new'); search.runTimers(); await new Promise(resolve => setImmediate(resolve)); search.render();
  oldPage.resolve({ sessions: [row('stale')], total: 2, truncated: false }); await new Promise(resolve => setImmediate(resolve)); search.render();
  assert.ok(search.options().some(node => node.props.id.includes('new')));
  assert.ok(!search.options().some(node => node.props.id.includes('stale')));
  assert.ok(calls.some(request => request.cursor === 'page-2')); assert.ok(cancelled.length);
});

test('content matches open the editor at their exact line and column', async () => {
  const opened = [];
  const search = mountSearch({ searchSessionsPage: async () => ({ sessions: [], truncated: false }),
    searchProjectFiles: async () => ({ files: [{ kind: 'file', resultId: 'a:7:4', path: 'src/a.ts', name: 'a.ts', line: 7, column: 4, snippet: 'needle' }], truncated: false, total: 1 }),
    openWorkspacePathInEditor: async (...args) => opened.push(args), cancelDataSearch: async () => {},
  });
  search.query('@needle'); search.runTimers(); await new Promise(resolve => setImmediate(resolve)); search.render(); search.key('Enter');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(opened, [['src/a.ts', 7, 4]]); assert.deepEqual(search.opened, []);
});

test('search shows skipped files separately from budget truncation and discloses ignored folders', async () => {
  const search = mountSearch({
    searchSessions: async () => ({ sessions: [], truncated: false, skipped: 1 }),
    searchWorkspaceFiles: async () => ({ files: [], truncated: false, skipped: 2, ignoredDirectories: ['.git', 'node_modules'] }),
  });
  search.query('source');
  search.runTimers();
  await new Promise((resolve) => setImmediate(resolve));
  search.render();
  assert.ok(search.labels().includes('search.skipped'));
  assert.ok(search.labels().includes('search.ignoredDirectories'));
  assert.ok(!search.labels().includes('search.truncated'));
});

test('keyboard retry refreshes only the failed search source and preserves successful file rows', async () => {
  let sessionCalls = 0, fileCalls = 0;
  const search = mountSearch({
    searchSessions: async () => { sessionCalls++; if (sessionCalls === 1) throw new Error('Session search unavailable'); return { sessions: [], truncated: false }; },
    searchWorkspaceFiles: async () => { fileCalls++; return { files: [{ kind: 'file', path: 'match.ts', name: 'match.ts' }], truncated: false }; },
  });
  search.query('match'); search.runTimers();
  await new Promise(resolve => setImmediate(resolve)); search.render();
  const successfulId = search.options().find(node => node.props.id.includes('file%3A')).props.id;
  search.key('ArrowDown'); search.render();
  assert.match(search.options().find(node => node.props['aria-selected']).props.id, /retry%3Asessions/);
  search.key('Enter'); search.render(); search.runTimers();
  assert.ok(search.options().some(node => node.props.id === successfulId));
  await new Promise(resolve => setImmediate(resolve)); search.render();
  assert.equal(sessionCalls, 2); assert.equal(fileCalls, 1);
  assert.ok(search.options().some(node => node.props.id === successfulId));
  assert.ok(!search.options().some(node => node.props.id.includes('retry%3A')));
  assert.deepEqual(search.opened, []);
});
