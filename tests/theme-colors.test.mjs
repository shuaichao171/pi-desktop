import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  COLOR_PRESET_IDS, applyThemeColors, buildThemeTokens, defaultColorPreferences,
  getPresetColors, normalizeColorPreferences, normalizeHexColor, readColorPreferences, writeColorPreferences,
} from '../packages/ui/src/themeColors.ts';

const luminance = color => {
  const rgb = [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
};
const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
const backgrounds = ['bg', 'sidebar', 'header', 'surface', 'surface-hover', 'surface-raised', 'surface-muted', 'selected', 'user-surface', 'code-surface'];

test('color input accepts only explicit opaque hex colors and normalizes shorthand', () => {
  assert.equal(normalizeHexColor(' #AbC '), '#aabbcc');
  assert.equal(normalizeHexColor('#123abc'), '#123abc');
  assert.equal(normalizeHexColor('#000'), '#000000');
  for (const value of ['', 'abc', '#12', '#1234', '#12345678', '#ggg', 'red', 'var(--secret)', 'url(https://example.invalid)', '#fff; background: red', null, 1, {}, ['#fff']]) {
    assert.equal(normalizeHexColor(value), null);
  }
});

test('light and dark choices normalize independently and preserve legitimate custom values', () => {
  const defaults = defaultColorPreferences();
  for (const value of [null, [], true, 'dark', { theme: 'dark', accent: '#abc' }]) assert.deepEqual(normalizeColorPreferences(value), defaults);
  const normalized = normalizeColorPreferences({
    light: { preset: 'ocean', accent: '#AbC', surface: 'url(secret)', ink: '#12345678', contrast: 200 },
    dark: { preset: 'forest', contrast: -40 },
  });
  assert.deepEqual(normalized.light, { ...getPresetColors('ocean', 'light'), preset: 'custom', accent: '#aabbcc', contrast: 100 });
  assert.deepEqual(normalized.dark, { ...getPresetColors('forest', 'dark'), preset: 'custom', contrast: 0 });
  assert.equal(normalizeColorPreferences({ light: { preset: 'sand', contrast: 25.7 } }).light.contrast, 26);
  for (const contrast of [NaN, Infinity, -Infinity, '50', null]) {
    assert.equal(normalizeColorPreferences({ light: { contrast } }).light.contrast, 50);
  }
  assert.deepEqual(normalizeColorPreferences({ light: { preset: 'codex' } }).light, getPresetColors('codex', 'light'));
  assert.deepEqual(normalizeColorPreferences({ dark: [] }).dark, defaults.dark);
  const edited = defaultColorPreferences();
  edited.light.accent = '#aabbcc';
  assert.equal(normalizeColorPreferences(edited).light.preset, 'custom', 'edited default values cannot be silently cleared as an untouched preset');
  assert.deepEqual(defaultColorPreferences(), defaults, 'callers never mutate shared preset defaults');
  const preset = getPresetColors('forest', 'dark');
  preset.surface = '#ffffff';
  assert.notEqual(getPresetColors('forest', 'dark').surface, '#ffffff');
  assert.equal(COLOR_PRESET_IDS.includes('custom'), false);
});

test('storage is versioned and survives invalid JSON, older data, missing storage and blocked access', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const defaults = defaultColorPreferences();
  assert.deepEqual(readColorPreferences(storage), defaults);
  const prefs = { light: getPresetColors('sand', 'light'), dark: { ...getPresetColors('ocean', 'dark'), preset: 'custom', accent: '#fa0', contrast: 72 } };
  assert.equal(writeColorPreferences(prefs, storage), true);
  assert.deepEqual([...values.keys()], ['pi-desktop.colors.v1']);
  assert.deepEqual(readColorPreferences(storage), normalizeColorPreferences(prefs));
  for (const malformed of ['{broken', 'null', '42', '"dark"', '{"accent":"#fff"}', '{"light":[]}']) {
    values.set('pi-desktop.colors.v1', malformed);
    assert.deepEqual(readColorPreferences(storage), defaults);
  }
  assert.deepEqual(readColorPreferences({ getItem() { throw new Error('SecurityError'); } }), defaults);
  assert.equal(writeColorPreferences(prefs, { setItem() { throw new Error('QuotaExceededError'); } }), false);
  assert.deepEqual(readColorPreferences(), defaults);
  assert.equal(writeColorPreferences(prefs), false);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { get localStorage() { throw new Error('Storage disabled'); } } });
    assert.deepEqual(readColorPreferences(), defaults);
    assert.equal(writeColorPreferences(prefs), false);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else delete globalThis.window;
  }
});

test('default previews match the existing CSS theme in both modes', async () => {
  const css = await readFile(new URL('../packages/ui/src/styles.css', import.meta.url), 'utf8');
  const parse = block => Object.fromEntries([...block.matchAll(/(--pd-[\w-]+):\s*([^;]+);/g)].map(([, key, value]) => [key, normalizeHexColor(value.trim()) ?? value.trim()]));
  const dark = parse(css.match(/:root\s*\{([\s\S]*?)\}/)[1]);
  const light = { ...dark, ...parse(css.match(/:root\[data-theme='light'\]\s*\{([\s\S]*?)\}/)[1]) };
  for (const [mode, expected] of [['light', light], ['dark', dark]]) {
    const preview = buildThemeTokens(getPresetColors('default', mode), mode);
    for (const [key, value] of Object.entries(preview)) assert.equal(value, expected[key], `${mode} ${key} must match the unchanged default theme`);
    assert.ok(Object.keys(preview).length >= 25);
    assert.equal(Object.hasOwn(preview, '--pd-radius-md'), false);
  }
});

test('generated palettes keep text and brand buttons readable across presets and difficult custom backgrounds', () => {
  const tokenNames = Object.keys(buildThemeTokens(getPresetColors('default', 'light'), 'light')).sort();
  for (const mode of ['light', 'dark']) {
    const choices = COLOR_PRESET_IDS.filter(id => id !== 'default').map(id => getPresetColors(id, mode));
    for (const surface of ['#000000', '#ffffff', '#555555', '#656565', '#777777', '#888888', '#00ff00', '#ff0000', '#ffff00', '#0000ff']) {
      choices.push({ preset: 'custom', accent: surface, surface, ink: surface, contrast: 100 });
    }
    for (const choice of choices) {
      const tokens = buildThemeTokens(choice, mode);
      assert.deepEqual(Object.keys(tokens).sort(), tokenNames, 'every custom palette owns the same token set');
      for (const value of Object.values(tokens)) assert.match(value, /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/, 'custom output cannot inject arbitrary CSS');
      assert.ok(['#000000', '#ffffff'].includes(tokens['--pd-brand-ink']));
      for (const background of ['--pd-brand', '--pd-brand-hover']) assert.ok(ratio(tokens['--pd-brand-ink'], tokens[background]) >= 4.5, `${mode}/${choice.surface} brand label contrast`);
      assert.ok(ratio(tokens['--pd-selection-ink'], tokens['--pd-selection-bg']) >= 4.5, `${mode}/${choice.surface} text selection contrast`);
      for (const token of ['--pd-mark-border', '--pd-assistant-mark-bg', '--pd-brand-mark-bg']) assert.equal(tokens[token].slice(0, 7), choice.accent);
      for (const name of backgrounds) {
        const background = tokens[`--pd-${name}`];
        assert.ok(ratio(tokens['--pd-text'], background) >= 4.5, `${mode}/${choice.surface} primary text on ${name}`);
        assert.ok(ratio(tokens['--pd-text-subtle'], background) >= 4.5, `${mode}/${choice.surface} secondary text on ${name}`);
        assert.ok(ratio(tokens['--pd-text-weak'], background) >= 3, `${mode}/${choice.surface} weak text on ${name}`);
      }
      assert.ok(ratio(tokens['--pd-code-text'], tokens['--pd-code-surface']) >= 4.5);
    }
  }
});

test('contrast strengthens surface boundaries without changing chosen background or accent', () => {
  for (const mode of ['light', 'dark']) {
    const base = getPresetColors('ocean', mode);
    const low = buildThemeTokens({ ...base, contrast: 0 }, mode);
    const high = buildThemeTokens({ ...base, contrast: 100 }, mode);
    for (const tokens of [low, high]) {
      assert.equal(tokens['--pd-bg'], base.surface);
      assert.equal(tokens['--pd-brand'], base.accent);
    }
    assert.ok(ratio(high['--pd-bg'], high['--pd-border']) > ratio(low['--pd-bg'], low['--pd-border']));
    assert.ok(ratio(high['--pd-bg'], high['--pd-surface-hover']) > ratio(low['--pd-bg'], low['--pd-surface-hover']));
    assert.deepEqual(buildThemeTokens({ ...base, contrast: -100 }, mode), low);
    assert.deepEqual(buildThemeTokens({ ...base, contrast: 900 }, mode), high);
  }
});

test('switching palettes and resetting remove old overrides without changing theme mode or unrelated styles', () => {
  const styles = new Map([['--pd-radius-md', '17px'], ['--unrelated', 'preserved']]);
  const root = { dataset: { theme: 'dark' }, style: { setProperty: (key, value) => styles.set(key, value), removeProperty: key => styles.delete(key) } };
  applyThemeColors(root, getPresetColors('forest', 'dark'), 'dark');
  const dark = buildThemeTokens(getPresetColors('forest', 'dark'), 'dark');
  assert.equal(styles.get('--pd-bg'), dark['--pd-bg']);
  root.dataset.theme = 'light';
  applyThemeColors(root, getPresetColors('sand', 'light'), 'light');
  for (const [key, value] of Object.entries(buildThemeTokens(getPresetColors('sand', 'light'), 'light'))) assert.equal(styles.get(key), value);
  applyThemeColors(root, getPresetColors('default', 'light'), 'light');
  assert.deepEqual([...styles], [['--pd-radius-md', '17px'], ['--unrelated', 'preserved']]);
  assert.equal(root.dataset.theme, 'light');
  applyThemeColors(root, getPresetColors('default', 'dark'), 'dark');
  assert.equal(root.dataset.theme, 'light', 'data-theme remains owned by the app shell');
});
