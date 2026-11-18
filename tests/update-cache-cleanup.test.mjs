import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  compareVersions,
  removeInstalledPendingUpdate,
  versionFromInstallerName,
  windowsUpdaterCacheDir,
} from '../packages/desktop/src/main/updateCacheCleanup.ts';

function cacheWithPending(fileName) {
  const cacheDir = mkdtempSync(join(tmpdir(), 'pi-updater-cache-'));
  const pending = join(cacheDir, 'pending');
  mkdirSync(pending);
  writeFileSync(join(cacheDir, 'installer.exe'), 'base');
  writeFileSync(join(cacheDir, 'current.blockmap'), 'map');
  if (fileName !== undefined) {
    writeFileSync(join(pending, fileName), 'installer');
    writeFileSync(join(pending, 'update-info.json'), JSON.stringify({ fileName, sha512: 'x', isAdminRightsRequired: false }));
  }
  return { cacheDir, pending };
}

test('installer names yield their version', () => {
  assert.equal(versionFromInstallerName('Pi-Desktop-Setup-0.5.6-x64.exe'), '0.5.6');
  assert.equal(versionFromInstallerName('Pi-Desktop-Setup-1.2.0-rc.3-x64.exe'), '1.2.0-rc.3');
  assert.equal(versionFromInstallerName('Pi-Desktop-0.5.6-arm64.zip'), '0.5.6');
  assert.equal(versionFromInstallerName('setup.exe'), null);
});

test('versions compare numerically with prereleases before releases', () => {
  assert.ok(compareVersions('0.5.10', '0.5.9') > 0);
  assert.equal(compareVersions('0.5.6', '0.5.6'), 0);
  assert.ok(compareVersions('0.6.0-rc.1', '0.6.0') < 0);
  assert.ok(compareVersions('0.6.0-rc.10', '0.6.0-rc.2') > 0);
  assert.equal(compareVersions('latest', '0.5.6'), null);
});

test('the installed version and older pending installers are removed', async () => {
  for (const name of ['Pi-Desktop-Setup-0.5.6-x64.exe', 'Pi-Desktop-Setup-0.5.5-x64.exe']) {
    const { cacheDir, pending } = cacheWithPending(name);
    assert.equal(await removeInstalledPendingUpdate(cacheDir, '0.5.6'), true);
    assert.equal(existsSync(pending), false);
    // The differential-download base written by the NSIS installer stays.
    assert.equal(existsSync(join(cacheDir, 'installer.exe')), true);
    assert.equal(existsSync(join(cacheDir, 'current.blockmap')), true);
  }
});

test('a newer downloaded-but-not-installed update is kept', async () => {
  const { cacheDir, pending } = cacheWithPending('Pi-Desktop-Setup-0.5.7-x64.exe');
  assert.equal(await removeInstalledPendingUpdate(cacheDir, '0.5.6'), false);
  assert.equal(existsSync(join(pending, 'Pi-Desktop-Setup-0.5.7-x64.exe')), true);
});

test('unknown or missing pending metadata leaves the cache alone', async () => {
  const empty = cacheWithPending();
  assert.equal(await removeInstalledPendingUpdate(empty.cacheDir, '0.5.6'), false);
  assert.equal(existsSync(empty.pending), true);

  const odd = cacheWithPending('setup.exe');
  assert.equal(await removeInstalledPendingUpdate(odd.cacheDir, '0.5.6'), false);
  assert.equal(existsSync(join(odd.pending, 'setup.exe')), true);

  const none = mkdtempSync(join(tmpdir(), 'pi-updater-cache-'));
  assert.equal(await removeInstalledPendingUpdate(none, '0.5.6'), false);
});

test('the cache dir comes from app-update.yml and stays one segment under LOCALAPPDATA', async () => {
  const resources = mkdtempSync(join(tmpdir(), 'pi-resources-'));
  const saved = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = join(tmpdir(), 'fake-local');
  try {
    writeFileSync(join(resources, 'app-update.yml'), "provider: generic\nurl: https://example.com/\nupdaterCacheDirName: '@pidesktopdesktop-updater'\n");
    assert.equal(await windowsUpdaterCacheDir(resources), join(tmpdir(), 'fake-local', '@pidesktopdesktop-updater'));
    writeFileSync(join(resources, 'app-update.yml'), 'updaterCacheDirName: ../escape\n');
    assert.equal(await windowsUpdaterCacheDir(resources), null);
    assert.equal(await windowsUpdaterCacheDir(join(resources, 'missing')), null);
  } finally {
    if (saved === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = saved;
  }
});
