import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBootErrorHtml, createBootHtml } from '../packages/desktop/src/main/splash.ts';
import { WINDOW_BACKGROUND_DEFAULTS, resolveWindowTheme } from '../packages/desktop/src/main/windowTheme.ts';

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
