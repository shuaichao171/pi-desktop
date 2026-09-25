import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import * as themeColors from '../packages/ui/src/themeColors.ts';

const desktopRequire = createRequire(new URL('../packages/desktop/package.json', import.meta.url));
const typescript = desktopRequire('typescript');
const source = typescript.transpileModule(readFileSync(new URL('../packages/ui/src/components/AppShell.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: typescript.ModuleKind.CommonJS, jsx: typescript.JsxEmit.ReactJSX, target: typescript.ScriptTarget.ES2022 },
}).outputText;

function mountShell(storage) {
  const effects = [];
  const state = [];
  const styles = new Map();
  const document = { documentElement: { dataset: {}, style: {
    setProperty: (key, value) => styles.set(key, value), removeProperty: (key) => styles.delete(key),
  } }, querySelector: () => null };
  const context = {
    exports: {}, document, navigator: { userAgent: 'Windows' }, localStorage: storage,
    window: { localStorage: storage, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} },
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
      // The real module runs outside this VM realm. Inject its supported storage
      // dependency so it observes this mount's browser storage, including errors.
      if (specifier === '../themeColors') return {
        ...themeColors,
        readColorPreferences: () => themeColors.readColorPreferences(context.window.localStorage),
        writeColorPreferences: (prefs) => themeColors.writeColorPreferences(prefs, context.window.localStorage),
      };
      return {};
    },
  };
  vm.runInNewContext(source, context);
  context.exports.AppShell();
  const cleanups = effects.map((effect) => effect());
  for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup();
  return { state, theme: document.documentElement.dataset.theme, styles };
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

test('AppShell applies the saved palette for the active mode while preserving the other mode', () => {
  const prefs = { light: themeColors.getPresetColors('sand', 'light'), dark: themeColors.getPresetColors('forest', 'dark') };
  const stored = new Map([['pi-desktop.theme', 'dark'], ['pi-desktop.colors.v1', JSON.stringify(prefs)]]);
  const mounted = mountShell({ getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) });
  assert.equal(mounted.theme, 'dark');
  for (const [key, value] of Object.entries(themeColors.buildThemeTokens(prefs.dark, 'dark'))) assert.equal(mounted.styles.get(key), value);
  assert.deepEqual(JSON.parse(stored.get('pi-desktop.colors.v1')), prefs);
  stored.set('pi-desktop.colors.v1', '{corrupt');
  const recovered = mountShell({ getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) });
  assert.equal(recovered.theme, 'dark');
  assert.equal(recovered.styles.size, 0, 'invalid palette data returns to the default CSS without residual color overrides');
});
