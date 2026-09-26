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
      export const net = { fetch: async () => ({ ok: false }) };
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

const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('downloads start only after the user clicks and install once ready', async () => {
  const service = createService();
  let shutdowns = 0;
  let installs = 0;
  service.setBeforeInstall(async () => { shutdowns += 1; });
  updater.quitAndInstall = () => { installs += 1; };
  updater.checkForUpdates = async () => { updater.emit('update-available', { version: '0.2.0' }); return {}; };
  updater.downloadUpdate = async () => {};
  try {
    await service.check();
    assert.equal(service.getState().phase, 'available', 'updates are found without downloading');
    assert.equal(!!service.getState().installRequested, false);
    await service.install();
    assert.equal(service.getState().phase, 'downloading');
    assert.equal(service.getState().installRequested, true);
    updater.emit('download-progress', { percent: 50 });
    assert.equal(service.getState().progressPercent, 50);
    updater.emit('update-downloaded', { version: '0.2.0' });
    await flush();
    assert.equal(service.getState().phase, 'installing', 'the consented click installs as soon as the download lands');
    assert.equal(service.getState().progressPercent, 100);
    assert.equal(shutdowns, 1);
    assert.equal(installs, 1);
    await service.install();
    assert.equal(service.getState().phase, 'installing');
    assert.equal(shutdowns, 1);
    assert.equal(installs, 1, 'duplicate clicks must not install twice');
  } finally { service.stop(); }
});

test('clicking during download installs once and ignores duplicate clicks and stale progress', async () => {
  const service = createService();
  const shutdown = deferred();
  let shutdowns = 0;
  let installs = 0;
  service.setBeforeInstall(() => { shutdowns += 1; return shutdown.promise; });
  updater.quitAndInstall = () => { installs += 1; };
  updater.checkForUpdates = async () => { updater.emit('update-available', { version: '0.2.0' }); return {}; };
  updater.downloadUpdate = async () => {};
  try {
    await service.check();
    await Promise.all([service.install(), service.install()]);
    assert.equal(service.getState().installRequested, true);
    assert.equal(service.getState().phase, 'downloading');
    assert.equal(shutdowns, 0);
    updater.emit('update-downloaded', { version: '0.2.0' });
    await flush();
    assert.equal(service.getState().phase, 'installing');
    assert.equal(shutdowns, 1);
    assert.equal(installs, 0);
    updater.emit('download-progress', { percent: 1 });
    updater.emit('checking-for-update');
    updater.emit('update-not-available');
    updater.emit('update-available', { version: '0.2.0' });
    updater.emit('update-downloaded', { version: '0.2.0' });
    await service.install();
    assert.equal(service.getState().phase, 'installing');
    assert.equal(service.getState().progressPercent, 100);
    shutdown.resolve();
    await flush();
    await service.install();
    assert.equal(installs, 1);
    assert.equal(shutdowns, 1);
  } finally { shutdown.resolve(); service.stop(); }
});

test('download errors cancel the pending installation and require another explicit click', async () => {
  const service = createService();
  let installs = 0;
  let downloadReject;
  service.setBeforeInstall(async () => {});
  updater.quitAndInstall = () => { installs += 1; };
  updater.checkForUpdates = async () => { updater.emit('update-available', { version: '0.2.0' }); return {}; };
  let downloadAttempt = 0;
  updater.downloadUpdate = () => new Promise((done, nope) => { downloadAttempt += 1; if (downloadAttempt === 1) downloadReject = nope; else done(); });
  try {
    await service.check();
    const download = service.install();
    await flush();
    assert.equal(service.getState().phase, 'downloading');
    assert.equal(service.getState().installRequested, true);
    downloadReject(new Error('Connection lost'));
    await download;
    await flush();
    assert.equal(service.getState().phase, 'error');
    assert.equal(service.getState().installRequested, false);
    assert.equal(service.getState().availableVersion, '0.2.0');
    updater.emit('download-progress', { percent: 90 });
    updater.emit('update-downloaded', { version: '0.2.0' });
    await flush();
    assert.equal(service.getState().phase, 'error');
    assert.equal(installs, 0);
    await service.install();
    assert.equal(service.getState().phase, 'downloading');
    assert.equal(service.getState().installRequested, true);
    updater.emit('update-downloaded', { version: '0.2.0' });
    await flush();
    assert.equal(installs, 1);
  } finally { service.stop(); }
});

test('a late downloadUpdate rejection cannot cancel a newer installation retry', async () => {
  const service = createService();
  const firstDownload = deferred();
  let firstInstallation;
  let downloads = 0;
  let shutdowns = 0;
  let installs = 0;
  service.setBeforeInstall(async () => { shutdowns += 1; });
  updater.quitAndInstall = () => { installs += 1; };
  updater.checkForUpdates = async () => { updater.emit('update-available', { version: '0.2.0' }); return {}; };
  updater.downloadUpdate = () => ++downloads === 1 ? firstDownload.promise : Promise.resolve();
  try {
    await service.check(false);
    firstInstallation = service.install();
    await flush();
    updater.emit('error', new Error('First download connection lost'));
    assert.equal(service.getState().phase, 'error');
    assert.equal(service.getState().installRequested, false);

    await service.install();
    assert.equal(downloads, 2);
    assert.equal(service.getState().phase, 'downloading');
    assert.equal(service.getState().installRequested, true);

    firstDownload.reject(new Error('Late rejection from the first download'));
    await firstInstallation;
    assert.equal(service.getState().phase, 'downloading', 'the old promise belongs to the failed attempt');
    assert.equal(service.getState().installRequested, true);
    assert.equal(service.getState().error, undefined);
    updater.emit('download-progress', { percent: 75 });
    assert.equal(service.getState().progressPercent, 75);
    updater.emit('update-downloaded', { version: '0.2.0' });
    await flush();
    assert.equal(service.getState().phase, 'installing');
    assert.equal(shutdowns, 1);
    assert.equal(installs, 1);
  } finally {
    firstDownload.resolve();
    await firstInstallation;
    service.stop();
  }
});

test('retry waits for the failed metadata check and old download rejection cannot cancel it', async () => {
  const service = createService();
  const metadata = deferred();
  let checks = 0;
  let installs = 0;
  let oldDownloadFailure;
  service.setBeforeInstall(async () => {});
  updater.quitAndInstall = () => { installs += 1; };
  updater.checkForUpdates = () => {
    checks += 1;
    updater.emit('update-available', { version: '0.2.0' });
    if (checks === 1) return metadata.promise;
    return Promise.resolve({});
  };
  updater.downloadUpdate = async () => {};
  try {
    const checking = service.check();
    await flush();
    await service.install();
    const failure = new Error('First download failed');
    updater.emit('error', failure);
    const retry = service.install();
    assert.equal(checks, 1);
    assert.equal(service.getState().installRequested, true);
    metadata.resolve({ downloadPromise: { catch(handler) { oldDownloadFailure = handler; handler(failure); return Promise.resolve(); } } });
    await Promise.all([checking, retry]);
    assert.equal(checks, 2);
    assert.equal(service.getState().phase, 'downloading');
    assert.equal(service.getState().installRequested, true);
    oldDownloadFailure(new Error('Late rejection of the first download'));
    assert.equal(service.getState().phase, 'downloading');
    assert.equal(service.getState().installRequested, true);
    updater.emit('update-downloaded', { version: '0.2.0' });
    await flush();
    assert.equal(installs, 1);
  } finally { metadata.resolve({}); service.stop(); }
});

test('clicking during a known-version check requests installation and up-to-date clears it', async () => {
  const service = createService();
  const metadata = deferred();
  let checks = 0;
  let installs = 0;
  service.setBeforeInstall(async () => {});
  updater.quitAndInstall = () => { installs += 1; };
  updater.checkForUpdates = async () => {
    checks += 1;
    if (checks === 1) updater.emit('update-available', { version: '0.2.0' });
    else return metadata.promise;
    return {};
  };
  try {
    await service.check();
    updater.emit('error', new Error('Temporary outage'));
    const checking = service.check();
    await flush();
    assert.equal(service.getState().phase, 'checking');
    await service.install();
    assert.equal(service.getState().installRequested, true);
    updater.emit('update-not-available');
    metadata.resolve({});
    await checking;
    assert.equal(service.getState().phase, 'up-to-date');
    assert.equal(service.getState().installRequested, false);
    assert.equal(service.getState().availableVersion, undefined);
    assert.equal(installs, 0);
  } finally { metadata.resolve({}); service.stop(); }
});

test('an installer error during shutdown prevents a later installer invocation', async () => {
  const service = createService();
  const shutdown = deferred();
  let installs = 0;
  service.setBeforeInstall(() => shutdown.promise);
  updater.quitAndInstall = () => { installs += 1; };
  updater.checkForUpdates = async () => { updater.emit('update-downloaded', { version: '0.2.0' }); return {}; };
  try {
    await service.check();
    const installation = service.install();
    await flush();
    updater.emit('error', new Error('Installer preparation failed'));
    shutdown.resolve();
    await assert.rejects(installation, /Installer preparation failed/);
    assert.equal(installs, 0);
    assert.equal(service.getState().phase, 'error');
    assert.equal(service.getState().installRequested, false);
    assert.match(service.getState().error, /Restart the app/);
  } finally { shutdown.resolve(); service.stop(); }
});

test('automatic checks start after 15 seconds and repeat every four hours', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const service = createService();
  let checks = 0;
  service.check = async () => { checks += 1; return service.getState(); };
  try {
    service.start();
    service.start();
    context.mock.timers.tick(14_999);
    assert.equal(checks, 0);
    context.mock.timers.tick(1);
    assert.equal(checks, 1);
    context.mock.timers.tick(4 * 60 * 60 * 1_000 - 15_001);
    assert.equal(checks, 1);
    context.mock.timers.tick(1);
    assert.equal(checks, 2);
    context.mock.timers.tick(4 * 60 * 60 * 1_000);
    assert.equal(checks, 3);
    service.stop();
    context.mock.timers.tick(4 * 60 * 60 * 1_000);
    assert.equal(checks, 3);
  } finally { service.stop(); context.mock.timers.reset(); }
});

test('update checks handle download-promise rejections without pretending to download', async () => {
  const service = createService();
  let downloadFailure;
  updater.checkForUpdates = async () => {
    updater.emit('update-available', { version: '0.2.0' });
    // A thenable lets the test verify the rejection handler without creating an unhandled rejection.
    return { downloadPromise: { catch(handler) { downloadFailure = handler; return Promise.resolve(); } } };
  };
  try {
    assert.equal((await service.check()).phase, 'available');
    assert.equal(typeof downloadFailure, 'function');
    await downloadFailure(new Error('download disconnected'));
    assert.equal(service.getState().phase, 'error');
    assert.match(service.getState().error, /download disconnected/);
  } finally { service.stop(); }
});

test('installer errors emitted instead of thrown require restart without closing services twice', async () => {
  for (const asynchronous of [false, true]) {
    const service = createService();
    updater.checkForUpdates = async () => { updater.emit('update-downloaded', { version: '0.2.0' }); return {}; };
    let shutdowns = 0;
    service.setBeforeInstall(async () => { shutdowns += 1; });
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
      assert.equal(service.getState().installRequested, false);
      assert.equal(service.interval, null, 'checks must not restart after services were closed');
      await assert.rejects(service.install(), /Restart the app/);
      assert.equal((await service.check()).phase, 'error');
      assert.equal(shutdowns, 1);
    } finally { service.stop(); }
  }
});

test('failed shutdown prevents installation and reports the required restart', async () => {
  const service = createService();
  updater.checkForUpdates = async () => { updater.emit('update-downloaded', { version: '0.2.0' }); return {}; };
  let installs = 0;
  let shutdowns = 0;
  updater.quitAndInstall = () => { installs += 1; };
  service.setBeforeInstall(async () => { shutdowns += 1; throw new Error('Could not save final state'); });
  try {
    await service.check();
    await assert.rejects(service.install(), /Could not save final state/);
    assert.equal(installs, 0);
    assert.equal(service.getState().phase, 'error');
    assert.match(service.getState().error, /Could not save final state.*Restart the app/);
    await assert.rejects(service.install(), /Restart the app/);
    assert.equal(shutdowns, 1);
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
    assert.equal(updater.autoDownload, false, 'updates are never downloaded without user consent');
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
