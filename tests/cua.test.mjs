// desktop-cua (computer-use): key-name parsing, coordinate/region math, image
// encoding, the session gate around the tools, and a read-only native smoke
// test on Windows. Nothing here injects mouse/keyboard input.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { CuaError, CuaSessionState, cropRawCapture, getBackend, isCuaSupported, normalizeRegion, parseKeys } from '../packages/agent/src/cua/core.ts';
import { cropBgra, downscaleBgra, encodeImage } from '../packages/agent/src/cua/imageEncode.ts';
import { clampRegion, clipboardPaste, toAbsolute } from '../packages/agent/src/cua/win32Native.ts';
import { cuaExtension } from '../packages/agent/src/cua/extension.ts';
import { CUA_PERMISSION_MESSAGE, CUA_PERMISSION_TITLE, CuaPermissionStore, CuaScopeStore } from '../packages/agent/src/cua/permissions.ts';

test('parseKeys maps letters case-insensitively (regression: letters used to be unknown)', () => {
	assert.deepEqual(parseKeys('ctrl+c'), { modifiers: [0x11], key: 0x43 });
	assert.deepEqual(parseKeys('CTRL+A'), { modifiers: [0x11], key: 0x41 });
	assert.deepEqual(parseKeys('ctrl+shift+t'), { modifiers: [0x11, 0x10], key: 0x54 });
	assert.deepEqual(parseKeys('a'), { modifiers: [], key: 0x41 });
	assert.deepEqual(parseKeys('5'), { modifiers: [], key: 0x35 });
});

test('parseKeys handles named keys, bare modifiers and the plus alias', () => {
	assert.deepEqual(parseKeys('enter'), { modifiers: [], key: 0x0d });
	assert.deepEqual(parseKeys('alt+f4'), { modifiers: [0x12], key: 0x73 });
	assert.deepEqual(parseKeys('f24'), { modifiers: [], key: 0x87 });
	assert.deepEqual(parseKeys('win'), { modifiers: [], key: 0x5b });
	assert.deepEqual(parseKeys('ctrl+shift'), { modifiers: [0x11], key: 0x10 });
	assert.deepEqual(parseKeys('ctrl+plus'), { modifiers: [0x11], key: 0xbb });
	assert.deepEqual(parseKeys(' Ctrl + Shift + Esc '), { modifiers: [0x11, 0x10], key: 0x1b });
});

test('parseKeys rejects empty specs, unknown names and multi-key chords', () => {
	assert.throws(() => parseKeys(''), /为空/);
	assert.throws(() => parseKeys('ctrl+nope'), /无法识别/);
	assert.throws(() => parseKeys('a+b'), /一个主键/);
});

test('toAbsolute normalizes into 0..65535 and clamps outside the virtual desktop', () => {
	const screen = { x: -1920, y: 0, width: 3840, height: 1080 };
	assert.deepEqual(toAbsolute(-1920, 0, screen), { dx: 0, dy: 0 });
	assert.deepEqual(toAbsolute(1919, 1079, screen), { dx: 65535, dy: 65535 });
	assert.deepEqual(toAbsolute(99999, -50, screen), { dx: 65535, dy: 0 });
	const mid = toAbsolute(0, 540, screen);
	assert.ok(Math.abs(mid.dx - 32776) <= 1 && Math.abs(mid.dy - 32798) <= 1, JSON.stringify(mid));
});

test('clampRegion intersects with the virtual desktop', () => {
	const screen = { x: 0, y: 0, width: 1920, height: 1080 };
	assert.deepEqual(clampRegion({ x: -10, y: -10, width: 110, height: 60 }, screen), { x: 0, y: 0, width: 100, height: 50 });
	assert.deepEqual(clampRegion({ x: 1900, y: 1000, width: 100, height: 100 }, screen), { x: 1900, y: 1000, width: 20, height: 80 });
	const outside = clampRegion({ x: -500, y: -500, width: 100, height: 100 }, screen);
	assert.ok(outside.width <= 0 || outside.height <= 0);
});

test('cropBgra and cropRawCapture extract exact sub-rectangles and clamp to capture bounds', () => {
	// 4x3 BGRA grid where pixel (x, y) encodes [x, y, x + y, 0xff].
	const source = Buffer.alloc(4 * 3 * 4);
	for (let y = 0; y < 3; y++) {
		for (let x = 0; x < 4; x++) {
			const i = (y * 4 + x) * 4;
			source[i] = x;
			source[i + 1] = y;
			source[i + 2] = x + y;
			source[i + 3] = 0xff;
		}
	}
	assert.equal(cropBgra(source, 4, 3, 0, 0, 4, 3), source);
	const cropped = cropBgra(source, 4, 3, 1, 1, 2, 2);
	assert.deepEqual([...cropped], [
		1, 1, 2, 0xff, 2, 1, 3, 0xff,
		1, 2, 3, 0xff, 2, 2, 4, 0xff,
	]);
	assert.throws(() => cropBgra(source, 4, 3, -1, 0, 2, 2), /越界/);
	assert.throws(() => cropBgra(source, 4, 3, 3, 0, 2, 2), /越界/);
	assert.throws(() => cropBgra(source, 4, 3, 0, 0, 0, 2), /越界/);

	// Screen-space crop clamps to the captured window rectangle.
	const raw = { width: 4, height: 3, origin: { x: 100, y: 200 }, bgra: source };
	const sub = cropRawCapture(raw, { x: 99, y: 201, width: 3, height: 10 });
	assert.deepEqual(sub.origin, { x: 100, y: 201 });
	assert.equal(sub.width, 2);
	assert.equal(sub.height, 2);
	assert.deepEqual([...sub.bgra], [
		0, 1, 1, 0xff, 1, 1, 2, 0xff,
		0, 2, 2, 0xff, 1, 2, 3, 0xff,
	]);
	assert.throws(() => cropRawCapture(raw, { x: 200, y: 200, width: 10, height: 10 }), /CUA INVALID_ARGUMENTS.*没有交集/);
});

test('normalizeRegion validates screenshot region parameters once into an integer rect', () => {
	assert.equal(normalizeRegion({}), undefined);
	assert.equal(normalizeRegion({ maxWidth: 800 }), undefined);
	assert.deepEqual(normalizeRegion({ x: -10.4, y: 20.6, width: 99.5, height: 50 }), { x: -10, y: 21, width: 100, height: 50 });
	assert.throws(() => normalizeRegion({ x: 0, y: 0, width: 10 }), /CUA INVALID_ARGUMENTS.*同时提供/);
	for (const bad of [
		{ x: 0, y: 0, width: 0, height: 5 },
		{ x: 0, y: 0, width: 5, height: -3 },
		{ x: 0, y: 0, width: 0.4, height: 5 },
		{ x: Number.NaN, y: 0, width: 5, height: 5 },
		{ x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 5 },
	]) {
		assert.throws(() => normalizeRegion(bad), /CUA INVALID_ARGUMENTS.*大于 0/, JSON.stringify(bad));
	}
});

test('downscaleBgra keeps aspect ratio and leaves small images untouched', () => {
	const source = Buffer.alloc(3200 * 10 * 4, 0x80);
	const scaled = downscaleBgra(source, 3200, 10, 1600);
	assert.equal(scaled.width, 1600);
	assert.equal(scaled.height, 5);
	assert.equal(scaled.bgra.length, 1600 * 5 * 4);
	assert.ok(scaled.bgra.every((byte) => byte === 0x80));
	const small = Buffer.alloc(4 * 4 * 4);
	assert.equal(downscaleBgra(small, 4, 4, 1600).bgra, small);
});

test('encodeImage falls back to a valid RGBA PNG outside Electron', () => {
	// 2x1 image: pure blue then pure red in BGRA order.
	const bgra = Buffer.from([0xff, 0, 0, 0xff, 0, 0, 0xff, 0xff]);
	const image = encodeImage(bgra, 2, 1);
	assert.equal(image.format, 'png');
	assert.equal(image.mimeType, 'image/png');
	assert.equal(image.scale, 1);
	const png = Buffer.from(image.data, 'base64');
	assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	assert.equal(png.readUInt32BE(16), 2);
	assert.equal(png.readUInt32BE(20), 1);
	const idatLength = png.readUInt32BE(33);
	assert.equal(png.subarray(37, 41).toString('ascii'), 'IDAT');
	const raw = inflateSync(png.subarray(41, 41 + idatLength));
	assert.deepEqual([...raw], [0, 0, 0, 0xff, 0xff, 0xff, 0, 0, 0xff]);
});

function fakePi() {
	const tools = new Map();
	const commands = new Map();
	const handlers = [];
	return {
		tools,
		commands,
		handlers,
		api: {
			registerTool: (tool) => tools.set(tool.name, tool),
			registerCommand: (name, command) => commands.set(name, command),
			on: (event, handler) => handlers.push({ event, handler }),
		},
	};
}

test('extension registers the tool surface without touching native code', () => {
	const pi = fakePi();
	cuaExtension({ state: new CuaSessionState() })(pi.api);
	assert.deepEqual([...pi.tools.keys()].sort(), [
		'cua_activate_window', 'cua_double_click', 'cua_drag', 'cua_get_state', 'cua_invoke', 'cua_key', 'cua_left_click', 'cua_list_windows', 'cua_mouse_move',
		'cua_read_clipboard', 'cua_right_click', 'cua_screenshot', 'cua_scroll', 'cua_set_value', 'cua_type', 'cua_wait', 'cua_write_clipboard',
	]);
	assert.ok(pi.commands.has('cua'));
	for (const tool of pi.tools.values()) assert.equal(tool.executionMode, 'sequential', tool.name);
});

test('tools are blocked while the session switch is off', async () => {
	const pi = fakePi();
	const state = new CuaSessionState();
	cuaExtension({ state })(pi.api);
	const gate = pi.handlers.find((entry) => entry.event === 'tool_call').handler;
	assert.deepEqual(Object.keys(await gate({ toolName: 'cua_screenshot' })), ['block', 'reason']);
	assert.equal(await gate({ toolName: 'read' }), undefined);
	await assert.rejects(pi.tools.get('cua_key').execute('id', { keys: 'enter' }), /未启用/);
	const notes = [];
	await pi.commands.get('cua').handler('off', { ui: { notify: (message, level) => notes.push([message, level]) } });
	assert.equal(state.enabled, false);
	assert.match(notes[0][0], /已关闭/);
	const completions = pi.commands.get('cua').getArgumentCompletions('o');
	assert.deepEqual(completions, [{ value: 'on', label: 'on' }, { value: 'off', label: 'off' }]);
});

test('/cua on enables only when the platform backend works', async () => {
	const pi = fakePi();
	const state = new CuaSessionState();
	cuaExtension({ state })(pi.api);
	const notes = [];
	await pi.commands.get('cua').handler('on', { ui: { notify: (message, level) => notes.push([message, level]) } });
	assert.equal(state.enabled, isCuaSupported());
	assert.equal(notes.length, 1);
	if (!isCuaSupported()) assert.match(notes[0][0], /尚未支持/);
});

function permissionFixture({ confirm = async () => true, permissions, platform = 'win32', probeError } = {}) {
	const pi = fakePi(), state = new CuaSessionState();
	const calls = { prompts: [], probes: 0, moves: [], notes: [] };
	const backend = {
		platform,
		virtualScreen: () => { calls.probes++; if (probeError) throw new Error(probeError); return { x: 0, y: 0, width: 800, height: 600 }; },
		mouseMove: (x, y) => calls.moves.push([x, y]),
	};
	cuaExtension({ state, backend, permissions })(pi.api);
	const ctx = { hasUI: true, ui: {
		confirm: async (...args) => { calls.prompts.push(args); return confirm(...args); },
		notify: (...args) => calls.notes.push(args),
	} };
	return { pi, state, calls, ctx, gate: pi.handlers.find(item => item.event === 'tool_call').handler };
}

test('first CUA use waits for explicit conversation consent, then resumes without another prompt', async () => {
	let answer;
	const f = permissionFixture({ confirm: () => new Promise(resolve => { answer = resolve; }) });
	const first = f.gate({ toolName: 'cua_mouse_move' }, f.ctx).then(async blocked => {
		assert.equal(blocked, undefined);
		return f.pi.tools.get('cua_mouse_move').execute('first-call', { x: 10, y: 20 });
	});
	assert.equal(f.calls.prompts.length, 1);
	assert.equal(f.calls.prompts[0][0], CUA_PERMISSION_TITLE);
	assert.equal(f.calls.prompts[0][1], CUA_PERMISSION_MESSAGE);
	assert.equal(f.calls.probes, 0);
	assert.deepEqual(f.calls.moves, []);
	assert.equal(f.state.enabled, false);
	answer(true);
	await first;
	assert.equal(f.state.enabled, true);
	assert.deepEqual(f.calls.moves, [[10, 20]]);
	assert.equal(await f.gate({ toolName: 'cua_screenshot' }, f.ctx), undefined);
	assert.equal(f.calls.prompts.length, 1);
});

test('concurrent first CUA calls share one pending conversation confirmation', async () => {
	let answer;
	const f = permissionFixture({ confirm: () => new Promise(resolve => { answer = resolve; }) });
	const first = f.gate({ toolName: 'cua_screenshot' }, f.ctx);
	const second = f.gate({ toolName: 'cua_list_windows' }, f.ctx);
	assert.equal(f.calls.prompts.length, 1);
	answer(true);
	assert.deepEqual(await Promise.all([first, second]), [undefined, undefined]);
	assert.equal(f.calls.probes, 1);
});

test('denial stays closed without repeatedly asking; manual on/off grants and revokes this conversation', async () => {
	let saved = null;
	const permissions = { read: () => saved, write: value => { saved = value; } };
	const f = permissionFixture({ confirm: async () => false, permissions });
	assert.equal((await f.gate({ toolName: 'cua_screenshot' }, f.ctx)).block, true);
	assert.equal(saved, false);
	assert.equal((await f.gate({ toolName: 'cua_key' }, f.ctx)).block, true);
	assert.equal(f.calls.prompts.length, 1);
	assert.equal(f.calls.probes, 0);
	await f.pi.commands.get('cua').handler('on', f.ctx);
	assert.equal(saved, true);
	assert.equal(await f.gate({ toolName: 'cua_key' }, f.ctx), undefined);
	await f.pi.commands.get('cua').handler('off', f.ctx);
	assert.equal(saved, false);
	assert.equal(f.state.enabled, false);
	assert.equal((await f.gate({ toolName: 'cua_key' }, f.ctx)).block, true);
	assert.equal(f.calls.prompts.length, 1);
	const reopened = permissionFixture({ permissions });
	assert.equal((await reopened.gate({ toolName: 'cua_screenshot' }, reopened.ctx)).block, true);
	assert.equal(reopened.calls.prompts.length, 0);
});

test('an aborted request or closed runtime cannot accept a late approval', async () => {
	for (const mode of ['abort', 'shutdown', 'off']) {
		let answer, saved = null;
		const controller = new AbortController();
		const f = permissionFixture({ confirm: () => new Promise(resolve => { answer = resolve; }), permissions: { read: () => saved, write: value => { saved = value; } } });
		f.ctx.signal = controller.signal;
		const pending = f.gate({ toolName: 'cua_screenshot' }, f.ctx);
		assert.equal(f.calls.prompts[0][2].signal, controller.signal);
		if (mode === 'abort') controller.abort();
		else if (mode === 'shutdown') await f.pi.handlers.find(item => item.event === 'session_shutdown').handler();
		else await f.pi.commands.get('cua').handler('off', f.ctx);
		answer(true);
		assert.equal((await pending).block, true, mode);
		assert.equal(f.state.enabled, false, mode);
		assert.notEqual(saved, true, mode);
		assert.equal(f.calls.probes, 0, mode);
	}
});

test('unavailable UI, unsupported platforms and failed native/persistence probes never grant CUA', async () => {
	const noUi = permissionFixture();
	assert.equal((await noUi.gate({ toolName: 'cua_screenshot' }, { hasUI: false })).block, true);
	assert.equal(noUi.calls.prompts.length, 0);
	const unsupported = permissionFixture({ platform: 'unsupported' });
	assert.match((await unsupported.gate({ toolName: 'cua_screenshot' }, unsupported.ctx)).reason, /尚未支持/);
	assert.equal(unsupported.calls.prompts.length, 0);
	let saved = null;
	const broken = permissionFixture({ probeError: 'native unavailable', permissions: { read: () => saved, write: value => { saved = value; } } });
	assert.match((await broken.gate({ toolName: 'cua_screenshot' }, broken.ctx)).reason, /native unavailable/);
	assert.equal(saved, true, 'consent is remembered even when the native backend needs repair');
	assert.equal(broken.state.enabled, false);
	await broken.gate({ toolName: 'cua_screenshot' }, broken.ctx);
	assert.equal(broken.calls.prompts.length, 1);
	const failedWrite = permissionFixture({ permissions: { read: () => null, write: () => { throw new Error('cannot save consent'); } } });
	assert.match((await failedWrite.gate({ toolName: 'cua_screenshot' }, failedWrite.ctx)).reason, /cannot save consent/);
	assert.equal(failedWrite.state.enabled, false);
	assert.equal(failedWrite.calls.probes, 0);
	const failedRead = permissionFixture({ permissions: { read: () => { throw new Error('cannot read consent'); }, write() {} } });
	assert.match((await failedRead.gate({ toolName: 'cua_screenshot' }, failedRead.ctx)).reason, /cannot read consent/);
	assert.equal(failedRead.calls.prompts.length, 0);
	assert.equal(failedRead.calls.probes, 0);
});

test('local consent survives reopening and is isolated from other conversations, forks and paths', () => {
	const root = mkdtempSync(join(tmpdir(), 'pi-cua-consent-'));
	try {
		const scope = { cwd: '/project', sessionId: 'conversation-a', sessionFile: '/sessions/a.jsonl' };
		const first = new CuaPermissionStore(root, scope);
		assert.equal(first.read(), null);
		first.write(true);
		assert.equal(new CuaPermissionStore(root, scope).read(), true);
		assert.equal(new CuaPermissionStore(root, { ...scope, sessionId: 'fork-b' }).read(), null);
		assert.equal(new CuaPermissionStore(root, { ...scope, cwd: '/other' }).read(), null);
		assert.equal(new CuaPermissionStore(root, { ...scope, sessionFile: '/other/a.jsonl' }).read(), null);
		first.write(false);
		assert.equal(new CuaPermissionStore(root, scope).read(), false);
		const file = join(root, readdirSync(root)[0]);
		writeFileSync(file, '{bad');
		assert.throws(() => first.read(), /记录损坏/);
		writeFileSync(file, JSON.stringify({ version: 1, allowed: 'true' }));
		assert.throws(() => first.read(), /记录无效/);
	} finally {
		assert(resolve(root).startsWith(resolve(tmpdir()) + sep));
		rmSync(root, { recursive: true, force: true });
	}
});

test('reopening an authorized conversation enables lazily without asking again', async () => {
	const f = permissionFixture({ permissions: { read: () => true, write: () => { throw new Error('read-only restore'); } } });
	assert.equal(f.state.enabled, false);
	assert.equal(await f.gate({ toolName: 'cua_screenshot' }, f.ctx), undefined);
	assert.equal(f.state.enabled, true);
	assert.equal(f.calls.prompts.length, 0);
	assert.equal(f.calls.probes, 1);
});

test('win32 backend: read-only native smoke (virtual screen, cursor, capture, windows)', { skip: process.platform !== 'win32' }, () => {
	const backend = getBackend();
	const screen = backend.virtualScreen();
	assert.ok(screen.width > 0 && screen.height > 0, JSON.stringify(screen));
	const cursor = backend.cursorPosition();
	assert.ok(Number.isInteger(cursor.x) && Number.isInteger(cursor.y));
	const capture = backend.capture({ x: screen.x, y: screen.y, width: 64, height: 32 });
	assert.equal(capture.width, 64);
	assert.equal(capture.height, 32);
	assert.equal(capture.bgra.length, 64 * 32 * 4);
	for (let i = 3; i < capture.bgra.length; i += 4) assert.equal(capture.bgra[i], 0xff);
	assert.throws(() => backend.capture({ x: screen.x - 1000, y: screen.y - 1000, width: 10, height: 10 }), /区域无效/);
	const { windows } = backend.listWindows();
	assert.ok(Array.isArray(windows));
	for (const window of windows) assert.ok(window.title.length > 0 && window.pid > 0);
	assert.equal(typeof backend.inputDesktopAccessible?.(), 'boolean');
	// v2: window-scoped capture + UIA tree on the first non-minimized window.
	const target = windows.find((w) => !w.minimized && w.width >= 100 && w.height >= 80);
	if (target && backend.captureWindow && backend.windowRect && backend.uiaTree) {
		const rect = backend.windowRect(target.hwnd);
		assert.ok(rect.width >= 100 && rect.height >= 80, JSON.stringify(rect));
		const windowCapture = backend.captureWindow(target.hwnd);
		assert.equal(windowCapture.width * windowCapture.height * 4, windowCapture.bgra.length);
		const subCapture = backend.captureWindow(target.hwnd, { x: rect.x + 10, y: rect.y + 10, width: 40, height: 30 });
		assert.equal(subCapture.width, 40);
		assert.equal(subCapture.height, 30);
		assert.equal(subCapture.bgra.length, 40 * 30 * 4);
		assert.deepEqual(subCapture.origin, { x: rect.x + 10, y: rect.y + 10 });
		const tree = backend.uiaTree(target.hwnd, { maxNodes: 40 });
		assert.ok(tree.count >= 1 && tree.count <= 41, `count=${tree.count}`);
		assert.equal(tree.root.children.length > 0 || tree.count === 1, true);
		assert.ok(['window', 'pane'].includes(tree.root.role) || tree.root.name.length > 0, JSON.stringify(tree.root.role));
	}
});

// ---------------------------------------------------------------------------
// v1.2: typed errors, frame pinning, lock fail-closed, modifier release
// ---------------------------------------------------------------------------

function fullFakeBackend(overrides = {}) {
	const fake = {
		screen: { x: 0, y: 0, width: 800, height: 600 },
		locked: false,
		released: 0,
		windows: [],
		moves: [],
		clicks: [],
		scrolls: [],
		keys: [],
		pastes: [],
		activations: [],
		foreground: 77,
		hitWindow: 77,
		window: { hwnd: 77, title: 'Demo', rect: { x: 10, y: 20, width: 400, height: 300 } },
		windowGone: false,
		tree: {
			root: {
				role: 'window', name: 'Demo', rect: { x: 10, y: 20, width: 400, height: 300 },
				enabled: true, focusable: true, focused: false, offscreen: false, password: false,
				children: [
					{ role: 'button', name: '确定', automationId: 'ok', runtimeId: 'button-ok', canInvoke: true, rect: { x: 110, y: 200, width: 60, height: 24 }, enabled: true, focusable: true, focused: false, offscreen: false, password: false, children: [] },
					{ role: 'edit', name: '搜索', value: 'hi', rect: { x: 20, y: 40, width: 120, height: 20 }, enabled: true, focusable: true, focused: true, offscreen: false, password: false, children: [] },
				],
			},
		},
	};
	const backend = {
		platform: 'win32',
		virtualScreen: () => fake.screen,
		capture: () => ({ width: 4, height: 4, bgra: Buffer.alloc(4 * 4 * 4, 0xff) }),
		captureWindow: (hwnd, region) => {
			fake.windowUsed = hwnd;
			fake.windowRegion = region;
			return { width: fake.window.rect.width, height: fake.window.rect.height, bgra: Buffer.alloc(fake.window.rect.width * fake.window.rect.height * 4, 0x80) };
		},
		listWindows: () => ({ windows: fake.windows, truncated: false }),
		activateWindow: async (hwnd, allowAltFallback) => {
			fake.activations.push({ hwnd, allowAltFallback });
			fake.foreground = hwnd;
			return true;
		},
		foregroundWindow: () => fake.foreground,
		keyboardWindow: () => fake.foreground,
		windowEnabled: () => true,
		windowAtPoint: () => fake.hitWindow,
		windowApplication: (hwnd) => ({ key: 'app:' + hwnd, label: '应用 ' + hwnd, pid: hwnd }),
		mouseMove: (x, y) => { fake.moves.push([x, y]); },
		mouseClick: (button, x, y) => { fake.clicks.push([button, x, y]); },
		mouseDrag: async () => {},
		mouseScroll: (amount, horizontal, point) => { fake.scrolls.push({ amount, horizontal, point }); },
		tapChord: (modifiers, key) => { fake.keys.push({ modifiers, key }); },
		typeText: async (text, _signal, beforePaste) => { beforePaste?.(); fake.pastes.push(text); },
		readClipboard: async () => null,
		writeClipboard: async () => {},
		cursorPosition: () => ({ x: 1, y: 2 }),
		releaseModifiers: () => { fake.released += 1; },
		inputDesktopAccessible: () => !fake.locked,
		windowRect: (hwnd) => {
			if (fake.windowGone || hwnd !== fake.window.hwnd) throw new Error(`GetWindowRect 失败：hwnd=${hwnd}`);
			return { ...fake.window.rect };
		},
		uiaTree: (hwnd) => {
			if (fake.windowGone || hwnd !== fake.window.hwnd) throw new Error(`无法获取窗口的 UIA 元素：hwnd=${hwnd}`);
			return { root: fake.tree.root, count: 3, truncated: false };
		},
		...overrides,
	};
	return { backend, fake };
}

function extensionFixture(backend) {
	const pi = fakePi();
	const state = new CuaSessionState();
	cuaExtension({ state, backend })(pi.api);
	state.enabled = true;
	return { pi, state };
}

test('CuaError embeds code and actionSent; escalation only raises actionSent', () => {
	const error = new CuaError('STALE_STATE', '布局已变化');
	assert.match(error.message, /^CUA STALE_STATE \(actionSent=false\): 布局已变化$/);
	assert.equal(error.code, 'STALE_STATE');
	assert.equal(error.actionSent, false);
	const sent = error.escalateActionSent();
	assert.equal(sent.code, 'STALE_STATE');
	assert.equal(sent.actionSent, true);
	assert.match(sent.message, /actionSent=true/);
	assert.equal(error.escalateActionSent().escalateActionSent().actionSent, true);
	assert.equal(CuaError.from(new Error('boom')).code, 'INTERNAL');
	assert.match(CuaError.from(new Error('boom')).message, /CUA INTERNAL/);
	assert.equal(CuaError.from(new Error('x'), { code: 'ABORTED' }).code, 'ABORTED');
	assert.equal(CuaError.from(error, { actionSent: true }).actionSent, true);
	assert.equal(CuaError.from(error, { actionSent: true }).detail, '布局已变化');
});

test('screenshot hands out frame numbers and coordinate actions validate them', async () => {
	const { backend, fake } = fullFakeBackend();
	const f = extensionFixture(backend);
	const shot = await f.pi.tools.get('cua_screenshot').execute('id', {});
	assert.equal(shot.details.frame, 1);
	assert.match(shot.content.at(-1).text, /frame=1/);
	// Same layout: the pinned frame passes the staleness check.
	await f.pi.tools.get('cua_left_click').execute('id', { x: 10, y: 10, frame: 1 });
	// Geometry change: refused before any input is injected.
	fake.screen = { x: 0, y: 0, width: 1024, height: 768 };
	await assert.rejects(
		f.pi.tools.get('cua_left_click').execute('id', { x: 10, y: 10, frame: 1 }),
		/CUA STALE_STATE \(actionSent=false\).*布局已变化/,
	);
	// Unknown frame number: STALE_STATE.
	await assert.rejects(f.pi.tools.get('cua_mouse_move').execute('id', { x: 1, y: 1, frame: 99 }), /CUA STALE_STATE/);
	// Omitted frame: no check at all.
	await f.pi.tools.get('cua_mouse_move').execute('id', { x: 1, y: 1 });
	// Only the last few frames stay addressable.
	for (let i = 0; i < 12; i++) await f.pi.tools.get('cua_screenshot').execute('id', {});
	assert.ok(f.state.frames.size <= 8);
	assert.equal(Math.max(...f.state.frames.keys()), 13);
});

test('locked screens fail closed before any input is sent', async () => {
	const { backend, fake } = fullFakeBackend();
	const f = extensionFixture(backend);
	fake.locked = true;
	await assert.rejects(f.pi.tools.get('cua_left_click').execute('id', { x: 1, y: 1 }), /CUA SCREEN_LOCKED \(actionSent=false\)/);
	await assert.rejects(f.pi.tools.get('cua_key').execute('id', { keys: 'enter' }), /CUA SCREEN_LOCKED/);
	await assert.rejects(f.pi.tools.get('cua_type').execute('id', { text: 'hi' }), /CUA SCREEN_LOCKED/);
	await assert.rejects(f.pi.tools.get('cua_drag').execute('id', { fromX: 1, fromY: 1, toX: 2, toY: 2 }), /CUA SCREEN_LOCKED/);
	await assert.rejects(f.pi.tools.get('cua_screenshot').execute('id', {}), /CUA SCREEN_LOCKED/);
});

test('revoking or shutting down the session force-releases held modifiers', async () => {
	const { backend, fake } = fullFakeBackend();
	// Never enabled: /cua off must not touch native code.
	const cold = fakePi();
	cuaExtension({ state: new CuaSessionState(), backend })(cold.api);
	await cold.commands.get('cua').handler('off', { ui: { notify() {} } });
	assert.equal(fake.released, 0);
	// Enabled: revoke releases modifiers and clears frames.
	const f = extensionFixture(backend);
	await f.pi.tools.get('cua_screenshot').execute('id', {});
	assert.equal(f.state.frames.size, 1);
	await f.pi.commands.get('cua').handler('off', { ui: { notify() {} } });
	assert.equal(fake.released, 1);
	assert.equal(f.state.enabled, false);
	assert.equal(f.state.frames.size, 0);
	// Re-enable, then shutdown releases again.
	f.state.enabled = true;
	await f.pi.handlers.find((item) => item.event === 'session_shutdown').handler();
	assert.equal(fake.released, 2);
	assert.equal(f.state.enabled, false);
});

test('list_windows shows process names; activate_window fails with typed codes', async () => {
	const { backend, fake } = fullFakeBackend();
	const f = extensionFixture(backend);
	fake.windows = [
		{ hwnd: 1, title: 'Notes', pid: 11, processName: 'notepad.exe', x: 0, y: 0, width: 10, height: 10, minimized: false, foreground: true },
		{ hwnd: 2, title: 'Notes (2)', pid: 11, processName: 'notepad.exe', x: 0, y: 0, width: 10, height: 10, minimized: false, foreground: false },
	];
	const listing = await f.pi.tools.get('cua_list_windows').execute('id', {});
	assert.match(listing.content[0].text, /name=notepad\.exe/);
	assert.equal(listing.details.windows[0].processName, 'notepad.exe');
	// Ambiguous substring (no exact match) refuses instead of picking one.
	await assert.rejects(f.pi.tools.get('cua_activate_window').execute('id', { title: 'otes' }), /CUA AMBIGUOUS_TARGET/);
	fake.windows = [];
	await assert.rejects(f.pi.tools.get('cua_activate_window').execute('id', { title: 'Notes' }), /CUA TARGET_GONE/);
});

test('validation failures carry INVALID_ARGUMENTS and aborts carry ABORTED', async () => {
	const { backend } = fullFakeBackend();
	const f = extensionFixture(backend);
	await assert.rejects(f.pi.tools.get('cua_left_click').execute('id', { x: 1 }), /CUA INVALID_ARGUMENTS/);
	await assert.rejects(f.pi.tools.get('cua_type').execute('id', { text: '' }), /CUA INVALID_ARGUMENTS/);
	await assert.rejects(f.pi.tools.get('cua_key').execute('id', { keys: 'nope' }), /CUA INVALID_ARGUMENTS/);
	const aborted = new AbortController();
	aborted.abort();
	await assert.rejects(f.pi.tools.get('cua_wait').execute('id', { ms: 100 }, aborted.signal), /CUA ABORTED/);
});

// ---------------------------------------------------------------------------
// v2: UIA accessibility tree, element addressing, window-scoped screenshots
// ---------------------------------------------------------------------------

test('cua_get_state returns indexed element rows and stores the observation', async () => {
	const { backend, fake } = fullFakeBackend();
	const f = extensionFixture(backend);
	const result = await f.pi.tools.get('cua_get_state').execute('id', { hwnd: fake.window.hwnd });
	const text = result.content[0].text;
	assert.match(text, /窗口 hwnd=77 “Demo” \[10,20 400x300\]，元素 3 个/);
	assert.match(text, /\[0\] window "Demo"/);
	assert.match(text, /\[1\] button "确定" id=ok \[110,200 60x24\]/);
	assert.match(text, /\[2\] edit "搜索"/);
	assert.match(text, /值="hi"/);
	assert.match(text, /\*焦点\*/);
	assert.equal(f.state.observation?.flat.length, 3);
	assert.equal(result.details.count, 3);
	// Default target = the foreground window.
	fake.windows = [{ hwnd: 77, title: 'Demo', pid: 1, x: 10, y: 20, width: 400, height: 300, minimized: false, foreground: true }];
	assert.equal((await f.pi.tools.get('cua_get_state').execute('id', {})).details.hwnd, 77);
	// Title matching shares the activate_window semantics.
	assert.equal((await f.pi.tools.get('cua_get_state').execute('id', { title: 'Demo' })).details.hwnd, 77);
	// No windows at all → typed failure.
	fake.windows = [];
	await assert.rejects(f.pi.tools.get('cua_get_state').execute('id', {}), /CUA TARGET_GONE.*前台窗口/);
});

test('element addressing resolves centers and fails closed on stale state', async () => {
	const { backend, fake } = fullFakeBackend();
	const f = extensionFixture(backend);
	const observe = () => f.pi.tools.get('cua_get_state').execute('id', { hwnd: fake.window.hwnd });
	const original = (await observe()).details.observationId;
	// element 1 = button [110,200 60x24] → click center (140, 212).
	await f.pi.tools.get('cua_left_click').execute('id', { element: 1, observationId: original });
	assert.deepEqual(fake.clicks.at(-1), ['left', 140, 212]);
	// element and coordinates are mutually exclusive.
	await assert.rejects(f.pi.tools.get('cua_left_click').execute('id', { element: 1, x: 5, y: 5 }), /CUA INVALID_ARGUMENTS.*互斥/);
	// Unknown index → ELEMENT_UNAVAILABLE.
	await assert.rejects(f.pi.tools.get('cua_left_click').execute('id', { element: 99, observationId: original }), /CUA ELEMENT_UNAVAILABLE.*不在最近观察/);
	// Window moved since the observation → STALE_STATE.
	fake.window.rect = { x: 300, y: 20, width: 400, height: 300 };
	await assert.rejects(f.pi.tools.get('cua_left_click').execute('id', { element: 1, observationId: original }), /CUA STALE_STATE.*窗口已移动/);
	// Scroll by element uses the center for the move-and-scroll batch.
	fake.window.rect = { x: 10, y: 20, width: 400, height: 300 };
	const current = (await observe()).details.observationId;
	await assert.rejects(f.pi.tools.get('cua_left_click').execute('id', { element: 1, observationId: original }), /CUA STALE_STATE.*observationId/);
	await f.pi.tools.get('cua_scroll').execute('id', { amount: 3, element: 1, observationId: current });
	assert.deepEqual(fake.scrolls.at(-1), { amount: 3, horizontal: false, point: { x: 140, y: 212 } });
	// No observation at all → STALE_STATE with a re-observe hint.
	f.state.observation = null;
	await assert.rejects(f.pi.tools.get('cua_right_click').execute('id', { element: 0 }), /CUA STALE_STATE.*没有匹配的 cua_get_state/);
});

test('cua_screenshot window scope pins the window rect into the frame', async () => {
	const { backend, fake } = fullFakeBackend();
	const f = extensionFixture(backend);
	const shot = await f.pi.tools.get('cua_screenshot').execute('id', { window: fake.window.hwnd });
	assert.equal(shot.details.window, 77);
	assert.equal(shot.details.width, 400);
	assert.equal(shot.details.height, 300);
	assert.equal(fake.windowUsed, 77);
	assert.match(shot.content.at(-1).text, /窗口作用域 hwnd=77/);
	// Coordinates pinned to this frame stay valid while the window is still.
	await f.pi.tools.get('cua_left_click').execute('id', { x: 40, y: 50, frame: 1 });
	// Window moved → the pinned frame is refused.
	fake.window.rect = { x: 300, y: 20, width: 400, height: 300 };
	await assert.rejects(f.pi.tools.get('cua_left_click').execute('id', { x: 40, y: 50, frame: 1 }), /CUA STALE_STATE.*窗口已移动/);
	// Invalid or disjoint sub-region fails closed.
	fake.window.rect = { x: 10, y: 20, width: 400, height: 300 };
	await assert.rejects(f.pi.tools.get('cua_screenshot').execute('id', { window: 77, x: 900, y: 900, width: 5, height: 5 }), /CUA INVALID_ARGUMENTS.*没有交集/);
	await assert.rejects(f.pi.tools.get('cua_screenshot').execute('id', { window: 77, x: 10, y: 20, width: 0, height: 5 }), /CUA INVALID_ARGUMENTS.*大于 0/);
	await assert.rejects(f.pi.tools.get('cua_screenshot').execute('id', { window: 77, x: 10, y: 20 }), /CUA INVALID_ARGUMENTS.*同时提供/);
});

test('cua_screenshot captures a cropped sub-region of a window with exact pixels, image-space clicks and app-only scope', async () => {
	const { backend, fake } = fullFakeBackend();
	fake.screen = { x: -800, y: -400, width: 2400, height: 1400 };
	fake.window.rect = { x: 10, y: 20, width: 120, height: 80 };
	// Encode each window pixel (wx, wy) into BGRA [wx, wy, (wx + wy) & 0xff, 0xff]
	// so we can verify decoded PNG pixels against the exact cropped sub-region.
	const fullBgra = Buffer.alloc(120 * 80 * 4);
	for (let wy = 0; wy < 80; wy++) {
		for (let wx = 0; wx < 120; wx++) {
			const i = (wy * 120 + wx) * 4;
			fullBgra[i] = wx;
			fullBgra[i + 1] = wy;
			fullBgra[i + 2] = (wx + wy) & 0xff;
			fullBgra[i + 3] = 0xff;
		}
	}
	backend.captureWindow = (hwnd, region) => {
		fake.windowUsed = hwnd;
		fake.windowRegion = region;
		return { width: 120, height: 80, origin: { x: 10, y: 20 }, bgra: fullBgra };
	};
	const f = extensionFixture(backend);
	// Request extends 10px left of the window → clamped to [10, 50 40x30].
	const shot = await f.pi.tools.get('cua_screenshot').execute('id', { window: 77, x: 0, y: 50, width: 50, height: 30 });
	assert.deepEqual(fake.windowRegion, { x: 0, y: 50, width: 50, height: 30 });
	assert.equal(shot.details.window, 77);
	assert.deepEqual(shot.details.bounds, { x: 10, y: 50, width: 40, height: 30 });
	assert.equal(shot.details.width, 40);
	assert.equal(shot.details.height, 30);
	assert.match(shot.content.at(-1).text, /窗口局部.*屏幕原点 \(10, 50\).*窗口作用域 hwnd=77/);
	// Verify decoded PNG dimensions and exact corner pixels (window local x=0..39, y=30..59).
	const png = Buffer.from(shot.content[0].data, 'base64');
	assert.equal(png.readUInt32BE(16), 40);
	assert.equal(png.readUInt32BE(20), 30);
	const idatLength = png.readUInt32BE(33);
	const raw = inflateSync(png.subarray(41, 41 + idatLength));
	const rgbaAt = (px, py) => {
		const offset = py * (40 * 4 + 1) + 1 + px * 4;
		return [raw[offset], raw[offset + 1], raw[offset + 2], raw[offset + 3]];
	};
	// PNG stores RGBA: [R=(wx+wy), G=wy, B=wx, A=0xff].
	assert.deepEqual(rgbaAt(0, 0), [30, 30, 0, 0xff]);
	assert.deepEqual(rgbaAt(39, 29), [(39 + 59) & 0xff, 59, 39, 0xff]);

	// Downscaled window sub-region maps image-space clicks back to screen physical pixels
	// and still pins the full window rect for movement staleness checks.
	fake.window.rect = { x: -450, y: 160, width: 1024, height: 640 };
	backend.captureWindow = (hwnd, region) => {
		fake.windowUsed = hwnd;
		fake.windowRegion = region;
		// Simulate a native backend that pre-crops to the clamped sub-region.
		return {
			width: region.width,
			height: region.height,
			origin: { x: region.x, y: region.y },
			bgra: Buffer.alloc(region.width * region.height * 4, 0x80),
		};
	};
	const zoomed = await f.pi.tools.get('cua_screenshot').execute('id', {
		window: 77, x: -250, y: 260, width: 512, height: 320, maxWidth: 256,
	});
	assert.deepEqual(zoomed.details.bounds, { x: -250, y: 260, width: 512, height: 320 });
	assert.equal(zoomed.details.encoded.width, 256);
	assert.equal(zoomed.details.encoded.height, 160);
	const clickArgs = { frame: zoomed.details.frame, coordinateSpace: 'image', x: 50, y: 10 };
	await f.pi.tools.get('cua_left_click').execute('id', clickArgs);
	assert.deepEqual(fake.clicks.at(-1), ['left', -150, 280]);
	// Window moves → full-window rect check rejects the sub-region frame.
	fake.window.rect = { x: -400, y: 160, width: 1024, height: 640 };
	await assert.rejects(f.pi.tools.get('cua_left_click').execute('id', clickArgs), /CUA STALE_STATE.*窗口已移动/);

	// Scoped permissions: window sub-region capture stays under app scope even if desktop:screen is denied.
	const pi = fakePi();
	const scopes = { isAllowed: (key) => key === 'app:77', allow() {}, clear() {} };
	const prompts = [];
	const ctx = { hasUI: true, ui: { select: async (title) => { prompts.push(title); return '拒绝'; }, notify() {} } };
	cuaExtension({ backend, scopes })(pi.api);
	await assert.rejects(pi.tools.get('cua_screenshot').execute('id', { x: 0, y: 0, width: 10, height: 10 }, undefined, undefined, ctx), /PERMISSION_DENIED/);
	const allowedSub = await pi.tools.get('cua_screenshot').execute('id', { window: 77, x: -250, y: 260, width: 100, height: 80 }, undefined, undefined, ctx);
	assert.equal(allowedSub.details.window, 77);
	assert.deepEqual(allowedSub.details.bounds, { x: -250, y: 260, width: 100, height: 80 });
	assert.deepEqual(prompts, ['电脑控制权限 · 截取桌面整屏或指定区域']);
});

test('revoking the session clears the element observation', async () => {
	const { backend, fake } = fullFakeBackend();
	const f = extensionFixture(backend);
	await f.pi.tools.get('cua_get_state').execute('id', { hwnd: fake.window.hwnd });
	assert.ok(f.state.observation);
	await f.pi.commands.get('cua').handler('off', { ui: { notify() {} } });
	assert.equal(f.state.observation, null);
});

test('window-bound clicks activate the screenshot target and refuse overlapping windows', async () => {
	const { backend, fake } = fullFakeBackend();
	const { pi } = extensionFixture(backend);
	const shot = await pi.tools.get('cua_screenshot').execute('id', { window: fake.window.hwnd });
	const click = pi.tools.get('cua_left_click');
	const params = { x: 40, y: 50, frame: shot.details.frame };

	fake.foreground = 88;
	await click.execute('id', params);
	assert.deepEqual(fake.activations, [{ hwnd: 77, allowAltFallback: false }]);
	assert.deepEqual(fake.clicks, [['left', 40, 50]]);

	fake.hitWindow = 88;
	await assert.rejects(click.execute('id', params), /CUA TARGET_MISMATCH \(actionSent=false\).*未命中/);
	await assert.rejects(click.execute('id', { ...params, window: 88 }), /CUA INVALID_ARGUMENTS.*同一个窗口/);
	assert.equal(fake.clicks.length, 1);
	// A desktop-coordinate call with no target keeps its existing semantics.
	await click.execute('id', { x: 40, y: 50 });
	assert.equal(fake.clicks.length, 2);
});

test('window-bound element input is revalidated after activation', async () => {
	const { backend, fake } = fullFakeBackend();
	const { pi } = extensionFixture(backend);
	const observation = await pi.tools.get('cua_get_state').execute('id', { hwnd: 77 });
	fake.foreground = 88;
	const activate = backend.activateWindow;
	backend.activateWindow = async (hwnd, allowAltFallback) => {
		fake.window.rect.x += 10;
		return activate(hwnd, allowAltFallback);
	};

	await assert.rejects(
		pi.tools.get('cua_double_click').execute('id', { element: 1, observationId: observation.details.observationId }),
		/CUA STALE_STATE \(actionSent=false\).*窗口已移动/,
	);
	assert.deepEqual(fake.clicks, []);
});

test('window-bound keyboard input refuses failed activation and focus loss during paste', async () => {
	const { backend, fake } = fullFakeBackend();
	const { pi } = extensionFixture(backend);
	fake.foreground = 88;
	backend.activateWindow = async () => false;
	await assert.rejects(pi.tools.get('cua_key').execute('id', { keys: 'enter', window: 77 }), /CUA FOREGROUND_FAILED \(actionSent=false\)/);
	assert.deepEqual(fake.keys, []);

	fake.foreground = 77;
	const type = backend.typeText;
	backend.typeText = async (text, signal, beforePaste) => {
		fake.foreground = 88;
		await type(text, signal, beforePaste);
	};
	await assert.rejects(pi.tools.get('cua_type').execute('id', { text: 'hi', window: 77 }), /CUA TARGET_MISMATCH \(actionSent=false\).*不在前台/);
	assert.deepEqual(fake.pastes, []);
});

test('window-bound drag rechecks the start point before pressing the button', async () => {
	const { backend, fake } = fullFakeBackend();
	const { pi } = extensionFixture(backend);
	let pressed = false;
	backend.mouseDrag = async (_fromX, _fromY, _toX, _toY, _duration, _signal, beforePress) => {
		fake.hitWindow = 88;
		beforePress();
		pressed = true;
	};
	await assert.rejects(
		pi.tools.get('cua_drag').execute('id', { fromX: 40, fromY: 50, toX: 500, toY: 500, window: 77 }),
		/CUA TARGET_MISMATCH.*未命中/,
	);
	assert.equal(pressed, false);
});

test('scoped permissions separate applications, screen, and clipboard and distinguish once from remembered', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'pi-cua-scopes-'));
	try {
		const scopes = new CuaScopeStore(dir);
		const { backend, fake } = fullFakeBackend();
		const pi = fakePi();
		cuaExtension({ backend, scopes })(pi.api);
		const choices = ['仅本次允许', '始终允许（所有对话）', '拒绝', '拒绝'];
		const prompts = [];
		const ctx = { hasUI: true, ui: { select: async (title) => { prompts.push(title); return choices.shift(); }, notify() {} } };
		const call = (name, args) => pi.tools.get(name).execute('test', args, undefined, undefined, ctx);

		await call('cua_screenshot', { window: 77 });
		await call('cua_left_click', { window: 77, x: 40, y: 50 });
		await call('cua_left_click', { window: 77, x: 40, y: 50 });
		assert.equal(fake.clicks.length, 2);
		assert.equal(new CuaScopeStore(dir).isAllowed('app:77'), true);
		await assert.rejects(call('cua_screenshot', {}), /PERMISSION_DENIED/);
		await assert.rejects(call('cua_read_clipboard', {}), /PERMISSION_DENIED/);
		await assert.rejects(call('cua_read_clipboard', {}), /已拒绝/);
		assert.deepEqual(prompts, [
			'电脑控制权限 · 观察并控制应用 应用 77',
			'电脑控制权限 · 观察并控制应用 应用 77',
			'电脑控制权限 · 截取桌面整屏或指定区域',
			'电脑控制权限 · 读取系统剪贴板',
		]);
		await pi.commands.get('cua').handler('reset', ctx);
		assert.equal(scopes.isAllowed('app:77'), false);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scoped authorization refuses a replaced window even when its HWND is reused', async () => {
	const { backend, fake } = fullFakeBackend();
	const pi = fakePi();
	const scopes = { isAllowed: () => false, allow() {}, clear() {} };
	cuaExtension({ backend, scopes })(pi.api);
	const ctx = { hasUI: true, ui: { select: async () => {
		backend.windowApplication = () => ({ key: 'app:new', label: 'Replacement', pid: 10 });
		return '仅本次允许';
	} } };
	await assert.rejects(pi.tools.get('cua_key').execute('test', { keys: 'enter', window: 77 }, undefined, undefined, ctx), /TARGET_MISMATCH.*应用身份/);
	assert.deepEqual(fake.keys, []);
});

test('image-space input maps a scaled window frame using its native capture origin', async () => {
	const { backend, fake } = fullFakeBackend();
	const { pi } = extensionFixture(backend);
	fake.screen = { x: -800, y: -400, width: 1600, height: 1000 };
	fake.window.rect = { x: -450, y: 160, width: 512, height: 320 };
	const shot = await pi.tools.get('cua_screenshot').execute('id', { window: 77, maxWidth: 256 });
	const args = { frame: shot.details.frame, coordinateSpace: 'image', x: 50, y: 5 };
	await pi.tools.get('cua_left_click').execute('id', args);
	assert.deepEqual(fake.clicks.at(-1), ['left', -350, 170]);
	await assert.rejects(pi.tools.get('cua_left_click').execute('id', { ...args, x: 256 }), /INVALID_ARGUMENTS.*范围外/);
});

test('UIA semantic dispatch pins the observed native identity and invalidates it after delivery', async () => {
	const actions = [];
	const { backend } = fullFakeBackend({
		uiaAction: (hwnd, element, action, beforeAction) => { beforeAction(); actions.push({ hwnd, element, action }); },
	});
	const { pi } = extensionFixture(backend);
	const observation = await pi.tools.get('cua_get_state').execute('id', { hwnd: 77 });
	const params = { observationId: observation.details.observationId, element: 1 };
	assert.match(observation.content[0].text, /Invoke/);
	await pi.tools.get('cua_invoke').execute('id', params);
	assert.deepEqual(actions, [{ hwnd: 77, element: { path: [0], runtimeId: 'button-ok', view: 'control' }, action: { kind: 'invoke' } }]);
	await assert.rejects(pi.tools.get('cua_invoke').execute('id', params), /STALE_STATE/);
});

test('desktop operations in two conversations serialize and an aborted waiter sends no input', async () => {
	const { backend, fake } = fullFakeBackend();
	let start;
	let finish;
	const started = new Promise((resolve) => { start = resolve; });
	const resumed = new Promise((resolve) => { finish = resolve; });
	const methods = [];
	backend.typeText = async (_text, _signal, beforeInput, method) => {
		beforeInput();
		methods.push(method);
		start();
		await resumed;
	};
	const first = extensionFixture(backend).pi;
	const second = extensionFixture(backend).pi;
	const input = first.tools.get('cua_type').execute('first', { text: '你好' });
	await started;
	const controller = new AbortController();
	const waiting = second.tools.get('cua_key').execute('second', { keys: 'enter' }, controller.signal);
	controller.abort();
	await assert.rejects(waiting, /ABORTED/);
	const next = second.tools.get('cua_left_click').execute('next', { x: 10, y: 10 });
	assert.deepEqual(fake.clicks, []);
	finish();
	await Promise.all([input, next]);
	assert.deepEqual(methods, ['unicode']);
	assert.deepEqual(fake.clicks, [['left', 10, 10]]);
	assert.deepEqual(fake.keys, []);
});

test('clipboard paste restores on cancellation and preserves a newer copy or a rich format', async () => {
	let sequence = 1;
	let text = 'original';
	let rich = false;
	let presses = 0;
	const clipboard = {
		open: async (work) => work(),
		sequence: () => sequence,
		canReplace: () => !rich,
		read: () => text,
		write: (value) => { sequence++; text = value; },
		press: () => { presses++; },
	};
	const controller = new AbortController();
	await assert.rejects(clipboardPaste('temporary', clipboard, controller.signal, () => controller.abort()), /ABORTED/);
	assert.equal(text, 'original');
	await assert.rejects(clipboardPaste('temporary', clipboard, undefined, () => {
		setImmediate(() => clipboard.write('copied by user'));
	}), /CLIPBOARD_CHANGED/);
	assert.equal(text, 'copied by user');
	rich = true;
	const hasRichData = sequence;
	await assert.rejects(clipboardPaste('temporary', clipboard), /CLIPBOARD_FORMATS/);
	assert.equal(sequence, hasRichData, 'rich clipboard was never overwritten');
	assert.equal(presses, 0);
});

test('scoped authorization never grants control of the Pi Desktop host itself', async () => {
	const { backend, fake } = fullFakeBackend();
	const pi = fakePi();
	const prompts = [];
	const scopes = { isAllowed: () => true, allow() {}, clear() {} };
	cuaExtension({ backend, scopes, hostApplicationKey: 'app:77' })(pi.api);
	const ctx = { hasUI: true, ui: { select: async (title) => { prompts.push(title); return '始终允许（所有对话）'; } } };
	// Foreground defaults to the host window: refused even though a grant is remembered.
	await assert.rejects(pi.tools.get('cua_get_state').execute('test', {}, undefined, undefined, ctx), /PERMISSION_DENIED.*Pi Desktop 自身.*cua_list_windows/);
	await assert.rejects(pi.tools.get('cua_left_click').execute('test', { x: 40, y: 50 }, undefined, undefined, ctx), /PERMISSION_DENIED.*Pi Desktop 自身/);
	assert.deepEqual(prompts, []);
	assert.deepEqual(fake.clicks, []);
});

test('a conversation grant lasts until /cua off, is never persisted, and is not shared', async () => {
	const { backend, fake } = fullFakeBackend();
	const pi = fakePi();
	const allowed = [];
	const scopes = { isAllowed: () => false, allow: (key) => allowed.push(key), clear() {} };
	cuaExtension({ backend, scopes })(pi.api);
	const prompts = [];
	const ctx = { hasUI: true, ui: { select: async (title, options) => { prompts.push(options); return '本对话内允许'; }, notify() {} } };
	const click = () => pi.tools.get('cua_left_click').execute('test', { window: 77, x: 40, y: 50 }, undefined, undefined, ctx);
	await click();
	await click();
	assert.equal(fake.clicks.length, 2);
	assert.equal(prompts.length, 1, 'the conversation grant covers later calls');
	assert.deepEqual(prompts[0], ['本对话内允许', '仅本次允许', '始终允许（所有对话）', '拒绝']);
	assert.deepEqual(allowed, [], 'a conversation grant is not written to the shared store');

	const other = fakePi();
	cuaExtension({ backend, scopes })(other.api);
	await other.tools.get('cua_left_click').execute('test', { window: 77, x: 40, y: 50 }, undefined, undefined, ctx);
	assert.equal(prompts.length, 2, 'another conversation asks again');

	await pi.commands.get('cua').handler('off', ctx);
	await pi.commands.get('cua').handler('on', ctx);
	await click();
	assert.equal(prompts.length, 3, '/cua off revokes the conversation grant');
});

test('window-bound pointer input accepts popups owned by the target window', async () => {
	const owned = [];
	const { backend, fake } = fullFakeBackend({
		windowOwnedBy: (candidate, target) => { owned.push([candidate, target]); return candidate === 99 && target === 77; },
	});
	const { pi } = extensionFixture(backend);
	// A context menu (hwnd 99) owned by the target is under the pointer.
	fake.hitWindow = 99;
	await pi.tools.get('cua_left_click').execute('id', { window: 77, x: 40, y: 50 });
	assert.deepEqual(fake.clicks, [['left', 40, 50]]);
	// A popup that took activation does not trigger re-activation of the owner (which would close it).
	fake.foreground = 99;
	await pi.tools.get('cua_left_click').execute('id', { window: 77, x: 40, y: 50 });
	assert.deepEqual(fake.activations, []);
	assert.equal(fake.clicks.length, 2);
	// Unrelated windows are still refused, and keyboard input still needs real focus in the target.
	fake.hitWindow = 55;
	await assert.rejects(pi.tools.get('cua_left_click').execute('id', { window: 77, x: 40, y: 50 }), /TARGET_MISMATCH.*未命中/);
	await assert.rejects(pi.tools.get('cua_key').execute('id', { window: 77, keys: 'enter' }), /TARGET_MISMATCH.*键盘焦点/);
	assert.ok(owned.some(([candidate]) => candidate === 55));
});

test('cua_type falls back to Unicode only for single-line text when the clipboard holds rich content', async () => {
	const calls = [];
	const { backend } = fullFakeBackend({
		typeText: async (text, _signal, beforeInput, method) => {
			beforeInput?.();
			calls.push({ text, method });
			if (method === 'clipboard') throw new CuaError('CLIPBOARD_FORMATS', '剪贴板含图片、文件或富文本');
		},
	});
	const { pi } = extensionFixture(backend);
	const type = pi.tools.get('cua_type');
	const longLine = 'x'.repeat(200);

	const result = await type.execute('id', { window: 77, text: longLine });
	assert.deepEqual(calls.map((call) => call.method), ['clipboard', 'unicode']);
	assert.equal(result.details.method, 'unicode');
	assert.match(result.content[0].text, /Unicode 键入/);

	// Multi-line text would press Enter when typed, so it is not switched silently.
	calls.length = 0;
	await assert.rejects(type.execute('id', { window: 77, text: 'a\nb' }), /CLIPBOARD_FORMATS/);
	assert.deepEqual(calls.map((call) => call.method), ['clipboard']);
	// An explicit clipboard request is honored, not rewritten.
	calls.length = 0;
	await assert.rejects(type.execute('id', { window: 77, text: longLine, method: 'clipboard' }), /CLIPBOARD_FORMATS/);
	assert.deepEqual(calls.map((call) => call.method), ['clipboard']);
	// Explicit Unicode accepts tabs and line breaks (sent as real keys); other control characters are refused.
	calls.length = 0;
	await type.execute('id', { window: 77, text: 'a\tb\r\nc', method: 'unicode' });
	assert.deepEqual(calls, [{ text: 'a\tb\r\nc', method: 'unicode' }]);
	await assert.rejects(type.execute('id', { window: 77, text: 'a\u0007b', method: 'unicode' }), /INVALID_ARGUMENTS.*Tab 与换行/);
	await assert.rejects(type.execute('id', { window: 77, text: 'y'.repeat(1001), method: 'unicode' }), /INVALID_ARGUMENTS.*1000/);
});

test('a UIA action that has not returned is reported as delivered but pending', async () => {
	const { backend } = fullFakeBackend({
		uiaAction: async (_hwnd, _element, _action, beforeAction) => { beforeAction(); return { completed: false }; },
	});
	const { pi } = extensionFixture(backend);
	const observation = await pi.tools.get('cua_get_state').execute('id', { hwnd: 77 });
	const result = await pi.tools.get('cua_invoke').execute('id', { observationId: observation.details.observationId, element: 1 });
	assert.equal(result.details.completed, false);
	assert.match(result.content[0].text, /5 秒内没有返回.*模态窗口/);
});
