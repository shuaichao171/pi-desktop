import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('./') && context.parentURL && new URL(context.parentURL).pathname.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

test('desktop settings default, persist and survive corruption (4.1/4.2)', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'pi-desktop-settings-'));
  t.after(async () => { rmSync(temp, { recursive: true, force: true }); });
  const { readDesktopSettings, writeDesktopSettings, writeDesktopSettingsAsync, DEFAULT_DESKTOP_SETTINGS } = await import('../packages/desktop/src/main/desktopSettings.ts');
  const path = join(temp, 'desktop-settings.json');

  await t.test('missing files fall back to defaults', () => {
    assert.deepEqual(readDesktopSettings(path), DEFAULT_DESKTOP_SETTINGS);
    assert.equal(DEFAULT_DESKTOP_SETTINGS.notificationsEnabled, true);
    assert.equal(DEFAULT_DESKTOP_SETTINGS.closeBehavior, 'tray');
  });

  await t.test('writes round-trip through reads', async () => {
    writeDesktopSettings(path, { notificationsEnabled: false, closeBehavior: 'quit' });
    assert.deepEqual(readDesktopSettings(path), { notificationsEnabled: false, closeBehavior: 'quit' });
    await writeDesktopSettingsAsync(path, { notificationsEnabled: true, closeBehavior: 'tray' });
    assert.deepEqual(readDesktopSettings(path), { notificationsEnabled: true, closeBehavior: 'tray' });
  });

  await t.test('corrupt or invalid content falls back to defaults', () => {
    writeFileSync(path, '{ not json', 'utf8');
    assert.deepEqual(readDesktopSettings(path), DEFAULT_DESKTOP_SETTINGS);
    writeFileSync(path, JSON.stringify({ notificationsEnabled: 'yes', closeBehavior: 'maybe' }), 'utf8');
    assert.deepEqual(readDesktopSettings(path), DEFAULT_DESKTOP_SETTINGS);
  });
});
