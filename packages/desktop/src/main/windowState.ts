import { screen } from 'electron';
import { join } from 'node:path';
import { readStateFile, writeStateFile } from './stateFiles';

/**
 * Placement persistence for the main window. The boot window and the main
 * window open at the same saved bounds so the startup swap reads as one
 * window staying in place, and a window the user dragged or resized during a
 * previous session reappears exactly there (fixes the centered-boot-window to
 * OS-default-main-window jump).
 */
export interface WindowBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** The main window's placement: normal (restored) bounds plus the maximize flag. */
export interface WindowState {
	bounds: WindowBounds;
	maximized: boolean;
}

/** A display rectangle in DIPs; Electron's workArea satisfies this shape. */
export interface DisplayArea {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Kept in sync with the main window's BrowserWindow options in index.ts. */
export const MAIN_WINDOW_MIN_WIDTH = 680;
export const MAIN_WINDOW_MIN_HEIGHT = 520;

const DEFAULT_WINDOW_WIDTH = 1280;
const DEFAULT_WINDOW_HEIGHT = 820;
/** Enough of the window must stay on a display to see and drag it back. */
const MIN_VISIBLE_WIDTH = 120;
const MIN_VISIBLE_HEIGHT = 40;
/** Windows fires 'move'/'resize' continuously while dragging; coalesce writes. */
const SAVE_DEBOUNCE_MS = 500;

export function windowStatePath(userData: string): string {
	return join(userData, 'window-state.json');
}

export function isValidWindowState(value: unknown): value is WindowState {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Partial<WindowState>;
	const bounds = candidate.bounds as Partial<WindowBounds> | undefined;
	if (typeof bounds !== 'object' || bounds === null) return false;
	return [bounds.x, bounds.y, bounds.width, bounds.height].every((part) => typeof part === 'number' && Number.isFinite(part))
		&& typeof candidate.maximized === 'boolean';
}

/** Round coordinates and keep the restored window within the minimum sizes. */
export function clampWindowBounds(bounds: WindowBounds): WindowBounds {
	return {
		x: Math.round(bounds.x),
		y: Math.round(bounds.y),
		width: Math.max(MAIN_WINDOW_MIN_WIDTH, Math.round(bounds.width)),
		height: Math.max(MAIN_WINDOW_MIN_HEIGHT, Math.round(bounds.height)),
	};
}

/** Missing means first launch; damaged files are cosmetic and fall back to defaults. */
export function readWindowState(path: string): WindowState | null {
	try {
		return readStateFile(path, () => null, isValidWindowState);
	} catch {
		// Keep the unreadable bytes untouched until the next save replaces them.
		return null;
	}
}

export function writeWindowState(path: string, state: WindowState): void {
	writeStateFile(path, state);
}

/**
 * True when enough of the window is on a connected display to see and drag
 * it. Rejects placements from a monitor that is no longer attached.
 */
export function isVisibleOnDisplays(bounds: WindowBounds, displays: readonly DisplayArea[]): boolean {
	return displays.some((display) => {
		const overlapWidth = Math.min(bounds.x + bounds.width, display.x + display.width) - Math.max(bounds.x, display.x);
		const overlapHeight = Math.min(bounds.y + bounds.height, display.y + display.height) - Math.max(bounds.y, display.y);
		return overlapWidth >= MIN_VISIBLE_WIDTH && overlapHeight >= MIN_VISIBLE_HEIGHT;
	});
}

/** Centered fallback used until the user moves or resizes the window. */
export function defaultWindowState(workArea: DisplayArea): WindowState {
	return {
		bounds: clampWindowBounds({
			x: workArea.x + Math.floor((workArea.width - DEFAULT_WINDOW_WIDTH) / 2),
			y: workArea.y + Math.floor((workArea.height - DEFAULT_WINDOW_HEIGHT) / 2),
			width: DEFAULT_WINDOW_WIDTH,
			height: DEFAULT_WINDOW_HEIGHT,
		}),
		maximized: false,
	};
}

/**
 * The placement the boot window and the main window should both use this
 * launch: the saved placement when it is still visible, a centered default
 * otherwise. The displays are injectable for tests.
 */
export function resolveStartupWindowState(
	path: string,
	environment?: { displays?: readonly DisplayArea[]; primaryWorkArea?: DisplayArea },
): WindowState {
	const saved = readWindowState(path);
	const displays = environment?.displays ?? screen.getAllDisplays().map((display) => display.workArea);
	if (saved && isVisibleOnDisplays(saved.bounds, displays)) {
		// A window larger than the whole virtual desktop is damaged data (for
		// example a tool writing garbage bounds), never a placement to restore.
		const maxWidth = Math.max(...displays.map((display) => display.x + display.width)) - Math.min(...displays.map((display) => display.x));
		const maxHeight = Math.max(...displays.map((display) => display.y + display.height)) - Math.min(...displays.map((display) => display.y));
		const clamped = clampWindowBounds(saved.bounds);
		return {
			bounds: {
				...clamped,
				width: Math.min(clamped.width, maxWidth),
				height: Math.min(clamped.height, maxHeight),
			},
			maximized: saved.maximized,
		};
	}
	return defaultWindowState(environment?.primaryWorkArea ?? screen.getPrimaryDisplay().workArea);
}

/** Structural slice of BrowserWindow so tests can drive the tracker with a fake. */
export interface TrackedWindow {
	on(event: 'resize' | 'move' | 'close' | 'closed', listener: () => void): unknown;
	isDestroyed(): boolean;
	getNormalBounds(): WindowBounds;
	isMaximized(): boolean;
}

/**
 * Snapshot a live window's placement. getNormalBounds() reports the restored
 * bounds even while maximized, so a maximized window still remembers the size
 * it unmaximizes to.
 */
export function windowStateFromWindow(win: Pick<TrackedWindow, 'getNormalBounds' | 'isMaximized'>): WindowState {
	return { bounds: clampWindowBounds(win.getNormalBounds()), maximized: win.isMaximized() };
}

/**
 * Persist the window's placement: debounced during interactive move/resize,
 * then once more when the window closes — including the Windows tray hide,
 * which keeps the window alive with its final bounds.
 */
export function trackWindowState(win: TrackedWindow, path: string): void {
	let timer: ReturnType<typeof setTimeout> | null = null;
	const save = (): void => {
		if (win.isDestroyed()) return;
		try {
			writeWindowState(path, windowStateFromWindow(win));
		} catch (error) {
			console.error('Failed to save window placement:', error);
		}
	};
	const schedule = (): void => {
		if (win.isDestroyed()) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(save, SAVE_DEBOUNCE_MS);
	};
	win.on('resize', schedule);
	win.on('move', schedule);
	win.on('close', () => {
		if (timer) clearTimeout(timer);
		timer = null;
		save();
	});
	win.on('closed', () => {
		if (timer) clearTimeout(timer);
		timer = null;
	});
}
