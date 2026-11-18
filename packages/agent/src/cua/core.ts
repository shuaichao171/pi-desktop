/**
 * CUA core: platform dispatch, session state and key-name parsing.
 *
 * Windows gets the full Win32 backend; other platforms fail closed with a
 * clear error (zcode placeholder-package strategy), so the tools stay visible
 * but never act. The Win32 module is imported statically (so it is bundled)
 * but only loads koffi and the DLLs on first use.
 */

import type { ElementObservation, FrameRecord, RawCapture, Rect, UiaTreeCapture, UiaView, VirtualScreen, WindowInfo, WindowOwner } from './types.ts';
import { CuaError } from './types.ts';
import * as win32 from './win32Native.ts';

export { encodeImage } from './imageEncode.ts';
export type { EncodedImage } from './imageEncode.ts';
export { CuaError } from './types.ts';
export type { CuaErrorCode, ElementObservation, FrameRecord, ObservedElement, Rect, UiaElementNode, UiaTreeCapture } from './types.ts';

export type MouseButton = 'left' | 'right' | 'middle';

export interface CuaBackend {
	readonly platform: 'win32' | 'unsupported';
	virtualScreen(): VirtualScreen;
	capture(region?: { x: number; y: number; width: number; height: number }): RawCapture;
	listWindows(): { windows: WindowInfo[]; truncated: boolean };
	activateWindow(hwnd: number, allowAltFallback?: boolean): Promise<boolean>;
	foregroundWindow(): number;
	keyboardWindow(): number;
	windowEnabled(hwnd: number): boolean;
	windowAtPoint(x: number, y: number): number;
	/** True when `candidate` is a same-process popup owned by `target` (menus, dropdowns, owned popups). */
	windowOwnedBy?(candidate: number, target: number): boolean;
	windowApplication?(hwnd: number): { key: string; label: string; pid: number };
	acquireDesktop?(signal?: AbortSignal): Promise<() => void>;
	mouseMove(x: number, y: number): void;
	mouseClick(button: MouseButton, x?: number, y?: number, doubleClick?: boolean): void;
	mouseDrag(fromX: number, fromY: number, toX: number, toY: number, durationMs?: number, signal?: AbortSignal, beforePress?: () => void, beforeMove?: (point: { x: number; y: number }) => void): Promise<void>;
	mouseScroll(clicks: number, horizontal: boolean, point?: { x: number; y: number }): void;
	tapChord(modifiers: number[], body: number): void;
	typeText(text: string, signal?: AbortSignal, beforeInput?: () => void, method?: 'unicode' | 'clipboard'): Promise<void>;
	readClipboard(): Promise<string | null>;
	writeClipboard(text: string): Promise<void>;
	cursorPosition(): { x: number; y: number };
	/** Best-effort release of every held modifier key (session end / revoke). */
	releaseModifiers?(): void;
	/** false when the interactive input desktop is inaccessible (locked screen / secure desktop). */
	inputDesktopAccessible?(): boolean;
	/** Window-scoped capture: only the target window's pixels (v2). */
	captureWindow?(hwnd: number): RawCapture;
	/** Current on-screen rectangle of a window (DWM bounds; v2). */
	windowRect?(hwnd: number): Rect;
	/** Control-view UIA accessibility tree of a window (v2, read-only). */
	uiaTree?(hwnd: number, options?: { maxNodes?: number; maxDepth?: number; view?: UiaView }): UiaTreeCapture;
	uiaAction?(hwnd: number, element: { path: number[]; runtimeId: string; view: UiaView; anchorHwnd?: number }, action: { kind: 'invoke' } | { kind: 'setValue'; value: string }, beforeAction: () => void): Promise<{ completed: boolean }> | { completed: boolean } | void;
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
	activateWindow: win32.activateWindow,
	foregroundWindow: win32.getForegroundWindow,
	keyboardWindow: win32.getKeyboardWindow,
	windowEnabled: win32.isWindowEnabled,
	windowAtPoint: win32.getWindowAtPoint,
	windowOwnedBy: win32.isWindowOwnedBy,
	windowApplication: win32.getWindowApplication,
	acquireDesktop: win32.acquireDesktop,
	mouseMove: (x, y) => win32.mouseMove(x, y),
	mouseClick: (button, x, y, doubleClick) => win32.mouseButtonClick(button, x, y, doubleClick),
	mouseDrag: win32.mouseDrag,
	mouseScroll: win32.mouseScroll,
	tapChord: (modifiers, body) => win32.tapChord(modifiers, body),
	typeText: async (text, signal, beforeInput, method) => {
		if (method !== 'unicode') return win32.pasteText(text, signal, beforeInput);
		beforeInput?.();
		win32.typeUnicode(text);
	},
	readClipboard: () => win32.readClipboardText(),
	writeClipboard: (text) => win32.writeClipboardText(text),
	cursorPosition: () => win32.getCursorPosition(),
	releaseModifiers: () => win32.releaseAllModifiers(),
	inputDesktopAccessible: () => win32.isInputDesktopAccessible(),
	captureWindow: (hwnd) => win32.captureWindow(hwnd),
	windowRect: (hwnd) => win32.windowRect(hwnd),
	uiaTree: (hwnd, options) => win32.captureUiaTree(hwnd, options),
	uiaAction: win32.performUiaAction,
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
	foregroundWindow: unsupported,
	keyboardWindow: unsupported,
	windowEnabled: unsupported,
	windowAtPoint: unsupported,
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

/** How many recent screenshot frames stay addressable by coordinate actions. */
const MAX_FRAME_RECORDS = 8;

let desktopQueue = Promise.resolve();

/** Serialize operations across Pi sessions without holding the desktop during prompts or model turns. */
export async function withCuaDesktop<T>(backend: CuaBackend, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
	const previous = desktopQueue;
	let done!: () => void;
	const current = new Promise<void>((resolve) => { done = resolve; });
	desktopQueue = previous.then(() => current);
	let release: (() => void) | undefined;
	const assertActive = () => {
		if (signal?.aborted) throw new CuaError('ABORTED', '等待桌面控制已中止');
	};
	try {
		assertActive();
		if (signal) {
			await new Promise<void>((resolve, reject) => {
				const abort = () => reject(new CuaError('ABORTED', '等待桌面控制已中止'));
				signal.addEventListener('abort', abort, { once: true });
				void previous.then(() => { signal.removeEventListener('abort', abort); resolve(); });
			});
		} else {
			await previous;
		}
		assertActive();
		release = await backend.acquireDesktop?.(signal);
		assertActive();
		return await work();
	} finally {
		try { release?.(); } finally { done(); }
	}
}

/** Per-session CUA state. The desktop host owns one instance per Pi runtime. */
export class CuaSessionState {
	enabled = false;
	/** Original-resolution bounds of the most recent screenshot (physical px). */
	lastScreenshot: { width: number; height: number; scale: number } | null = null;
	/** Most recent cua_get_state observation, for element-index addressing (v2). */
	observation: ElementObservation | null = null;
	private observationSeq = 0;
	/** Monotonic frame sequence handed out with each screenshot. */
	private frameSeq = 0;
	/** Last few screenshot frames, for coordinate-action staleness checks. */
	readonly frames = new Map<number, FrameRecord>();

	/**
	 * Record a screenshot frame and return its sequence number. Coordinate
	 * actions may pass that number back to verify the screen layout (the only
	 * cheap staleness signal: content changes are not detected, layout changes are).
	 */
	recordFrame(screen: VirtualScreen, region: FrameRecord['region'], image: FrameRecord['image'], window?: { hwnd: number; rect: Rect; owner?: WindowOwner }): number {
		const seq = ++this.frameSeq;
		this.frames.set(seq, { seq, screen, region, image, time: Date.now(), ...(window ? { windowHwnd: window.hwnd, windowRect: window.rect, windowOwner: window.owner } : {}) });
		while (this.frames.size > MAX_FRAME_RECORDS) {
			const oldest = this.frames.keys().next().value;
			if (oldest === undefined) break;
			this.frames.delete(oldest);
		}
		return seq;
	}

	resetFrames(): void {
		this.frames.clear();
	}

	resetObservation(): void {
		this.observation = null;
	}

	recordObservation(observation: Omit<ElementObservation, 'id'>): ElementObservation {
		return this.observation = { ...observation, id: ++this.observationSeq };
	}
}

export function cuaNotEnabledMessage(): string {
	return 'computer-use 未启用：首次调用会请求本对话的电脑控制授权，请等待用户确认；也可由用户运行 /cua on 手动开启。当前没有可用的授权确认界面，未执行操作。';
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
	if (!parts.length) throw new CuaError('INVALID_ARGUMENTS', '按键序列为空');
	const modifiers: number[] = [];
	const keys: number[] = [];
	for (const part of parts) {
		const vk = VK[part];
		if (vk === undefined) throw new CuaError('INVALID_ARGUMENTS', `无法识别的按键名：“${part}”（可用示例：enter、tab、esc、f5、ctrl、win、a-z、0-9、plus）`);
		if (MODIFIER_NAMES.has(part)) {
			if (!modifiers.includes(vk)) modifiers.push(vk);
		} else if (!keys.includes(vk)) {
			keys.push(vk);
		}
	}
	if (keys.length > 1) throw new CuaError('INVALID_ARGUMENTS', `组合键只能包含一个主键（收到 ${keys.length} 个）：“${spec}”；多个按键请分多次调用`);
	if (keys.length === 1) return { modifiers, key: keys[0] };
	const key = modifiers.pop()!;
	return { modifiers, key };
}
