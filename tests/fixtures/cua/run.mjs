// Opt-in Windows integration checks. Every input target is launched by this runner.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { getBackend } from '../../../packages/agent/src/cua/core.ts';
import { cuaExtension } from '../../../packages/agent/src/cua/extension.ts';

const exec = promisify(execFile);
const backend = getBackend();
const dll = resolve('_ai_work/cua-capture-build/bin/Capture/release/Capture.dll');
const [, , mode, wordExe] = process.argv;
assert.equal(process.platform, 'win32');
assert.ok(mode === 'verify' || mode === 'benchmark', 'Specify verify or benchmark explicitly');
const workspace = mkdtempSync(resolve('_ai_work/cua-fixture-'));
const processes = [];

async function until(read, label, timeout = 8000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = read();
		if (value) return value;
		await delay(25);
	}
	throw new Error('Timed out waiting for ' + label);
}

function launch(executable, args) {
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	const child = spawn(executable, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
	processes.push(child);
	const messages = [];
	createInterface({ input: child.stdout }).on('line', (line) => {
		try { messages.push(JSON.parse(line)); } catch { /* Process diagnostic output. */ }
	});
	child.stdin.on('error', () => {});
	let error;
	let stderr = '';
	child.on('error', (failure) => { error = failure; });
	child.stderr.on('data', (chunk) => { stderr += chunk; });
	return {
		child, messages,
		send: (line) => child.stdin.write(line + '\n'),
		wait: (predicate, label) => until(() => {
			if (error || child.exitCode !== null) throw error ?? new Error(executable + ' exited before ' + label + '\n' + stderr);
			return messages.find(predicate);
		}, label),
	};
}

async function fixture(args) {
	const app = launch('dotnet', [dll, ...args]);
	const ready = await app.wait((message) => message.kind === 'ready', args[0] + ' HWND');
	assert.equal(backend.windowApplication(ready.hwnd).pid, app.child.pid);
	return { ...app, ...ready };
}

async function closeFixture(app) {
	app.send('close');
	await until(() => app.child.exitCode !== null, 'fixture exit');
}

async function closeOwnedWindow(app, hwnd) {
	assert.equal(backend.windowApplication(hwnd).pid, app.child.pid);
	const require = createRequire(new URL('../../../packages/agent/package.json', import.meta.url));
	const user32 = require('koffi').load('user32.dll');
	const post = user32.func('bool __stdcall PostMessageW(intptr_t hwnd, uint32_t message, uintptr_t wParam, intptr_t lParam)');
	assert.ok(post(hwnd, 0x10, 0, 0), 'WM_CLOSE delivered to fixture');
	await until(() => app.child.exitCode !== null, 'owned window exit');
}

async function command(app, kind) {
	const start = app.messages.length;
	app.send(kind);
	return app.wait((message) => message.kind === kind && app.messages.indexOf(message) >= start, kind);
}

async function focusFixture(app) {
	await command(app, 'focus');
	if (backend.foregroundWindow() !== app.hwnd) {
		const bounds = backend.windowRect(app.hwnd);
		const x = bounds.x + Math.floor(bounds.width / 2);
		const y = bounds.y + Math.floor(bounds.height * 0.75);
		assert.equal(backend.windowAtPoint(x, y), app.hwnd, 'focus click hits the test fixture');
		backend.mouseClick('left', x, y);
		await until(() => backend.foregroundWindow() === app.hwnd, 'fixture foreground');
		await command(app, 'focus');
	}
}

async function verify() {
	const app = await fixture(['fixture', 'Pi CUA WinForms regression']);
	const remembered = new Set();
	const permission = { isAllowed: (key) => remembered.has(key), allow: (key) => remembered.add(key), clear: () => remembered.clear() };
	const notes = [];
	const ctx = { hasUI: true, ui: { select: async (title) => { notes.push(title); return '始终允许（所有对话）'; } } };
	const createConversation = (nativeBackend) => {
		const tools = new Map();
		cuaExtension({ backend: nativeBackend, scopes: permission })({ registerTool: (tool) => tools.set(tool.name, tool), registerCommand() {}, on() {} });
		return (name, args, signal) => tools.get(name).execute('fixture', args, signal, undefined, ctx);
	};
	let beforeType;
	const call = createConversation({
		...backend,
		typeText: async (...args) => { await beforeType?.(); return backend.typeText(...args); },
	});
	const observe = () => call('cua_get_state', { hwnd: app.hwnd });
	const element = (result, label) => {
		const line = result.content[0].text.split('\n').find((text) => text.includes(label));
		assert.ok(line, 'UIA element visible: ' + label + '\n' + result.content[0].text);
		return Number(line.match(/\[(\d+)\]/)[1]);
	};
	await focusFixture(app);
	let observation = await observe();
	await call('cua_invoke', { observationId: observation.details.observationId, element: element(observation, 'Pi CUA button') });
	await app.wait((message) => message.kind === 'click', 'native UIA Invoke callback');
	observation = await observe();
	await call('cua_set_value', { observationId: observation.details.observationId, element: element(observation, 'Pi CUA field'), value: '原生 Value' });
	await app.wait((message) => message.kind === 'value' && message.value === '原生 Value', 'native UIA SetValue callback');
	await focusFixture(app);
	await call('cua_key', { window: app.hwnd, keys: 'ctrl+a' });
	await call('cua_type', { window: app.hwnd, text: '你好 Pi', method: 'unicode' });
	await app.wait((message) => message.kind === 'value' && message.value === '你好 Pi', 'native Unicode input');

	const bounds = backend.windowRect(app.hwnd);
	const shot = await call('cua_screenshot', { window: app.hwnd, maxWidth: 256 });
	assert.ok(shot.details.encoded.width < shot.details.width, 'fixture screenshot is downscaled');
	observation = await observe();
	const index = element(observation, 'Pi CUA button');
	const button = observation.content[0].text.split('\n').find((line) => line.includes('Pi CUA button'));
	const [, x, y, width, height] = button.match(/\[(-?\d+),(-?\d+) (\d+)x(\d+)\]/).map(Number);
	const point = {
		x: Math.round((x + width / 2 - bounds.x) * shot.details.encoded.width / bounds.width),
		y: Math.round((y + height / 2 - bounds.y) * shot.details.encoded.height / bounds.height),
		frame: shot.details.frame,
		coordinateSpace: 'image',
	};

	const overlay = await fixture(['overlay', String(x), String(y), String(width), String(height)]);
	await assert.rejects(call('cua_left_click', point), /TARGET_MISMATCH.*未命中/);
	await assert.rejects(call('cua_left_click', { observationId: observation.details.observationId, element: index }), /TARGET_MISMATCH.*未命中/);
	await closeFixture(overlay);
	await call('cua_left_click', point);
	await app.wait(() => app.messages.filter((message) => message.kind === 'click').length === 2, 'physical image-coordinate click');
	app.send('move');
	await app.wait((message) => message.kind === 'move', 'fixture move');
	await assert.rejects(call('cua_left_click', point), /STALE_STATE.*窗口已移动/);

	await command(app, 'popup');
	await assert.rejects(call('cua_key', { window: app.hwnd, keys: 'enter' }), /TARGET_MISMATCH|FOREGROUND_FAILED/);
	app.send('close-popup');
	await app.wait((message) => message.kind === 'popup-closed', 'modal fixture exit');

	const second = await fixture(['fixture', 'Pi CUA second conversation', 'unaware']);
	await command(second, 'reposition');
	const secondCall = createConversation(backend);
	await focusFixture(second);
	const secondFrame = await secondCall('cua_screenshot', { window: second.hwnd, maxWidth: 256 });
	assert.ok(secondFrame.details.encoded.width < secondFrame.details.width);
	await secondCall('cua_type', { window: second.hwnd, text: ' DPI', method: 'unicode' });
	await second.wait((item) => item.kind === 'value' && item.value.endsWith(' DPI'), 'input into DPI-unaware fixture');

	await focusFixture(app);
	beforeType = () => focusFixture(second);
	await assert.rejects(call('cua_type', { window: app.hwnd, text: 'wrong-target' }), /TARGET_MISMATCH/);
	assert.equal(second.messages.some((item) => item.value?.includes('wrong-target')), false);

	await focusFixture(app);
	let notifyStarted;
	let resumeInput;
	const started = new Promise((resolve) => { notifyStarted = resolve; });
	const resume = new Promise((resolve) => { resumeInput = resolve; });
	beforeType = async () => { notifyStarted(); await resume; };
	const pending = call('cua_type', { window: app.hwnd, text: ' queued' });
	await started;
	try {
		const abort = new AbortController();
		const competing = secondCall('cua_type', { window: second.hwnd, text: 'cancelled' }, abort.signal);
		await delay(100);
		assert.equal(backend.foregroundWindow(), app.hwnd);
		abort.abort();
		await assert.rejects(competing, /ABORTED/);
	} finally { resumeInput(); }
	await pending;
	await app.wait((item) => item.kind === 'value' && item.value.endsWith(' queued'), 'first conversation input');
	assert.equal(second.messages.some((item) => item.value?.includes('cancelled')), false);
	await closeFixture(second);

	const popupResults = await verifyPopups(createConversation(backend));

	assert.equal(notes.length, 1, 'remembered per-app permission reused across real tools');
	console.log(JSON.stringify({
		result: 'pass', dpi: [app.dpi, second.dpi], popups: popupResults,
		tested: ['scope', 'Invoke', 'SetValue', 'Unicode', 'scaled click', 'occlusion', 'stale frame', 'modal', 'focus delivery', 'two conversations and queue cancellation', 'blocking Invoke', 'owned drop-down list', 'owned context menu'],
	}));
	await closeFixture(app);
}

/** Popups owned by the target window, and a UIA Invoke whose click opens a modal dialog. */
async function verifyPopups(call) {
	const app = await fixture(['fixture', 'Pi CUA popup regression']);
	const observe = () => call('cua_get_state', { hwnd: app.hwnd });
	const row = (result, label) => {
		const line = result.content[0].text.split('\n').find((text) => text.includes(label));
		assert.ok(line, 'UIA element visible: ' + label + '\n' + result.content[0].text);
		const [, x, y, width, height] = line.match(/\[(-?\d+),(-?\d+) (\d+)x(\d+)\]/).map(Number);
		return { index: Number(line.match(/\[(\d+)\]/)[1]), x, y, width, height };
	};

	// WinForms runs the click synchronously inside Invoke; the agent event loop must keep running.
	await focusFixture(app);
	let state = await observe();
	let ticks = 0;
	const ticker = setInterval(() => { ticks += 1; }, 20);
	const started = Date.now();
	const invoked = await call('cua_invoke', { observationId: state.details.observationId, element: row(state, 'Pi CUA modal button').index });
	clearInterval(ticker);
	const invokeMs = Date.now() - started;
	await app.wait((message) => message.kind === 'popup', 'modal dialog opened by UIA Invoke');
	assert.ok(ticks >= Math.floor(invokeMs / 20 / 2), `event loop kept running during Invoke (${ticks} ticks in ${invokeMs} ms)`);
	app.send('close-popup');
	await app.wait((message) => message.kind === 'popup-closed', 'modal dialog closed');

	// Native drop-down list (ComboLBox): a separate top-level window over the item.
	await focusFixture(app);
	state = await observe();
	const combo = row(state, 'Pi CUA combo');
	await call('cua_left_click', { observationId: state.details.observationId, element: combo.index });
	const item = { x: combo.x + Math.round(combo.width / 2), y: combo.y + combo.height + Math.round(app.comboItemHeight * 1.5) + 1 };
	const list = await until(() => {
		const hit = backend.windowAtPoint(item.x, item.y);
		return hit && hit !== app.hwnd ? hit : 0;
	}, 'drop-down list covering the second item');
	await call('cua_left_click', { window: app.hwnd, ...item });
	await app.wait((message) => message.kind === 'combo' && message.value === 'Beta', 'item picked from the owned drop-down list');

	// ToolStrip context menu owned by the form.
	await focusFixture(app);
	const bounds = backend.windowRect(app.hwnd);
	await call('cua_right_click', { window: app.hwnd, x: bounds.x + Math.round(bounds.width / 2), y: bounds.y + bounds.height - 60 });
	const opened = await app.wait((message) => message.kind === 'menu-opened', 'context menu opened');
	const menu = backend.windowRect(opened.hwnd);
	await call('cua_left_click', { window: app.hwnd, x: menu.x + Math.round(menu.width / 2), y: menu.y + 3 + Math.round(opened.itemHeight / 2) });
	await app.wait((message) => message.kind === 'menu', 'item clicked inside the owned context menu');

	await closeFixture(app);
	return { invoke: { completed: invoked.details.completed, ms: invokeMs, ticks }, dropDownHwnd: list, menuHwnd: opened.hwnd };
}

function median(values) {
	const sorted = values.slice().sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function measure(name, hwnd) {
	const bounds = backend.windowRect(hwnd);
	for (const scenario of ['visible', 'covered']) {
		const cover = scenario === 'covered' ? await fixture(['overlay', bounds.x, bounds.y, bounds.width, bounds.height].map(String)) : null;
		try {
			await delay(230);
			for (const capture of ['PrintWindow', 'WGC']) {
				const { stdout } = await exec('dotnet', [dll, 'measure', String(hwnd), '7', capture], { windowsHide: true, timeout: 25000 });
				const attempts = JSON.parse(stdout.trim()).slice(1);
				const successes = attempts.filter((row) => row.NonBlank && row.Error === null);
				console.log(JSON.stringify({
					name, scenario, capture, success: successes.length, attempts: attempts.length,
					medianMs: successes.length ? median(successes.map((row) => row.Milliseconds)) : null,
					medianCpuMs: successes.length ? median(successes.map((row) => row.CpuMilliseconds)) : null,
					medianWorkingSetMiB: successes.length ? median(successes.map((row) => row.WorkingSetBytes)) / (1024 ** 2) : null,
					errors: [...new Set(attempts.map((row) => row.Error).filter(Boolean))],
				}));
			}
		} finally {
			if (cover) await closeFixture(cover);
		}
	}
}

async function benchmark() {
	const own = await fixture(['fixture', 'Pi CUA WinForms capture']);
	await measure('WinForms', own.hwnd);
	await closeFixture(own);

	const chromium = launch(resolve('packages/desktop/node_modules/electron/dist/electron.exe'), [resolve('tests/fixtures/cua/chromium.cjs'), join(workspace, 'chromium')]);
	const window = await chromium.wait((message) => message.kind === 'ready', 'Chromium HWND');
	assert.equal(backend.windowApplication(window.hwnd).pid, chromium.child.pid);
	await measure('Chromium', window.hwnd);
	await closeOwnedWindow(chromium, window.hwnd);

	if (wordExe) {
		const word = launch(wordExe, ['/w', '/a', '/q']);
		const window = await until(
			() => backend.listWindows().windows.find((value) => value.pid === word.child.pid && !value.minimized && value.width > 300 && value.height > 200),
			'fresh Word instance', 12000,
		);
		await measure('Microsoft Word', window.hwnd);
		await closeOwnedWindow(word, window.hwnd);
	} else {
		console.log(JSON.stringify({ name: 'Microsoft Word', result: 'skipped', reason: 'Pass the Word executable for an independent blank instance.' }));
	}
}

try {
	await (mode === 'verify' ? verify() : benchmark());
} finally {
	for (const process of processes.reverse()) {
		if (process.exitCode === null && process.pid) process.kill();
	}
	await rm(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
