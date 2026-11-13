// desktop-cua (computer-use): key-name parsing, coordinate/region math, image
// encoding, the session gate around the tools, and a read-only native smoke
// test on Windows. Nothing here injects mouse/keyboard input.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { CuaSessionState, getBackend, isCuaSupported, parseKeys } from '../packages/agent/src/cua/core.ts';
import { downscaleBgra, encodeImage } from '../packages/agent/src/cua/imageEncode.ts';
import { clampRegion, toAbsolute } from '../packages/agent/src/cua/win32Native.ts';
import { cuaExtension } from '../packages/agent/src/cua/extension.ts';

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
		'cua_activate_window', 'cua_double_click', 'cua_drag', 'cua_key', 'cua_left_click', 'cua_list_windows', 'cua_mouse_move',
		'cua_read_clipboard', 'cua_right_click', 'cua_screenshot', 'cua_scroll', 'cua_type', 'cua_wait', 'cua_write_clipboard',
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
});
