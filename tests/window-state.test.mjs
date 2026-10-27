import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { registerHooks } from 'node:module';

// The module reads placement through Electron's screen; stub the import.
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === 'electron') {
			const source = 'export const screen = { getAllDisplays: () => [], getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) };';
			return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
		}
		if (specifier.startsWith('./') && context.parentURL?.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
		return nextResolve(specifier, context);
	},
});

const {
	clampWindowBounds,
	defaultWindowState,
	isValidWindowState,
	isVisibleOnDisplays,
	readWindowState,
	resolveStartupWindowState,
	trackWindowState,
	windowStateFromWindow,
	windowStatePath,
	writeWindowState,
} = await import('../packages/desktop/src/main/windowState.ts');

const primaryWorkArea = { x: 0, y: 0, width: 1920, height: 1040 };
const secondaryDisplay = { x: 1920, y: 0, width: 1280, height: 720 };
const displays = [primaryWorkArea, secondaryDisplay];

function tempRoot(name) {
	return mkdtempSync(join(realpathSync.native(tmpdir()), `pi-desktop-window-state-${name}-`));
}

function fakeWindow(bounds, { maximized = false } = {}) {
	const listeners = new Map();
	return {
		bounds: { ...bounds },
		maximized,
		isDestroyed: () => false,
		getNormalBounds() { return { ...this.bounds }; },
		isMaximized() { return this.maximized; },
		on(event, listener) {
			if (!listeners.has(event)) listeners.set(event, []);
			listeners.get(event).push(listener);
		},
		emit(event) {
			for (const listener of listeners.get(event) ?? []) listener();
		},
	};
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('window state round-trips and damaged files fall back to no placement', () => {
	const root = tempRoot('io');
	try {
		const path = windowStatePath(root);
		assert.equal(path, join(root, 'window-state.json'));
		assert.equal(readWindowState(path), null, 'a missing file means no saved placement');

		const state = { bounds: { x: 140, y: 88, width: 1500, height: 900 }, maximized: false };
		writeWindowState(path, state);
		assert.deepEqual(readWindowState(path), state, 'the placement round-trips');

		assert.equal(isValidWindowState(null), false);
		assert.equal(isValidWindowState({ bounds: { x: 0, y: 0, width: 1280, height: 820 } }), false, 'maximized flag required');
		assert.equal(isValidWindowState({ bounds: { x: 'left', y: 0, width: 1280, height: 820 }, maximized: false }), false);
		assert.equal(isValidWindowState({ bounds: { x: 0, y: 0, width: Number.NaN, height: 820 }, maximized: false }), false, 'finite numbers only');

		writeFileSync(path, '{ not json', 'utf8');
		assert.equal(readWindowState(path), null, 'a corrupt file falls back without throwing');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('a saved placement only survives while enough of it is on a display', () => {
	assert.equal(isVisibleOnDisplays({ x: 100, y: 100, width: 1280, height: 820 }, [{ x: 0, y: 0, width: 1920, height: 1080 }]), true);
	assert.equal(isVisibleOnDisplays({ x: 2000, y: 100, width: 1280, height: 820 }, displays), true, 'a window on the second display is fine');
	assert.equal(isVisibleOnDisplays({ x: -4000, y: 500, width: 1280, height: 820 }, displays), false, 'a disconnected monitor is rejected');
	assert.equal(isVisibleOnDisplays({ x: 1900, y: 100, width: 1280, height: 820 }, [{ x: 0, y: 0, width: 1920, height: 1080 }]), false, 'a sliver of the window is not enough to grab');
	assert.equal(isVisibleOnDisplays({ x: 1800, y: 100, width: 1280, height: 820 }, [{ x: 0, y: 0, width: 1920, height: 1080 }]), true, 'a visible strip of the title bar keeps the placement');
});

test('startup resolves the saved placement, else a centered default', () => {
	const root = tempRoot('resolve');
	try {
		const path = windowStatePath(root);
		const fallback = defaultWindowState(primaryWorkArea);
		assert.deepEqual(fallback.bounds, { x: 320, y: 110, width: 1280, height: 820 }, 'centered 1280×820 on the primary work area');
		assert.deepEqual(resolveStartupWindowState(path, { primaryWorkArea }), fallback, 'first launch centers');

		const saved = { bounds: { x: 2100, y: 40, width: 1000, height: 700 }, maximized: true };
		writeWindowState(path, saved);
		assert.deepEqual(resolveStartupWindowState(path, { displays, primaryWorkArea }), saved, 'a placement on the second display is restored maximized');

		const offScreen = { bounds: { x: -5000, y: 500, width: 1000, height: 700 }, maximized: false };
		writeWindowState(path, offScreen);
		assert.deepEqual(resolveStartupWindowState(path, { displays, primaryWorkArea }), fallback, 'an unreachable placement recenters');

		writeWindowState(path, { bounds: { x: 12.6, y: -7.2, width: 640.4, height: 300.9 }, maximized: false });
		assert.deepEqual(
			resolveStartupWindowState(path, { displays, primaryWorkArea }),
			{ bounds: { x: 13, y: -7, width: 680, height: 520 }, maximized: false },
			'fractional and undersized bounds are rounded and clamped to the minimums',
		);

		// Garbage oversized bounds (e.g. a tool writing 0xCCCC-sized windows)
		// stay on screen but never exceed the virtual desktop.
		writeWindowState(path, { bounds: { x: 100, y: 100, width: 52000, height: 52421 }, maximized: false });
		assert.deepEqual(
			resolveStartupWindowState(path, { displays, primaryWorkArea }),
			{ bounds: { x: 100, y: 100, width: 3200, height: 1040 }, maximized: false },
			'oversized bounds are capped to the virtual desktop (1920+1280 wide, 1040 tall)',
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('capturing a window keeps the restored bounds while maximized', () => {
	const normal = fakeWindow({ x: 2100, y: 60, width: 1100, height: 750 });
	assert.deepEqual(windowStateFromWindow(normal), { bounds: { x: 2100, y: 60, width: 1100, height: 750 }, maximized: false });

	const maximized = fakeWindow({ x: 2100, y: 60, width: 1100, height: 750 }, { maximized: true });
	assert.deepEqual(windowStateFromWindow(maximized), { bounds: { x: 2100, y: 60, width: 1100, height: 750 }, maximized: true });
	assert.deepEqual(clampWindowBounds({ x: 10.2, y: 20.7, width: 100.4, height: 90.6 }), { x: 10, y: 21, width: 680, height: 520 });
});

test('the tracker persists moves debounced and once more on close', async () => {
	const root = tempRoot('track');
	try {
		const path = windowStatePath(root);
		const win = fakeWindow({ x: 100, y: 100, width: 1280, height: 820 });
		trackWindowState(win, path);

		win.emit('move');
		win.bounds.x = 160;
		win.emit('move');
		win.bounds.x = 220;
		win.emit('move');
		await delay(120);
		assert.equal(readWindowState(path), null, 'bursty drag events coalesce into one write');

		await delay(500);
		assert.deepEqual(readWindowState(path), { bounds: { x: 220, y: 100, width: 1280, height: 820 }, maximized: false }, 'the last placement wins');

		win.bounds = { x: 300, y: 240, width: 1400, height: 860 };
		win.maximized = true;
		win.emit('close');
		assert.deepEqual(
			readWindowState(path),
			{ bounds: { x: 300, y: 240, width: 1400, height: 860 }, maximized: true },
			'closing writes immediately, including the tray hide on Windows',
		);
		assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), readWindowState(path));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
