/**
 * CUA core: platform dispatch, session state and key-name parsing.
 *
 * Windows gets the full Win32 backend; other platforms fail closed with a
 * clear error (zcode placeholder-package strategy), so the tools stay visible
 * but never act. The Win32 module is imported statically (so it is bundled)
 * but only loads koffi and the DLLs on first use.
 */

import type { RawCapture, VirtualScreen, WindowInfo } from './types.ts';
import * as win32 from './win32Native.ts';

export { encodeImage } from './imageEncode.ts';
export type { EncodedImage } from './imageEncode.ts';

export type MouseButton = 'left' | 'right' | 'middle';

export interface CuaBackend {
	readonly platform: 'win32' | 'unsupported';
	virtualScreen(): VirtualScreen;
	capture(region?: { x: number; y: number; width: number; height: number }): RawCapture;
	listWindows(): { windows: WindowInfo[]; truncated: boolean };
	activateWindow(hwnd: number): Promise<boolean>;
	mouseMove(x: number, y: number): void;
	mouseClick(button: MouseButton, x?: number, y?: number, doubleClick?: boolean): void;
	mouseDrag(fromX: number, fromY: number, toX: number, toY: number, durationMs?: number, signal?: AbortSignal): Promise<void>;
	mouseScroll(clicks: number, horizontal: boolean): void;
	tapChord(modifiers: number[], body: number): void;
	typeText(text: string, signal?: AbortSignal): Promise<void>;
	readClipboard(): Promise<string | null>;
	writeClipboard(text: string): Promise<void>;
	cursorPosition(): { x: number; y: number };
}

export const UNSUPPORTED_PLATFORM_MESSAGE = 'computer-use 尚未支持此平台（当前仅支持 Windows；macOS 需要 Accessibility 与屏幕录制权限，Linux 需要 X11/Wayland 适配）';

export function isCuaSupported(): boolean {
	return process.platform === 'win32';
}

const win32Backend: CuaBackend = {
	platform: 'win32',
	virtualScreen: () => win32.getVirtualScreen(),
	capture: (region) => win32.captureScreen(region),
	listWindows: () => win32.listWindows(),
	activateWindow: (hwnd) => win32.activateWindow(hwnd),
	mouseMove: (x, y) => win32.mouseMove(x, y),
	mouseClick: (button, x, y, doubleClick) => win32.mouseButtonClick(button, x, y, doubleClick),
	mouseDrag: (fx, fy, tx, ty, durationMs, signal) => win32.mouseDrag(fx, fy, tx, ty, durationMs, signal),
	mouseScroll: (clicks, horizontal) => win32.mouseScroll(clicks, horizontal),
	tapChord: (modifiers, body) => win32.tapChord(modifiers, body),
	typeText: (text, signal) => win32.pasteText(text, signal),
	readClipboard: () => win32.readClipboardText(),
	writeClipboard: (text) => win32.writeClipboardText(text),
	cursorPosition: () => win32.getCursorPosition(),
};

const unsupported = (): never => {
	throw new Error(UNSUPPORTED_PLATFORM_MESSAGE);
};

const unsupportedBackend: CuaBackend = {
	platform: 'unsupported',
	virtualScreen: unsupported,
	capture: unsupported,
	listWindows: unsupported,
	activateWindow: async () => unsupported(),
	mouseMove: unsupported,
	mouseClick: unsupported,
	mouseDrag: async () => unsupported(),
	mouseScroll: unsupported,
	tapChord: unsupported,
	typeText: async () => unsupported(),
	readClipboard: async () => unsupported(),
	writeClipboard: async () => unsupported(),
	cursorPosition: unsupported,
};

export function getBackend(): CuaBackend {
	return isCuaSupported() ? win32Backend : unsupportedBackend;
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

/** Per-session CUA state. The desktop host owns one instance per Pi runtime. */
export class CuaSessionState {
	enabled = false;
	/** Original-resolution bounds of the most recent screenshot (physical px). */
	lastScreenshot: { width: number; height: number; scale: number } | null = null;
}

export function cuaNotEnabledMessage(): string {
	return 'computer-use 未启用：请先运行 /cua on 开启本会话的电脑控制（开启后点击/输入等操作将直接作用于你的桌面，请确认环境安全）';
}

// ---------------------------------------------------------------------------
// Key names → Virtual-Key codes
// ---------------------------------------------------------------------------

const VK: Record<string, number> = {
	backspace: 0x08, tab: 0x09, enter: 0x0d, return: 0x0d, esc: 0x1b, escape: 0x1b,
	space: 0x20, pageup: 0x21, pgup: 0x21, pagedown: 0x22, pgdn: 0x22, end: 0x23, home: 0x24,
	left: 0x25, up: 0x26, right: 0x27, down: 0x28,
	insert: 0x2d, ins: 0x2d, delete: 0x2e, del: 0x2e,
	printscreen: 0x2c, capslock: 0x14, numlock: 0x90, scrolllock: 0x91,
	pause: 0x13,
	lwin: 0x5b, win: 0x5b, super: 0x5b, meta: 0x5b, rwin: 0x5c, apps: 0x5d, menu: 0x5d,
	shift: 0x10, ctrl: 0x11, control: 0x11, alt: 0x12,
	plus: 0xbb, '=': 0xbb, ',': 0xbc, comma: 0xbc, '-': 0xbd, minus: 0xbd, '.': 0xbe, period: 0xbe,
	'/': 0xbf, '`': 0xc0, ';': 0xba, '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde,
};

for (let n = 1; n <= 24; n++) VK[`f${n}`] = 0x6f + n; // F1 = 0x70 … F24 = 0x87
for (let code = 0x30; code <= 0x39; code++) VK[String.fromCharCode(code)] = code; // 0-9
// parseKeys lowercases its input, so letters are registered lowercase (VK codes are the uppercase ASCII).
for (let code = 0x41; code <= 0x5a; code++) VK[String.fromCharCode(code).toLowerCase()] = code;

const MODIFIER_NAMES = new Set(['shift', 'ctrl', 'control', 'alt', 'win', 'lwin', 'rwin', 'super', 'meta']);

export interface ParsedKeys {
	modifiers: number[];
	key: number;
}

/**
 * Parse strings like "ctrl+shift+t", "enter" or "win" into VK codes.
 * A chord has exactly one non-modifier key; a bare modifier chord such as
 * "ctrl+shift" taps the last modifier while holding the others. Use "plus"
 * for the + key since + separates the parts.
 */
export function parseKeys(spec: string): ParsedKeys {
	const parts = spec.split('+').map((part) => part.trim().toLowerCase()).filter(Boolean);
	if (!parts.length) throw new Error('按键序列为空');
	const modifiers: number[] = [];
	const keys: number[] = [];
	for (const part of parts) {
		const vk = VK[part];
		if (vk === undefined) throw new Error(`无法识别的按键名：“${part}”（可用示例：enter、tab、esc、f5、ctrl、win、a-z、0-9、plus）`);
		if (MODIFIER_NAMES.has(part)) {
			if (!modifiers.includes(vk)) modifiers.push(vk);
		} else if (!keys.includes(vk)) {
			keys.push(vk);
		}
	}
	if (keys.length > 1) throw new Error(`组合键只能包含一个主键（收到 ${keys.length} 个）：“${spec}”；多个按键请分多次调用`);
	if (keys.length === 1) return { modifiers, key: keys[0] };
	const key = modifiers.pop()!;
	return { modifiers, key };
}
