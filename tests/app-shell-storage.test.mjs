import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

const desktopRequire = createRequire(new URL('../packages/desktop/package.json', import.meta.url));
const typescript = desktopRequire('typescript');
const source = typescript.transpileModule(readFileSync(new URL('../packages/ui/src/components/AppShell.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: typescript.ModuleKind.CommonJS, jsx: typescript.JsxEmit.ReactJSX, target: typescript.ScriptTarget.ES2022 },
}).outputText;

function mountShell(storage) {
  const effects = [];
  const state = [];
  const document = { documentElement: { dataset: {}, style: {} }, querySelector: () => null };
  const context = {
    exports: {}, document, navigator: { userAgent: 'Windows' }, localStorage: storage,
    window: { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} },
    require: (specifier) => {
      if (specifier === 'react') return {
        useEffect: (callback) => effects.push(callback), useLayoutEffect: (callback) => effects.push(callback),
        useRef: (value) => ({ current: value }),
        useState: (initial) => {
          const value = typeof initial === 'function' ? initial() : initial;
          state.push(value);
          return [value, () => {}];
        },
      };
      if (specifier === 'react/jsx-runtime') return { jsx() {}, jsxs() {} };
      if (specifier === '../store') return { useChatStore: (select) => select({ appInfo: { platform: 'win32' } }) };
      if (specifier === '../i18n') return { useT: () => ({ t: (value) => value }) };
      if (specifier === '../useSessionNavigation') return { useSessionNavigation: () => ({}) };
      return {};
    },
  };
  vm.runInNewContext(source, context);
  context.exports.AppShell();
  const cleanups = effects.map((effect) => effect());
  for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup();
  return { state, theme: document.documentElement.dataset.theme };
}

test('AppShell remains mountable when preference storage is blocked or full', () => {
  const unavailable = () => { throw new DOMException('Storage is blocked', 'SecurityError'); };
  const full = () => { throw new DOMException('Storage is full', 'QuotaExceededError'); };
  const fallback = mountShell({ getItem: unavailable, setItem: unavailable });
  assert.equal(fallback.theme, 'light');
  assert.ok(fallback.state.includes(274));
  assert.ok(fallback.state.includes('system'));
  const stored = new Map([['pi-desktop.theme', 'dark'], ['pi-desktop.sidebar-width', '330']]);
  const quota = mountShell({ getItem: (key) => stored.get(key) ?? null, setItem: full });
  assert.equal(quota.theme, 'dark');
  assert.ok(quota.state.includes(330));
});
