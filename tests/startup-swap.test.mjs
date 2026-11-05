import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { swapSplashForMainWindow } from '../packages/desktop/src/main/startupSwap.ts';

function swapWindow({ visible = false, destroyed = false } = {}) {
  const win = new EventEmitter();
  win.destroyed = destroyed;
  win.visible = visible;
  win.closeCount = 0;
  win.isDestroyed = () => win.destroyed;
  win.isVisible = () => win.visible;
  win.close = () => { win.destroyed = true; win.closeCount += 1; win.emit('closed'); };
  return win;
}

test('the boot window closes immediately when the main window is already on screen', () => {
  const main = swapWindow({ visible: true });
  const splash = swapWindow();
  const fallbacks = [];
  swapSplashForMainWindow(main, splash, (close) => fallbacks.push(close));
  assert.equal(splash.closeCount, 1, 'a revealed main window releases the boot window at once');
  assert.equal(fallbacks.length, 1);
  fallbacks[0]();
  assert.equal(splash.closeCount, 1, 'closing is idempotent');
});

test('the boot window waits for the main window show event', () => {
  const main = swapWindow();
  const splash = swapWindow();
  swapSplashForMainWindow(main, splash, () => {});
  assert.equal(splash.closeCount, 0, 'a hidden main window keeps the boot window alive');
  main.visible = true;
  main.emit('show');
  assert.equal(splash.closeCount, 1);
});

test('the fallback timer closes the boot window when no show event arrives', () => {
  const main = swapWindow();
  const splash = swapWindow();
  let fallback;
  swapSplashForMainWindow(main, splash, (close) => { fallback = close; });
  assert.equal(splash.closeCount, 0);
  fallback();
  assert.equal(splash.closeCount, 1, 'platforms without a show event still swap');
});

test('an already-closed boot window is left alone', () => {
  const main = swapWindow({ visible: true });
  const splash = swapWindow({ destroyed: true });
  swapSplashForMainWindow(main, splash, () => {});
  assert.equal(splash.closeCount, 0);
});

test('a destroyed boot window during the fallback does not throw', () => {
  const main = swapWindow();
  const splash = swapWindow();
  let fallback;
  swapSplashForMainWindow(main, splash, (close) => { fallback = close; });
  splash.destroyed = true;
  fallback();
  assert.equal(splash.closeCount, 0);
});
