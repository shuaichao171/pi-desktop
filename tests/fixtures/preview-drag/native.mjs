// Build the renderer, then run: node tests/fixtures/preview-drag/native.mjs
// Isolated Electron/Win32 hit testing: no real IPC bridge and no visible window.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installModelSettingsFixture } from '../model-settings/fixture.mjs';
import { installPreviewDragFixture } from '../ui-improvements/preview-drag.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const desktopRequire = createRequire(join(root, 'packages/desktop/package.json'));
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(desktopRequire('electron'), [fileURLToPath(import.meta.url)], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  process.exitCode = code ?? 1;
} else {
  void (async () => {
  const { app, BrowserWindow, session } = desktopRequire('electron');
  const directory = mkdtempSync(join(root, '_ai_work/preview-native-'));
  const profile = join(directory, 'profile'); mkdirSync(profile);
  app.setPath('userData', profile); app.disableHardwareAcceleration();
  const timer = setTimeout(() => { console.error('Native hit-test deadline exceeded'); app.exit(1); }, 30000);
  let win;
  try {
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }));
    const preload = join(directory, 'preload.cjs');
    await writeFile(preload, `(${installModelSettingsFixture.toString()})({locale:'zh-CN',theme:'dark'});\n(${installPreviewDragFixture.toString()})('full');`);
    win = new BrowserWindow({ width: 1440, height: 860, show: false, frame: false, webPreferences: { preload, contextIsolation: false, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
    const koffi = desktopRequire('koffi'), user32 = koffi.load('user32.dll');
    koffi.struct('PreviewHitPoint', { x: 'long', y: 'long' });
    const toScreen = user32.func('bool __stdcall ClientToScreen(uintptr_t hwnd, _Inout_ PreviewHitPoint *point)');
    const send = user32.func('intptr_t __stdcall SendMessageW(uintptr_t hwnd, uint32_t msg, uintptr_t wparam, intptr_t lparam)');
    const hwnd = win.getNativeWindowHandle().readBigUInt64LE();
    const evaluate = expression => win.webContents.executeJavaScript(expression, true);
    const delay = ms => new Promise(done => setTimeout(done, ms));
    const wait = async expression => { const end = Date.now() + 8000; while (Date.now() < end) { if (await evaluate(expression)) return; await delay(50); } throw new Error('Condition timed out: ' + expression); };
    const hit = async (selector, fraction = .5) => {
      const p = await evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:(r.left+r.width*${fraction})*devicePixelRatio,y:(r.top+r.height/2)*devicePixelRatio};})()`);
      const point = { x: Math.round(p.x), y: Math.round(p.y) }; assert(toScreen(hwnd, point));
      const packed = BigInt(point.y & 0xffff) << 16n | BigInt(point.x & 0xffff);
      return Number(send(hwnd, 0x84, 0n, packed));
    };
    await win.loadFile(join(root, 'packages/desktop/out/renderer/index.html'));
    await wait('window.__modelReview?.ready && Boolean(document.querySelector(".pd-message-image button"))');
    await delay(250);
    const before = await hit('.pd-top-bar', .5);
    assert.equal(before, 2, 'Normal title-bar hit testing returns HTCAPTION');
    await evaluate('document.querySelector(".pd-message-image button").click(); true');
    await wait('document.querySelector(".pd-image-preview[open] img")?.complete');
    await delay(250);
    const close = await hit('dialog[open] header button');
    assert.equal(close, 1, 'Preview close button is HTCLIENT, never a caption hit');
    const background = await hit('.pd-top-bar', .5);
    assert.equal(background, 1, 'The underlying caption hit region is retired');
    await evaluate('document.querySelector("dialog[open] header button").click(); true');
    await wait('!document.querySelector("dialog[open]")'); await delay(250);
    const after = await hit('.pd-top-bar', .5);
    assert.equal(after, 2, 'Closing the preview restores HTCAPTION');
    console.log(JSON.stringify({ status: 'passed', before, previewClose: close, during: background, after, directory }));
  } catch (error) {
    console.error(error.stack ?? error); process.exitCode = 1;
  } finally {
    clearTimeout(timer); if (win && !win.isDestroyed()) win.destroy(); app.exit(process.exitCode ?? 0);
  }
  })().catch(error => { console.error(error.stack ?? error); process.exit(1); });
}
