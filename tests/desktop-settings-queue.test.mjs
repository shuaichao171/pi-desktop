import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// 桌面设置读-改-写串行队列（withDesktopSettings，R1 审查发现 R1#3 的修复）：
// 设置页保存、忙碌关闭选择与 debugApi 配置写入共享一条链，交错时后落盘方
// 不得以前者写入前的旧值为基底回滚对方字段。

const stubs = {
  electron: `
    export const app = { getPath: () => '.', getVersion: () => '0.1.7-test', isPackaged: false };
    export const dialog = { showErrorBox: () => {}, showMessageBox: async () => ({ response: 0 }) };
    export const nativeTheme = { shouldUseDarkColors: false };
    export const BrowserWindow = { getAllWindows: () => [], fromWebContents: () => null };
    export const ipcMain = { handle: () => {} };
  `,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (stubs[specifier]) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
    if (specifier.startsWith('./') && context.parentURL && new URL(context.parentURL).pathname.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

test('withDesktopSettings 串行执行且单个失败不阻断后续', async () => {
  const { withDesktopSettings } = await import('../packages/desktop/src/main/desktopSettings.ts');
  const order = [];
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const a = withDesktopSettings(async () => { order.push('a:start'); await tick(); order.push('a:end'); });
  const b = withDesktopSettings(async () => { order.push('b:start'); throw new Error('boom'); }).catch(() => order.push('b:caught'));
  const c = withDesktopSettings(() => order.push('c:sync'));
  await Promise.all([a, b, c]);
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:caught', 'c:sync']);
});

test('debugApi 配置写入与设置页保存共享串行队列，不互相回滚字段', async (t) => {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, 'pi-settings-queue-'));
  const settingsPath = join(root, 'desktop-settings.json');
  t.after(() => rm(root, { recursive: true, force: true }));

  const handlers = new Map();
  globalThis.__queueHandlers = handlers;
  // debugApiIpc.ts 用显式 .ts 扩展名导入这两个模块——桩键必须带扩展名。
  stubs['./rendererIpc.ts'] = `export const handleRendererInvoke = (channel, handler) => globalThis.__queueHandlers.set(channel, handler);`;
  stubs['./debugServer.ts'] = `export const createDebugServer = async (config) => ({ port: config.port, stop: async () => {} });`;

  const { DEBUG_API_CHANNELS } = await import('../packages/shared/src/index.ts');
  const { readDesktopSettings, withDesktopSettings, writeDesktopSettingsAsync } = await import('../packages/desktop/src/main/desktopSettings.ts');
  const { registerDebugApiIpc } = await import('../packages/desktop/src/main/debugApiIpc.ts');
  registerDebugApiIpc({ settingsPath, cloudSync: () => null, appVersion: () => '0.1.7-test', requireTrustedSender: () => {} });
  const setConfig = handlers.get(DEBUG_API_CHANNELS.setConfig);
  assert.equal(typeof setConfig, 'function', 'setConfig 处理器已注册');

  // 设置页保存（共享队列）持锁期间，debugApi 的读-改-写排队在其后：
  // 未入队修复时它会先读到默认值，落盘时把 closeBehavior 回滚成默认。
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const save = withDesktopSettings(async () => {
    const current = readDesktopSettings(settingsPath);
    await writeDesktopSettingsAsync(settingsPath, { ...current, closeBehavior: 'quit' });
    await gate;
  });
  const debugWrite = setConfig(undefined, { enabled: false, port: 4321, authEnabled: false, token: '' });
  for (let i = 0; i < 100 && !release; i += 1) await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([save, debugWrite]);

  const final = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(final.closeBehavior, 'quit', '设置页保存的字段未被 debugApi 写回滚');
  assert.equal(final.debugApi.port, 4321, 'debugApi 配置已落盘');
  assert.equal(final.debugApi.enabled, false);
});
