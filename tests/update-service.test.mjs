import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

const updater = new EventEmitter();
const feedConfigurations = [];
updater.setFeedURL = (config) => feedConfigurations.push(config);
globalThis.__testUpdater = updater;
registerHooks({
  resolve(specifier, context, nextResolve) {
    let source;
    if (specifier === 'electron') source = `
      export const app = { isPackaged: true, getVersion: () => '0.1.0' };
      export const BrowserWindow = { getAllWindows: () => [] };
    `;
    if (specifier === 'electron-updater') source = 'export const autoUpdater = globalThis.__testUpdater;';
    if (specifier === './appLocale') source = "export const getAppLocale = () => globalThis.__testUpdateLocale ?? 'en-US';";
    if (source) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    if (specifier.startsWith('./') && context.parentURL?.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});
const { updateService } = await import('../packages/desktop/src/main/updateService.ts');

function createService(feedUrl = 'https://updates.example.com/') {
  updater.removeAllListeners();
  const keys = ['PI_DESKTOP_UPDATE_URL', 'APPIMAGE', 'PORTABLE_EXECUTABLE_FILE'];
  const saved = keys.map((key) => process.env[key]);
  try {
    process.env.PI_DESKTOP_UPDATE_URL = feedUrl;
    process.env.APPIMAGE = process.execPath;
    delete process.env.PORTABLE_EXECUTABLE_FILE;
    return new updateService.constructor();
  } finally {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
  }
}

test('update checks handle the separate automatic download rejection', async () => {
  const service = createService();
  let downloadFailure;
  updater.checkForUpdates = async () => {
    updater.emit('update-available', { version: '0.2.0' });
    // A thenable lets the test verify the rejection handler without creating an unhandled rejection.
    return { downloadPromise: { catch(handler) { downloadFailure = handler; return Promise.resolve(); } } };
  };
  try {
    assert.equal((await service.check()).phase, 'downloading');
    assert.equal(typeof downloadFailure, 'function');
    await downloadFailure(new Error('download disconnected'));
    assert.equal(service.getState().phase, 'error');
    assert.match(service.getState().error, /download disconnected/);
  } finally { service.stop(); }
});

test('installer errors emitted instead of thrown release the install lock and restore checks', async () => {
  for (const asynchronous of [false, true]) {
    const service = createService();
    updater.checkForUpdates = async () => { updater.emit('update-downloaded', { version: '0.2.0' }); return {}; };
    service.setBeforeInstall(async () => {});
    updater.quitAndInstall = () => {
      if (!asynchronous) updater.emit('error', new Error('installer missing'));
    };
    try {
      await service.check();
      if (asynchronous) {
        await service.install();
        updater.emit('error', new Error('installer missing'));
      } else await assert.rejects(service.install(), /installer missing/);
      assert.equal(service.installing, false);
      assert.equal(service.getState().phase, 'error');
      assert.match(service.getState().error, /Restart the app/);
      assert.ok(service.interval, 'automatic checks must resume after a failed install');
    } finally { service.stop(); }
  }
});

test('failed shutdown prevents installation and reports the required restart', async () => {
  const service = createService();
  updater.checkForUpdates = async () => { updater.emit('update-downloaded', { version: '0.2.0' }); return {}; };
  let installs = 0;
  updater.quitAndInstall = () => { installs += 1; };
  service.setBeforeInstall(async () => { throw new Error('Could not save final state'); });
  try {
    await service.check();
    await assert.rejects(service.install(), /Could not save final state/);
    assert.equal(installs, 0);
    assert.equal(service.getState().phase, 'error');
    assert.match(service.getState().error, /Could not save final state.*Restart the app/);
  } finally { service.stop(); }
});

test('GitHub release downloads disable multipart ranges and retain the default signature verifier', async () => {
  const url = 'https://github.com/shuaichao171/pi-desktop/releases/latest/download/';
  const service = createService(url);
  const signatureVerifier = () => { throw new Error('Do not replace the signature verifier'); };
  updater.verifyUpdateCodeSignature = signatureVerifier;
  updater.checkForUpdates = async () => { updater.emit('update-not-available'); return {}; };
  try {
    assert.equal((await service.check()).phase, 'up-to-date');
    assert.deepEqual(feedConfigurations.at(-1), { provider: 'generic', url, useMultipleRangeRequest: false });
    assert.equal(updater.verifyUpdateCodeSignature, signatureVerifier);
    assert.equal(updater.autoDownload, true);
    assert.equal(updater.autoInstallOnAppQuit, false);
    assert.equal(updater.allowDowngrade, false);
  } finally { service.stop(); delete updater.verifyUpdateCodeSignature; }
});

test('an unpublished GitHub release stays retryable and does not incorrectly claim the app is current', async () => {
  for (const locale of ['en-US', 'zh-CN']) {
    globalThis.__testUpdateLocale = locale;
    const service = createService('https://github.com/shuaichao171/pi-desktop/releases/latest/download/');
    const missing = Object.assign(new Error('Cannot find channel latest.yml update info: 404 with raw stack trace'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' });
    updater.checkForUpdates = async () => { updater.emit('error', missing); throw missing; };
    try {
      const result = await service.check();
      assert.equal(result.phase, 'error');
      assert.match(result.error, locale === 'en-US' ? /not published.*try again later/i : /尚未发布.*稍后重试/);
      assert.doesNotMatch(result.error, /raw stack trace/);
      updater.checkForUpdates = async () => { updater.emit('update-not-available'); return {}; };
      assert.equal((await service.check()).phase, 'up-to-date');
      assert.equal(service.getState().error, undefined);
    } finally { service.stop(); delete globalThis.__testUpdateLocale; }
  }
});

test('ordinary feed failures and missing installer downloads retain their actual errors', async () => {
  for (const [feed, error] of [
    ['https://updates.example.com/', Object.assign(new Error('Missing custom channel'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' })],
    ['https://github.com/shuaichao171/pi-desktop/releases/latest/download/', Object.assign(new Error('Installer asset missing: 404'), { statusCode: 404 })],
  ]) {
    const service = createService(feed);
    updater.checkForUpdates = async () => { throw error; };
    try {
      assert.equal((await service.check()).error, error.message);
      if (feed.includes('updates.example.com')) assert.deepEqual(feedConfigurations.at(-1), { provider: 'generic', url: feed });
    } finally { service.stop(); }
  }
});
