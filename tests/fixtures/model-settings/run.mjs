// This is a terminal test runner for our built renderer, never desktop UI control.
// Preparation: node tests/fixtures/model-settings/run.mjs --check
// Explicit run: node tests/fixtures/model-settings/run.mjs --run
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { installModelSettingsFixture } from './fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const buildRoot = join(root, 'packages/desktop/out/renderer');
const args = process.argv.slice(2);
const option = (name, fallback) => args.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
const browserCache = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'ms-playwright') : null;
const installedBrowsers = browserCache ? await readdir(browserCache).catch(() => []) : [];
const candidates = [
  process.env.PI_REVIEW_BROWSER,
  ...installedBrowsers.filter(name => name.startsWith('chromium_headless_shell-')).sort().reverse().map(name => join(browserCache, name, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')),
].filter(Boolean);
const browserPath = candidates.find(existsSync);
const html = await readFile(join(buildRoot, 'index.html'), 'utf8');
const assets = [...html.matchAll(/(?:src|href)="\.\/([^\"]+)"/g)].map((match) => match[1]);
assert(assets.some((asset) => asset.endsWith('.js')) && assets.some((asset) => asset.endsWith('.css')), 'Run pnpm build first: renderer JS/CSS missing');
const assetMetadata = await Promise.all(assets.map(async (asset) => {
  const absolute = resolve(buildRoot, asset);
  assert(!relative(buildRoot, absolute).startsWith('..'), 'Asset outside renderer root');
  const content = await readFile(absolute);
  const info = await stat(absolute);
  return { asset, bytes: content.length, modified: info.mtime.toISOString(), sha256: createHash('sha256').update(content).digest('hex') };
}));
if (!args.includes('--run')) {
  console.log(JSON.stringify({ status: 'prepared-not-launched', browserPath: browserPath ?? null, node: process.version, buildRoot, assets: assetMetadata, launchRequires: '--run', scenario: option('--scenario', 'scenarios.mjs') }, null, 2));
  process.exit(0);
}
assert(browserPath, 'No dedicated headless-shell binary found. Set PI_REVIEW_BROWSER to a dedicated test browser. Do not attach an existing browser.');
assert(/headless[-_]shell/i.test(browserPath), 'This runner only launches a dedicated headless shell');
const width = Number(option('--width', '1440'));
const height = Number(option('--height', '1000'));
assert(Number.isInteger(width) && width >= 400 && width <= 4000 && Number.isInteger(height) && height >= 400 && height <= 4000, 'Invalid viewport');
const outputRoot = join(root, 'out/review/model-settings/runs');
await mkdir(outputRoot, { recursive: true });
const runDirectory = await mkdtemp(join(outputRoot, 'run-'));
const profile = join(runDirectory, 'profile');
await mkdir(profile);
const logs = { console: [], exceptions: [], blockedRequests: [], steps: [], inputEvents: [] };
let child, socket, server, cleanupPromise, sequence = 0;
const pending = new Map();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { status: 'running', browserPath, buildRoot, assets: assetMetadata, width, height, startedAt: new Date().toISOString(), logs };
const closePromise = () => new Promise((resolve) => {
  if (!child || child.exitCode !== null) return resolve();
  const timer = setTimeout(resolve, 3000);
  child.once('exit', () => { clearTimeout(timer); resolve(); });
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 12000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result?.value;
}
async function waitFor(expression, timeout = 12000) {
  const deadline = Date.now() + timeout;
  do { if (await evaluate(expression)) return; await delay(75); } while (Date.now() < deadline);
  throw new Error(`DOM condition timed out: ${expression}`);
}
async function settle() {
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}
async function clickElement(expression) {
  const point = await evaluate(`(() => { const e = ${expression}; if (!e || e.disabled) throw new Error('Click target missing or disabled'); e.scrollIntoView({block:'center',inline:'nearest'}); const box=e.getBoundingClientRect(); const x=Math.max(0,Math.min(innerWidth-1,box.x+box.width/2)); const y=Math.max(0,Math.min(innerHeight-1,box.y+box.height/2)); const hit=document.elementFromPoint(x,y); if (!(hit===e || e.contains(hit))) throw new Error('Click target is obscured'); return {x,y}; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  await settle();
}
async function closeOwnedBrowser() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
  try { if (socket?.readyState === WebSocket.OPEN) await send('Browser.close'); } catch {}
  socket?.close();
  await closePromise();
  if (child && child.exitCode === null) {
    // The only kill target is the exact process spawned above and its descendants.
    await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    await closePromise();
  }
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Owned browser closed')); }
  pending.clear();
  if (server) await new Promise((resolve) => server.close(resolve));
  const target = resolve(profile);
  const boundary = resolve(runDirectory);
  assert(target.startsWith(boundary + sep) && relative(outputRoot, boundary).startsWith('run-'), 'Unsafe profile cleanup path');
  await rm(target, { recursive: true, force: true, maxRetries: 2 }).catch((error) => { report.cleanupError = error.message; });
  })();
  return cleanupPromise;
}
let deadline;
try {
  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      const file = resolve(buildRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
      const rel = relative(buildRoot, file);
      if (rel.startsWith('..') || isAbsolute(rel)) { response.writeHead(403).end(); return; }
      const content = await readFile(file);
      response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' })[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  child = spawn(browserPath, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-gpu', '--mute-audio', 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let launchError;
  child.once('error', (error) => { launchError = error; });
  child.stderr.on('data', (chunk) => { report.browserStderr = ((report.browserStderr ?? '') + chunk.toString()).slice(-8000); });
  report.pid = child.pid;
  deadline = setTimeout(() => { void closeOwnedBrowser(); }, 90000);
  let port;
  const launchDeadline = Date.now() + 10000;
  while (Date.now() < launchDeadline) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`Headless shell exited: ${child.exitCode}`);
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]); if (port) break; } catch {}
    await delay(100);
  }
  assert(port, 'Dedicated headless browser did not publish its debugging port');
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const target = targets.find((entry) => entry.type === 'page' && entry.url === 'about:blank');
  assert(target, 'Owned test target missing');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id); pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') logs.exceptions.push(message.params.exceptionDetails);
    else if (message.method === 'Runtime.consoleAPICalled') {
      const text = message.params.args?.[0]?.value;
      if (typeof text === 'string' && text.startsWith('__MODEL_REVIEW_INPUT__')) logs.inputEvents.push(JSON.parse(text.slice('__MODEL_REVIEW_INPUT__'.length)));
      else if (['error', 'warning'].includes(message.params.type)) logs.console.push(message.params);
    }
    else if (message.method === 'Fetch.requestPaused') {
      const { requestId, request } = message.params;
      const allowed = request.url.startsWith(`${origin}/`) || request.url.startsWith('data:');
      if (!allowed) logs.blockedRequests.push(request.url);
      void send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed ? { requestId } : { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    }
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(${installModelSettingsFixture.toString()})(${JSON.stringify({ locale: option('--locale', 'zh-CN'), theme: option('--theme', 'dark') })});` });
  await send('Page.navigate', { url: `${origin}/` });
  const mouse = { x: 0, y: 0, down: false };
  const review = {
    evaluate, waitFor, settle,
    mouseDown: async (x, y) => {
      assert(Number.isFinite(x) && Number.isFinite(y) && !mouse.down, 'Invalid mouse press');
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      Object.assign(mouse, { x, y, down: true }); logs.steps.push({ mouseDown: { x, y } });
      await settle();
    },
    mouseMove: async (x, y, steps = 1) => {
      assert(Number.isFinite(x) && Number.isFinite(y) && Number.isInteger(steps) && steps >= 1 && steps <= 100, 'Invalid mouse move');
      const start = { x: mouse.x, y: mouse.y };
      for (let index = 1; index <= steps; index++) {
        const point = { x: start.x + (x - start.x) * index / steps, y: start.y + (y - start.y) * index / steps };
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: mouse.down ? 'left' : 'none', buttons: mouse.down ? 1 : 0 });
        await settle();
      }
      Object.assign(mouse, { x, y }); logs.steps.push({ mouseMove: { x, y, steps, pressed: mouse.down } });
    },
    mouseUp: async () => {
      assert(mouse.down, 'No mouse press to release');
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mouse.x, y: mouse.y, button: 'left', buttons: 0, clickCount: 1 });
      mouse.down = false; logs.steps.push({ mouseUp: { x: mouse.x, y: mouse.y } });
      await settle();
    },
    key: async (key, options = {}) => {
      const codes = { Tab: ['Tab', 9], Enter: ['Enter', 13], Escape: ['Escape', 27], ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40], Home: ['Home', 36], End: ['End', 35], Backspace: ['Backspace', 8], F10: ['F10', 121], ' ': ['Space', 32] };
      const [code, windowsVirtualKeyCode] = codes[key] ?? [`Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0)];
      const modifiers = (options.alt ? 1 : 0) | (options.ctrl ? 2 : 0) | (options.meta ? 4 : 0) | (options.shift ? 8 : 0);
      logs.steps.push({ key, modifiers });
      const text = !(options.ctrl || options.meta || options.alt) ? key === 'Enter' ? '\r' : key.length === 1 ? key : undefined : undefined;
      await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode, modifiers, ...(text ? { text, unmodifiedText: text } : {}) });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers });
      await settle();
    },
    reducedMotion: async (reduce) => { await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }] }); await settle(); },
    record: async (name, expression) => { logs.steps.push({ name, evidence: await evaluate(expression) }); },
    assert: async (expression, message) => { assert.equal(await evaluate(expression), true, message); logs.steps.push({ assertion: message }); },
    click: async (selector) => { logs.steps.push({ click: selector }); await waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)}))`); await clickElement(`document.querySelector(${JSON.stringify(selector)})`); },
    clickText: async (selector, text) => { logs.steps.push({ clickText: text, selector }); await clickElement(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(text)})`); },
    fill: async (selector, value) => {
      logs.steps.push({ fill: selector, characters: value.length });
      const tag = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e || e.disabled || e.readOnly) throw new Error('Input missing, disabled, or readonly'); e.scrollIntoView({block:'center'}); e.focus(); if(document.activeElement!==e) throw new Error('Input could not receive focus'); return e.tagName; })()`);
      if (tag === 'SELECT') {
        await evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('change',{bubbles:true})); })()`);
      } else {
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
        if (value) await send('Input.insertText', { text: value });
        else {
          await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        }
      }
      await settle();
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`), value, `Input did not retain typed value: ${selector}`);
    },
    screenshot: async (name) => { assert(/^[a-z0-9-]+$/.test(name), 'Invalid screenshot name'); await settle(); await evaluate('Promise.race([Promise.allSettled(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)), new Promise(resolve => setTimeout(resolve, 1000))])'); const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(join(runDirectory, `${name}.png`), Buffer.from(result.data, 'base64')); logs.steps.push({ screenshot: `${name}.png` }); },
    viewport: async (nextWidth, nextHeight) => { await send('Emulation.setDeviceMetricsOverride', { width: nextWidth, height: nextHeight, deviceScaleFactor: 1, mobile: false }); await settle(); },
  };
  const { default: scenarios } = await import(pathToFileURL(resolve(here, option('--scenario', 'scenarios.mjs'))).href);
  await scenarios(review);
  const fixtureResult = await evaluate('({ errors: window.__modelReview.errors, unexpected: window.__modelReview.unexpected, calls: window.__modelReview.calls })');
  report.fixture = fixtureResult;
  assert.deepEqual(fixtureResult.errors, []);
  assert.deepEqual(fixtureResult.unexpected, []);
  assert.deepEqual(logs.exceptions, []);
  assert.deepEqual(logs.console.filter((entry) => entry.type === 'error'), []);
  assert.deepEqual(logs.blockedRequests, []);
  report.status = 'passed';
} catch (error) {
  // No further DOM probing or screenshot retries after an automation failure.
  report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await closeOwnedBrowser();
  report.finishedAt = new Date().toISOString();
  await writeFile(join(runDirectory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, runDirectory, error: report.error ?? null, cleanupError: report.cleanupError ?? null }, null, 2));
}
