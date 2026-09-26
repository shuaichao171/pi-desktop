import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const recoveries = [];
globalThis.__desktopSettingsRecoveries = recoveries;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: `data:text/javascript,${encodeURIComponent('export const dialog = { showErrorBox: (...args) => globalThis.__desktopSettingsRecoveries.push(args) };')}`, shortCircuit: true };
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

  await t.test('corrupt or invalid content is preserved before falling back to defaults', () => {
    writeFileSync(path, '{ not json', 'utf8');
    assert.deepEqual(readDesktopSettings(path), DEFAULT_DESKTOP_SETTINGS);
    const backup = readdirSync(temp).find((name) => name.endsWith('.bak'));
    assert.ok(backup);
    assert.equal(readFileSync(join(temp, backup), 'utf8'), '{ not json');
    assert.ok(recoveries[0][1].includes(backup));
    writeDesktopSettings(path, { notificationsEnabled: false, closeBehavior: 'quit' });
    assert.equal(readFileSync(join(temp, backup), 'utf8'), '{ not json');
    writeFileSync(path, JSON.stringify({ notificationsEnabled: 'yes', closeBehavior: 'maybe' }), 'utf8');
    assert.deepEqual(readDesktopSettings(path), DEFAULT_DESKTOP_SETTINGS);
    assert.equal(readdirSync(temp).filter((name) => name.endsWith('.bak')).length, 2);
    assert.equal(recoveries.length, 2);
  });

  await t.test('filesystem errors are not silently treated as default settings', () => {
    const directory = join(temp, 'settings-directory');
    mkdirSync(directory);
    assert.throws(() => readDesktopSettings(directory));
  });
});
