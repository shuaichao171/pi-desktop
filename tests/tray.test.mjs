import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

class TestTray extends EventEmitter {
  destroyed = false;
  menus = [];
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
  setToolTip(value) { this.tooltip = value; }
  popUpContextMenu(menu) { this.menus.push(menu); }
}
globalThis.__testTray = TestTray;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const sources = {
      electron: `export const app = { isPackaged: false };
        export const Menu = { buildFromTemplate: (template) => template };
        export const nativeImage = { createFromPath: () => ({ isEmpty: () => false }) };
        export const Tray = globalThis.__testTray;`,
      './appLocale': "export const getAppLocale = () => 'en-US';",
    };
    if (sources[specifier]) return { url: `data:text/javascript,${encodeURIComponent(sources[specifier])}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { createAppTray, destroyAppTray, invalidateAppTrayData } = await import('../packages/desktop/src/main/tray.ts');
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('tray refreshes on invalidated menu opens or a five-minute fallback, with no background popups', { skip: process.platform !== 'win32' }, async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000 });
  t.after(() => { destroyAppTray(); t.mock.timers.reset(); });
  let reads = 0;
  const tray = createAppTray({ showMainWindow() {}, quitApp() {},
    getRecentSessions: async () => { reads += 1; return [{ path: 'session', title: `Task ${reads}` }]; } });
  await settle();
  assert.equal(reads, 1);
  assert.equal(tray.menus.length, 0);
  t.mock.timers.tick(20_000);
  await settle();
  assert.equal(reads, 1);
  tray.emit('right-click');
  await settle();
  assert.equal(reads, 1, 'a fresh menu reuses the cache');
  assert.equal(tray.menus.length, 1);
  invalidateAppTrayData();
  assert.equal(reads, 1, 'events invalidate without parsing sessions');
  tray.emit('right-click');
  await settle();
  assert.equal(reads, 2);
  assert.ok(tray.menus[1].some((item) => item.label === 'Task 1'), 'the cached menu opens without waiting for the host');
  tray.emit('right-click');
  assert.ok(tray.menus[2].some((item) => item.label === 'Task 2'));
  t.mock.timers.tick(5 * 60_000);
  await settle();
  assert.equal(reads, 3);
  assert.equal(tray.menus.length, 3, 'refresh timers must never open menus');
  destroyAppTray();
  t.mock.timers.tick(5 * 60_000);
  await settle();
  assert.equal(reads, 3);
});

test('a tray refresh completing after destruction cannot open a menu or replace new tray data', { skip: process.platform !== 'win32' }, async (t) => {
  t.after(destroyAppTray);
  let resolveSessions;
  const pending = new Promise((resolve) => { resolveSessions = resolve; });
  const old = createAppTray({ showMainWindow() {}, quitApp() {}, getRecentSessions: () => pending });
  old.emit('right-click');
  assert.equal(old.menus.length, 1, 'an unresponsive agent cannot prevent access to Show/Quit');
  destroyAppTray();
  const current = createAppTray({ showMainWindow() {}, quitApp() {}, getRecentSessions: async () => [{ path: 'new', title: 'New session' }] });
  await settle();
  resolveSessions([{ path: 'old', title: 'Old session' }]);
  await settle();
  assert.equal(old.menus.length, 1, 'a completed refresh cannot open a delayed popup');
  current.emit('right-click');
  await settle();
  assert.ok(current.menus[0].some((item) => item.label === 'New session'));
  assert.ok(!current.menus[0].some((item) => item.label === 'Old session'));
});
