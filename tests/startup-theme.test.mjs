import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PORTABLE_SPLASH_SIZE, createBootErrorHtml, createBootHtml, createPortableSplashHtml, portableSplashCrop } from '../packages/desktop/src/main/splash.ts';
import { WINDOW_BACKGROUND_DEFAULTS, resolveWindowTheme, syncWindowBackgrounds } from '../packages/desktop/src/main/windowTheme.ts';

const colors = (darkSurface, lightSurface) => ({
  light: { preset: 'default', accent: '#4a5fc1', surface: lightSurface, ink: '#262626', contrast: 50 },
  dark: { preset: 'default', accent: '#8aa4f8', surface: darkSurface, ink: '#e5e5e5', contrast: 50 },
});

test('resolveWindowTheme follows the OS preference when nothing is saved', () => {
  assert.deepEqual(resolveWindowTheme(null, true), { mode: 'dark', background: '#161616' });
  assert.deepEqual(resolveWindowTheme(null, false), { mode: 'light', background: '#f8f8f8' });
  assert.deepEqual(resolveWindowTheme(undefined, false), { mode: 'light', background: WINDOW_BACKGROUND_DEFAULTS.light });
});

test('resolveWindowTheme prefers an explicit theme over the OS preference', () => {
  const appearance = { theme: 'light', colors: colors('#101c26', '#fbf6ec') };
  assert.deepEqual(resolveWindowTheme(appearance, true), { mode: 'light', background: '#fbf6ec' });
  assert.deepEqual(resolveWindowTheme({ ...appearance, theme: 'dark' }, false), { mode: 'dark', background: '#101c26' });
});

test('resolveWindowTheme resolves a saved system preference against the OS', () => {
  const appearance = { theme: 'system', colors: colors('#101c26', '#fbf6ec') };
  assert.deepEqual(resolveWindowTheme(appearance, true), { mode: 'dark', background: '#101c26' });
  assert.deepEqual(resolveWindowTheme(appearance, false), { mode: 'light', background: '#fbf6ec' });
});

test('resolveWindowTheme falls back to the built-in surfaces for invalid colors', () => {
  const appearance = { theme: 'dark', colors: colors('not-a-color', '#f8f8f8') };
  assert.deepEqual(resolveWindowTheme(appearance, true), { mode: 'dark', background: '#161616' });
  const shorthand = { theme: 'dark', colors: colors('#abc', '#f8f8f8') };
  assert.equal(resolveWindowTheme(shorthand, true).background, '#abc', 'three-digit hex surfaces stay valid');
});

test('the boot page paints with the resolved theme in both color modes', () => {
  const dark = createBootHtml('zh-CN', resolveWindowTheme(null, true));
  assert.match(dark, /background: #161616/);
  assert.match(dark, /color-scheme: dark/);
  assert.match(dark, /正在启动 Pi Desktop…/);
  assert.ok(dark.includes('splash-logo'), 'the boot page keeps the logo');
  const light = createBootHtml('en-US', resolveWindowTheme(null, false));
  assert.match(light, /background: #f8f8f8/);
  assert.match(light, /color-scheme: light/);
  assert.match(light, /Starting Pi Desktop…/);
  assert.notEqual(dark, light, 'the two modes render visibly different pages');
});

test('the default boot page stays dark for callers without a theme', () => {
  assert.match(createBootHtml('zh-CN'), /background: #161616/);
});

test('the boot error page keeps its message and shares the boot page background', () => {
  const theme = resolveWindowTheme(null, false);
  const error = createBootErrorHtml('Disk is full', 'en-US', theme);
  assert.match(error, /background: #f8f8f8/);
  assert.match(error, /Disk is full/);
  assert.match(error, /Startup failed/);
  assert.ok(error.includes('splash-logo'), 'the logo stays on screen across the swap');
  assert.match(createBootErrorHtml('磁盘已满', 'zh-CN', resolveWindowTheme(null, true)), /background: #161616/);
});

test('syncWindowBackgrounds re-applies the resolved surface to live windows only', () => {
  const fake = (destroyed = false) => ({ destroyed, applied: [], isDestroyed() { return this.destroyed; }, setBackgroundColor(color) { this.applied.push(color); } });
  const live = fake();
  const gone = fake(true);
  const throwing = { isDestroyed: () => false, setBackgroundColor: () => { throw new Error('torn down'); } };
  const after = fake();
  const appearance = { theme: 'system', colors: colors('#101c26', '#fbf6ec') };
  assert.equal(syncWindowBackgrounds([live, gone, throwing, after], appearance, true), '#101c26');
  assert.deepEqual(live.applied, ['#101c26']);
  assert.deepEqual(gone.applied, [], 'destroyed windows are skipped');
  assert.deepEqual(after.applied, ['#101c26'], 'a throwing window does not stop the rest');
  syncWindowBackgrounds([live], appearance, false);
  assert.deepEqual(live.applied, ['#101c26', '#fbf6ec'], 'an OS flip under system follows the new mode');
  syncWindowBackgrounds([live], null, true);
  assert.equal(live.applied.at(-1), WINDOW_BACKGROUND_DEFAULTS.dark);
});

test('the portable splash is a still frame of the default boot page', () => {
  const still = createPortableSplashHtml();
  const boot = createBootHtml('zh-CN', resolveWindowTheme(null, true));
  assert.match(still, new RegExp(`background: ${WINDOW_BACKGROUND_DEFAULTS.dark}`), 'same surface as a first-run dark boot window');
  assert.match(still, /\.splash-logo \{ display: block; flex: none; width: 96px; height: 96px; \}/, 'logo at the boot page size');
  assert.match(still, /\.bar \{ animation: none; transform: translateX\(-110%\); \}/, 'bar rests at the first keyframe');
  assert.match(still, /\.label \{ visibility: hidden; \}/, 'locale-dependent label keeps its slot but is not drawn');
  assert.doesNotMatch(boot, /animation: none/, 'the live boot page still animates');
  assert.equal(still.replace(/\n    \/\* Still frame[\s\S]*?visibility: hidden; \}/, ''), boot, 'only the still-frame overrides differ');
});

test('portableSplashCrop keeps the centered bitmap square', () => {
  assert.deepEqual(portableSplashCrop(640, 480), { x: 208, y: 128, width: PORTABLE_SPLASH_SIZE, height: PORTABLE_SPLASH_SIZE });
  assert.deepEqual(portableSplashCrop(224, 224), { x: 0, y: 0, width: 224, height: 224 });
  assert.throws(() => portableSplashCrop(200, 480));
});
