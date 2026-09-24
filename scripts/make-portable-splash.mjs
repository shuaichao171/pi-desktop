/** Render the same SVG used by Electron straight to the native splash bitmap. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSplashHtml } from '../packages/desktop/src/main/splash.ts';

const SIZE = 224;
const require = createRequire(new URL('../packages/desktop/package.json', import.meta.url));

if (!process.versions.electron) {
  const temporaryRoot = await realpath(tmpdir());
  const profile = await mkdtemp(join(temporaryRoot, 'pi-desktop-splash-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [fileURLToPath(import.meta.url), profile], {
    env, windowsHide: true, stdio: 'inherit',
  });
  const timeout = setTimeout(() => { child.kill(); process.exitCode = 1; }, 30_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    process.exitCode = process.exitCode || code || 0;
    if (code === null) process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    // The child has exited, so no Chromium handles still own its profile.
    assert.equal(dirname(profile), temporaryRoot);
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
} else {
  const { app, BrowserWindow } = require('electron');
  const profile = process.argv[2];
  if (!profile) throw new Error('Run this generator with Node.js.');
  app.setPath('userData', profile);
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.commandLine.appendSwitch('disable-gpu');
  let window;
  // Electron waits for its ESM entry point to finish loading before ready.
  // Await readiness inside a task, not at the module's top level.
  void (async () => {
    try {
      await app.whenReady();
      window = new BrowserWindow({
        width: SIZE, height: SIZE, show: false, frame: false, backgroundColor: '#111216',
        webPreferences: { sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false },
      });
      await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(createSplashHtml())}`);
      // Hidden offscreen windows do not reliably schedule requestAnimationFrame.
      // capturePage obtains the rendered SVG without opening a visible window.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const screenshot = await window.webContents.capturePage();
      assert.deepEqual(screenshot.getSize(), { width: SIZE, height: SIZE });
      const bgra = screenshot.toBitmap();
      const stride = Math.ceil(SIZE * 3 / 4) * 4;
      const pixels = stride * SIZE;
      const bmp = Buffer.alloc(54 + pixels);
      bmp.write('BM');
      bmp.writeUInt32LE(bmp.length, 2);
      bmp.writeUInt32LE(54, 10);
      bmp.writeUInt32LE(40, 14);
      bmp.writeInt32LE(SIZE, 18);
      bmp.writeInt32LE(SIZE, 22);
      bmp.writeUInt16LE(1, 26);
      bmp.writeUInt16LE(24, 28);
      bmp.writeUInt32LE(pixels, 34);
      for (let y = 0; y < SIZE; y += 1) {
        for (let x = 0; x < SIZE; x += 1) {
          const source = (y * SIZE + x) * 4;
          const target = 54 + (SIZE - 1 - y) * stride + x * 3;
          bgra.copy(bmp, target, source, source + 3);
        }
      }
      await writeFile(new URL('../packages/desktop/build/portable-splash.bmp', import.meta.url), bmp);
      console.log(`Generated ${SIZE}×${SIZE} portable splash directly from the startup SVG.`);
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      window?.destroy();
      app.exit(process.exitCode || 0);
    }
  })();
}
