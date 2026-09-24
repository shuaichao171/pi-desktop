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
      if (specifier === '../store') return { useChatStore: (select) => select({ bridge, cwd: 'C:/project' }) };
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
    render, opened,
    query(value) { nodes.find((node) => node.type === 'input').props.onChange({ target: { value } }); render(); },
    runTimers() { for (const timer of Array.from(timers)) { timers.delete(timer); timer(); } },
    options: () => nodes.filter((node) => node.props.role === 'option'),
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
