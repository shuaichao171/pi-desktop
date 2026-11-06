import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { registerHooks } from 'node:module';

// TypeScript sources import siblings without extensions; resolve them for node.
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('./') && context.parentURL?.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
  return nextResolve(specifier, context);
} });

const { appearanceStatePath, isValidAppearanceState, readAppearanceState, readAppearanceStateAsync, watchAppearanceState, writeAppearanceState, writeAppearanceStateAsync } =
  await import('../packages/desktop/src/main/appearance.ts');

const colors = {
  light: { preset: 'ocean', accent: '#126cbb', surface: '#f4f9ff', ink: '#1e3047', contrast: 50 },
  dark: { preset: 'ocean', accent: '#7abcf8', surface: '#111923', ink: '#e3eef8', contrast: 50 },
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('shared appearance state reads, writes, validates and survives corruption', async () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'pi-desktop-appearance-'));
  try {
    const path = appearanceStatePath(root);
    assert.equal(path, join(root, 'appearance.json'));
    assert.equal(readAppearanceState(path), null, 'a missing file means nothing shared yet');

    const state = { theme: 'dark', colors };
    assert.equal(isValidAppearanceState(state), true);
    writeAppearanceState(path, state);
    assert.deepEqual(readAppearanceState(path), state, 'the saved state round-trips');

    await writeAppearanceStateAsync(path, { theme: 'light', colors });
    assert.deepEqual(readAppearanceState(path), { theme: 'light', colors }, 'the async writer round-trips too');
    assert.equal(readFileSync(path, 'utf8'), JSON.stringify({ theme: 'light', colors }), '原子替换写入完整 JSON');

    assert.equal(isValidAppearanceState(null), false);
    assert.equal(isValidAppearanceState({ theme: 'solarized' }), false);
    assert.equal(isValidAppearanceState({ theme: 'light' }), false, 'colors are required');
    assert.equal(isValidAppearanceState({ theme: 'light', colors: { light: 'not-an-object', dark: colors.dark } }), false, 'both color schemes must be objects');
    writeFileSync(path, '{ not json', 'utf8');
    assert.equal(readAppearanceState(path), null, 'a corrupt file falls back to local defaults without throwing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('watching the shared file reports only real external changes', async () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'pi-desktop-appearance-watch-'));
  try {
    const path = appearanceStatePath(root);
    writeAppearanceState(path, { theme: 'system', colors });
    const seen = [];
    const stop = watchAppearanceState(path, (state) => seen.push(state));
    try {
      // Same content must not retrigger; a new value from another process must.
      writeAppearanceState(path, { theme: 'system', colors });
      await delay(400);
      assert.deepEqual(seen, [], 'echoes of unchanged content are ignored');
      writeAppearanceState(path, { theme: 'dark', colors });
      await delay(400);
      assert.deepEqual(seen.map((state) => state?.theme), ['dark'], 'external saves reach the follower');
    } finally {
      stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 4 });
  }
});

test('the cold-start prefetch reads appearance async with the sync reader fallbacks', async () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'pi-desktop-appearance-prefetch-'));
  try {
    const path = appearanceStatePath(root);
    assert.equal(await readAppearanceStateAsync(path), null, 'missing file');
    const state = { theme: 'dark', colors };
    writeAppearanceState(path, state);
    assert.deepEqual(await readAppearanceStateAsync(path), state);
    writeFileSync(path, JSON.stringify({ theme: 'neon', colors }), 'utf8');
    assert.equal(await readAppearanceStateAsync(path), null, 'an invalid state falls back like the sync reader');
    writeFileSync(path, '{', 'utf8');
    assert.equal(await readAppearanceStateAsync(path), null, 'corrupt file falls back');
    assert.equal(readFileSync(path, 'utf8'), '{', 'unreadable bytes are left untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
