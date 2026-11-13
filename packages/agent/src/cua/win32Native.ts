/**
 * Win32 native layer for computer-use, loaded through koffi (N-API FFI).
 *
 * Covers the four capability groups needed by the CUA tools:
 *   - screen capture (GDI BitBlt, virtual desktop, region crop)
 *   - mouse + keyboard injection (SendInput)
 *   - window enumeration / activation (EnumWindows, SetForegroundWindow)
 *   - clipboard text I/O (CF_UNICODETEXT) with best-effort save/restore
 *
 * koffi and the DLL bindings load lazily on first use: importing this module
 * never touches native code, so a missing/broken koffi only fails the CUA
 * tools instead of the whole agent host, and non-Windows hosts can import it.
 *
 * Koffi conventions used here: structs/unions are plain JS objects, output
 * parameters are declared `_Out_`/`_Inout_` and filled back into the passed
 * object/array, Buffers are passed by pointer and written in place.
 *
 * All coordinates are physical pixels in the Windows virtual-screen space
 * (SM_X/YVIRTUALSCREEN origin). The calling thread is switched to
 * per-monitor-v2 DPI awareness at load so GetSystemMetrics, GDI capture,
 * window rects and SendInput absolute coordinates all agree.
 */

import { createRequire } from 'node:module';
import type * as Koffi from 'koffi';
import type { RawCapture, VirtualScreen, WindowInfo } from './types.ts';

const nodeRequire = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;

const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0040;
const MOUSEEVENTF_MIDDLEUP = 0x0080;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_HWHEEL = 0x1000;
const MOUSEEVENTF_VIRTUALDESK = 0x4000;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const ABSOLUTE_MOVE = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
const WHEEL_DELTA = 120;

const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const MAPVK_VK_TO_VSC = 0;
/** Keys that live on the extended (E0-prefixed) part of the keyboard. */
const EXTENDED_VKS = new Set([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2c, 0x2d, 0x2e, 0x5b, 0x5c, 0x5d, 0x6f, 0x90, 0xa3, 0xa5]);

const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;

const SRCCOPY = 0x00cc0020;
const CAPTUREBLT = 0x40000000;
const BI_RGB = 0;
const DIB_RGB_COLORS = 0;

const CF_UNICODETEXT = 13;
const GMEM_MOVEABLE = 0x0002;

const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_NOACTIVATE = 0x08000000;
const SW_RESTORE = 9;
const DWMWA_CLOAKED = 14;
const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4;

const VK_CONTROL = 0x11;
const VK_V = 0x56;

// ---------------------------------------------------------------------------
// Lazy bindings
// ---------------------------------------------------------------------------

type KoffiModule = typeof Koffi;
type Bindings = ReturnType<typeof loadBindings>;

let bindings: Bindings | null = null;

function api(): Bindings {
	if (process.platform !== 'win32') throw new Error('Win32 backend is only available on Windows');
	bindings ??= loadBindings();
	return bindings;
}

function loadBindings() {
	let koffi: KoffiModule;
	try {
		koffi = nodeRequire('koffi') as KoffiModule;
	} catch (error) {
		throw new Error(`computer-use 原生模块 koffi 加载失败：${error instanceof Error ? error.message : String(error)}`);
	}
	const user32 = koffi.load('user32.dll');
	const gdi32 = koffi.load('gdi32.dll');
	const kernel32 = koffi.load('kernel32.dll');
	const dwmapi = koffi.load('dwmapi.dll');

	koffi.struct('CUA_MOUSEINPUT', {
		dx: 'int32_t',
		dy: 'int32_t',
		mouseData: 'int32_t', // DWORD in the SDK; signed here so negative wheel deltas marshal
		dwFlags: 'uint32_t',
		time: 'uint32_t',
		dwExtraInfo: 'uintptr_t',
	});
	koffi.struct('CUA_KEYBDINPUT', {
		wVk: 'uint16_t',
		wScan: 'uint16_t',
		dwFlags: 'uint32_t',
		time: 'uint32_t',
		dwExtraInfo: 'uintptr_t',
	});
	koffi.union('CUA_INPUT_UNION', { mi: 'CUA_MOUSEINPUT', ki: 'CUA_KEYBDINPUT' });
	const INPUT = koffi.struct('CUA_INPUT', { type: 'uint32_t', u: 'CUA_INPUT_UNION' });
	const inputSize = koffi.sizeof(INPUT);
	// x64 INPUT is 40 bytes (4 + 4 alignment padding + 32-byte union); SendInput rejects any other cbSize.
	if (inputSize !== (process.arch === 'ia32' ? 28 : 40)) throw new Error(`INPUT 结构体大小异常：${inputSize}`);

	koffi.struct('CUA_RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
	koffi.struct('CUA_POINT', { x: 'int32_t', y: 'int32_t' });
	const BITMAPINFOHEADER = koffi.struct('CUA_BITMAPINFOHEADER', {
		biSize: 'uint32_t',
		biWidth: 'int32_t',
		biHeight: 'int32_t',
		biPlanes: 'uint16_t',
		biBitCount: 'uint16_t',
		biCompression: 'uint32_t',
		biSizeImage: 'uint32_t',
		biXPelsPerMeter: 'int32_t',
		biYPelsPerMeter: 'int32_t',
		biClrUsed: 'uint32_t',
		biClrImportant: 'uint32_t',
	});
	koffi.struct('CUA_BITMAPINFO', { bmiHeader: 'CUA_BITMAPINFOHEADER', bmiColors: koffi.array('uint32_t', 1) });
	koffi.proto('bool __stdcall CUA_EnumWindowsProc(intptr_t hwnd, intptr_t lparam)');

	const b = {
		koffi,
		inputSize,
		bitmapInfoHeaderSize: koffi.sizeof(BITMAPINFOHEADER),
		SendInput: user32.func('uint32_t __stdcall SendInput(uint32_t cInputs, CUA_INPUT *pInputs, int cbSize)'),
		MapVirtualKeyW: user32.func('uint32_t __stdcall MapVirtualKeyW(uint32_t uCode, uint32_t uMapType)'),
		GetSystemMetrics: user32.func('int __stdcall GetSystemMetrics(int nIndex)'),
		GetCursorPos: user32.func('bool __stdcall GetCursorPos(_Out_ CUA_POINT *lpPoint)'),

		GetDC: user32.func('intptr_t __stdcall GetDC(intptr_t hWnd)'),
		ReleaseDC: user32.func('int __stdcall ReleaseDC(intptr_t hWnd, intptr_t hDC)'),
		CreateCompatibleDC: gdi32.func('intptr_t __stdcall CreateCompatibleDC(intptr_t hdc)'),
		DeleteDC: gdi32.func('bool __stdcall DeleteDC(intptr_t hdc)'),
		CreateCompatibleBitmap: gdi32.func('intptr_t __stdcall CreateCompatibleBitmap(intptr_t hdc, int cx, int cy)'),
		DeleteObject: gdi32.func('bool __stdcall DeleteObject(intptr_t hObject)'),
		SelectObject: gdi32.func('intptr_t __stdcall SelectObject(intptr_t hdc, intptr_t h)'),
		BitBlt: gdi32.func('bool __stdcall BitBlt(intptr_t hdcDest, int x, int y, int cx, int cy, intptr_t hdcSrc, int x1, int y1, uint32_t rop)'),
		GetDIBits: gdi32.func('int __stdcall GetDIBits(intptr_t hdc, intptr_t hbm, uint32_t start, uint32_t cLines, _Out_ uint8_t *lpvBits, _Inout_ CUA_BITMAPINFO *lpbi, uint32_t usage)'),

		EnumWindows: user32.func('bool __stdcall EnumWindows(CUA_EnumWindowsProc *lpEnumFunc, intptr_t lParam)'),
		IsWindow: user32.func('bool __stdcall IsWindow(intptr_t hWnd)'),
		IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr_t hWnd)'),
		GetWindowLongW: user32.func('int32_t __stdcall GetWindowLongW(intptr_t hWnd, int nIndex)'),
		GetWindowTextW: user32.func('int __stdcall GetWindowTextW(intptr_t hWnd, _Out_ uint16_t *lpString, int nMaxCount)'),
		GetWindowRect: user32.func('bool __stdcall GetWindowRect(intptr_t hWnd, _Out_ CUA_RECT *lpRect)'),
		GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32_t *lpdwProcessId)'),
		IsIconic: user32.func('bool __stdcall IsIconic(intptr_t hWnd)'),
		ShowWindow: user32.func('bool __stdcall ShowWindow(intptr_t hWnd, int nCmdShow)'),
		SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(intptr_t hWnd)'),
		GetForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()'),
		DwmGetWindowAttribute: dwmapi.func('int32_t __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32_t dwAttribute, _Out_ uint32_t *pvAttribute, uint32_t cbAttribute)'),

		OpenClipboard: user32.func('bool __stdcall OpenClipboard(intptr_t hWndNewOwner)'),
		CloseClipboard: user32.func('bool __stdcall CloseClipboard()'),
		EmptyClipboard: user32.func('bool __stdcall EmptyClipboard()'),
		IsClipboardFormatAvailable: user32.func('bool __stdcall IsClipboardFormatAvailable(uint32_t format)'),
		GetClipboardData: user32.func('intptr_t __stdcall GetClipboardData(uint32_t format)'),
		SetClipboardData: user32.func('intptr_t __stdcall SetClipboardData(uint32_t format, intptr_t hMem)'),

		GlobalAlloc: kernel32.func('intptr_t __stdcall GlobalAlloc(uint32_t uFlags, uintptr_t dwBytes)'),
		GlobalFree: kernel32.func('intptr_t __stdcall GlobalFree(intptr_t hMem)'),
		GlobalLock: kernel32.func('void * __stdcall GlobalLock(intptr_t hMem)'),
		GlobalUnlock: kernel32.func('bool __stdcall GlobalUnlock(intptr_t hMem)'),
		GlobalSize: kernel32.func('uintptr_t __stdcall GlobalSize(intptr_t hMem)'),
		RtlMoveMemory: kernel32.func('void __stdcall RtlMoveMemory(void *dest, void *src, uintptr_t length)'),
	};

	// Per-monitor-v2 awareness for this thread (Win10 1607+). Electron hosts are
	// usually aware already; plain Node is not, and would see scaled coordinates.
	try {
		const SetThreadDpiAwarenessContext = user32.func('intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t dpiContext)');
		SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
	} catch {
		/* older Windows: keep the process default */
	}
	return b;
}

/** Koffi returns pointer-sized integers as number when safe, bigint otherwise. */
function handleToNumber(value: unknown): number {
	return typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
}

// ---------------------------------------------------------------------------
// Virtual screen geometry
// ---------------------------------------------------------------------------

export function getVirtualScreen(): VirtualScreen {
	const { GetSystemMetrics } = api();
	return {
		x: GetSystemMetrics(SM_XVIRTUALSCREEN),
		y: GetSystemMetrics(SM_YVIRTUALSCREEN),
		width: GetSystemMetrics(SM_CXVIRTUALSCREEN),
		height: GetSystemMetrics(SM_CYVIRTUALSCREEN),
	};
}

export function getCursorPosition(): { x: number; y: number } {
	const point = { x: 0, y: 0 };
	if (!api().GetCursorPos(point)) throw new Error('GetCursorPos 失败');
	return { x: point.x, y: point.y };
}

// ---------------------------------------------------------------------------
// Input injection
// ---------------------------------------------------------------------------

interface InputEvent {
	type: number;
	u: { mi: { dx: number; dy: number; mouseData: number; dwFlags: number; time: number; dwExtraInfo: number } } | { ki: { wVk: number; wScan: number; dwFlags: number; time: number; dwExtraInfo: number } };
}

function mouseInput(flags: number, dx = 0, dy = 0, mouseData = 0): InputEvent {
	return { type: INPUT_MOUSE, u: { mi: { dx, dy, mouseData, dwFlags: flags, time: 0, dwExtraInfo: 0 } } };
}

function keyInput(vk: number, up: boolean): InputEvent {
	const scan = api().MapVirtualKeyW(vk, MAPVK_VK_TO_VSC) & 0xffff;
	const flags = (up ? KEYEVENTF_KEYUP : 0) | (EXTENDED_VKS.has(vk) ? KEYEVENTF_EXTENDEDKEY : 0);
	return { type: INPUT_KEYBOARD, u: { ki: { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } };
}

/** Inject a batch atomically (SendInput serializes the whole array against other input). */
function send(events: InputEvent[]): void {
	if (!events.length) return;
	const { SendInput, inputSize } = api();
	const inserted = SendInput(events.length, events, inputSize);
	if (inserted !== events.length) {
		throw new Error(`SendInput 注入失败（${inserted}/${events.length}）：输入可能被 UIPI 拦截（目标窗口以管理员权限运行）或被安全软件阻止`);
	}
}

/** Clamp inside the virtual desktop and normalize to SendInput 0..65535 space. */
export function toAbsolute(x: number, y: number, screen: VirtualScreen): { dx: number; dy: number } {
	const cx = Math.min(Math.max(x, screen.x), screen.x + screen.width - 1);
	const cy = Math.min(Math.max(y, screen.y), screen.y + screen.height - 1);
	const dx = Math.round(((cx - screen.x) * 65535) / Math.max(screen.width - 1, 1));
	const dy = Math.round(((cy - screen.y) * 65535) / Math.max(screen.height - 1, 1));
	return { dx: Math.min(Math.max(dx, 0), 65535), dy: Math.min(Math.max(dy, 0), 65535) };
}

export type MouseButton = 'left' | 'right' | 'middle';

const BUTTON_FLAGS: Record<MouseButton, { down: number; up: number }> = {
	left: { down: MOUSEEVENTF_LEFTDOWN, up: MOUSEEVENTF_LEFTUP },
	right: { down: MOUSEEVENTF_RIGHTDOWN, up: MOUSEEVENTF_RIGHTUP },
	middle: { down: MOUSEEVENTF_MIDDLEDOWN, up: MOUSEEVENTF_MIDDLEUP },
};

export function mouseMove(x: number, y: number): void {
	const { dx, dy } = toAbsolute(x, y, getVirtualScreen());
	send([mouseInput(ABSOLUTE_MOVE, dx, dy)]);
}

export function mouseButtonClick(button: MouseButton, x?: number, y?: number, doubleClick = false): void {
	const flags = BUTTON_FLAGS[button];
	const events: InputEvent[] = [];
	if (x !== undefined && y !== undefined) {
		const { dx, dy } = toAbsolute(x, y, getVirtualScreen());
		events.push(mouseInput(ABSOLUTE_MOVE, dx, dy));
	}
	const clicks = doubleClick ? 2 : 1;
	for (let i = 0; i < clicks; i++) events.push(mouseInput(flags.down), mouseInput(flags.up));
	send(events);
}

export function mouseDown(button: MouseButton): void {
	send([mouseInput(BUTTON_FLAGS[button].down)]);
}

export function mouseUp(button: MouseButton): void {
	send([mouseInput(BUTTON_FLAGS[button].up)]);
}

/** Press at the start point, ease toward the target, always release the button. */
export async function mouseDrag(fromX: number, fromY: number, toX: number, toY: number, durationMs = 350, signal?: AbortSignal): Promise<void> {
	const screen = getVirtualScreen();
	const start = toAbsolute(fromX, fromY, screen);
	const target = toAbsolute(toX, toY, screen);
	send([mouseInput(ABSOLUTE_MOVE, start.dx, start.dy)]);
	await delay(60, signal);
	send([mouseInput(MOUSEEVENTF_LEFTDOWN)]);
	try {
		const duration = Math.min(Math.max(durationMs, 50), 5000);
		const steps = Math.max(2, Math.min(60, Math.round(duration / 16)));
		const stepDelay = Math.max(1, Math.round(duration / steps));
		for (let i = 1; i <= steps; i++) {
			const t = i / steps;
			const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
			send([mouseInput(ABSOLUTE_MOVE, Math.round(start.dx + (target.dx - start.dx) * eased), Math.round(start.dy + (target.dy - start.dy) * eased))]);
			await delay(stepDelay, signal);
		}
	} finally {
		send([mouseInput(MOUSEEVENTF_LEFTUP)]);
	}
}

export function mouseScroll(amountClicks: number, horizontal = false): void {
	const data = Math.round(amountClicks) * WHEEL_DELTA;
	if (data === 0) return;
	// Vertical wheel: positive mouseData scrolls up, so "positive = down" negates.
	// Horizontal wheel: positive mouseData already scrolls right.
	send([mouseInput(horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL, 0, 0, horizontal ? data : -data)]);
}

/** Hold modifiers down, tap the chord body, then release modifiers in reverse — one atomic batch. */
export function tapChord(modifierVks: number[], bodyVk: number): void {
	const events: InputEvent[] = [];
	for (const vk of modifierVks) events.push(keyInput(vk, false));
	events.push(keyInput(bodyVk, false), keyInput(bodyVk, true));
	for (const vk of [...modifierVks].reverse()) events.push(keyInput(vk, true));
	send(events);
}

// ---------------------------------------------------------------------------
// Screen capture
// ---------------------------------------------------------------------------

export function clampRegion(region: { x: number; y: number; width: number; height: number }, screen: VirtualScreen): { x: number; y: number; width: number; height: number } {
	const x1 = Math.max(region.x, screen.x);
	const y1 = Math.max(region.y, screen.y);
	const x2 = Math.min(region.x + region.width, screen.x + screen.width);
	const y2 = Math.min(region.y + region.height, screen.y + screen.height);
	return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function captureScreen(region?: { x: number; y: number; width: number; height: number }): RawCapture {
	const b = api();
	const screen = getVirtualScreen();
	const rect = region ? clampRegion(region, screen) : { ...screen };
	if (rect.width <= 0 || rect.height <= 0) throw new Error('截屏区域无效（与屏幕没有交集）');

	const screenDc = b.GetDC(0);
	if (!screenDc) throw new Error('GetDC 失败');
	let memDc = 0;
	let bitmap = 0;
	let previous = 0;
	try {
		memDc = b.CreateCompatibleDC(screenDc);
		bitmap = b.CreateCompatibleBitmap(screenDc, rect.width, rect.height);
		if (!memDc || !bitmap) throw new Error('创建兼容 DC/位图失败');
		previous = b.SelectObject(memDc, bitmap);
		if (!previous) throw new Error('SelectObject 失败');
		if (!b.BitBlt(memDc, 0, 0, rect.width, rect.height, screenDc, rect.x, rect.y, SRCCOPY | CAPTUREBLT)) {
			throw new Error('BitBlt 失败（可能被前台程序的截屏保护拦截，或当前处于安全桌面/锁屏）');
		}
		// GetDIBits needs the bitmap deselected from any DC.
		b.SelectObject(memDc, previous);
		previous = 0;
		const info = {
			bmiHeader: {
				biSize: b.bitmapInfoHeaderSize,
				biWidth: rect.width,
				biHeight: -rect.height, // negative = top-down rows
				biPlanes: 1,
				biBitCount: 32,
				biCompression: BI_RGB,
				biSizeImage: 0,
				biXPelsPerMeter: 0,
				biYPelsPerMeter: 0,
				biClrUsed: 0,
				biClrImportant: 0,
			},
			bmiColors: [0],
		};
		const pixels = Buffer.alloc(rect.width * rect.height * 4);
		const got = b.GetDIBits(memDc, bitmap, 0, rect.height, pixels, info, DIB_RGB_COLORS);
		if (got !== rect.height) throw new Error(`GetDIBits 失败（${got}/${rect.height} 行）`);
		for (let i = 3; i < pixels.length; i += 4) pixels[i] = 0xff; // GDI X channel → opaque
		return { width: rect.width, height: rect.height, bgra: pixels };
	} finally {
		if (memDc && previous) b.SelectObject(memDc, previous);
		if (bitmap) b.DeleteObject(bitmap);
		if (memDc) b.DeleteDC(memDc);
		b.ReleaseDC(0, screenDc);
	}
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

export function listWindows(limit = 80): { windows: WindowInfo[]; truncated: boolean } {
	const b = api();
	const windows: WindowInfo[] = [];
	let truncated = false;
	const titleBuffer = Buffer.alloc(512 * 2);
	const foreground = handleToNumber(b.GetForegroundWindow());
	const callback = (rawHwnd: unknown): boolean => {
		const hwnd = handleToNumber(rawHwnd);
		if (!b.IsWindowVisible(hwnd)) return true;
		const exStyle = b.GetWindowLongW(hwnd, GWL_EXSTYLE) >>> 0;
		if ((exStyle & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE)) !== 0) return true;
		const cloaked = [0];
		if (b.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, cloaked, 4) === 0 && cloaked[0] !== 0) return true;
		const length = b.GetWindowTextW(hwnd, titleBuffer, 512);
		if (length <= 0) return true;
		const title = titleBuffer.subarray(0, length * 2).toString('utf16le').trim();
		if (!title) return true;
		const rect = { left: 0, top: 0, right: 0, bottom: 0 };
		const pid = [0];
		if (!b.GetWindowRect(hwnd, rect) || !b.GetWindowThreadProcessId(hwnd, pid)) return true;
		if (windows.length >= limit) {
			truncated = true;
			return false;
		}
		windows.push({
			hwnd,
			title,
			pid: pid[0],
			x: rect.left,
			y: rect.top,
			width: rect.right - rect.left,
			height: rect.bottom - rect.top,
			minimized: b.IsIconic(hwnd),
			foreground: hwnd === foreground,
		});
		return true;
	};
	// EnumWindows invokes the callback synchronously, so a transient JS callback is enough.
	b.EnumWindows(callback, 0);
	return { windows, truncated };
}

export async function activateWindow(hwnd: number): Promise<boolean> {
	const b = api();
	if (!b.IsWindow(hwnd)) throw new Error(`窗口句柄无效或窗口已关闭：hwnd=${hwnd}`);
	if (b.IsIconic(hwnd)) {
		b.ShowWindow(hwnd, SW_RESTORE);
		await delay(150);
	}
	if (b.SetForegroundWindow(hwnd)) return true;
	// Foreground lock: a synthetic Alt tap counts as user input and usually unlocks it.
	tapChord([], 0x12 /* VK_MENU */);
	return b.SetForegroundWindow(hwnd);
}

// ---------------------------------------------------------------------------
// Clipboard (CF_UNICODETEXT)
// ---------------------------------------------------------------------------

/** Another process may hold the clipboard briefly; retry a few times. */
async function withClipboard<T>(work: () => T): Promise<T> {
	const b = api();
	for (let attempt = 0; ; attempt++) {
		if (b.OpenClipboard(0)) break;
		if (attempt >= 9) throw new Error('打开剪贴板失败（被其他程序占用）');
		await delay(25);
	}
	try {
		return work();
	} finally {
		b.CloseClipboard();
	}
}

export async function readClipboardText(): Promise<string | null> {
	const b = api();
	return withClipboard(() => {
		if (!b.IsClipboardFormatAvailable(CF_UNICODETEXT)) return null;
		const handle = b.GetClipboardData(CF_UNICODETEXT);
		if (!handle) return null;
		const locked = b.GlobalLock(handle);
		if (!locked) return null;
		try {
			const sizeBytes = handleToNumber(b.GlobalSize(handle));
			const buffer = Buffer.alloc(Math.min(sizeBytes, 4 << 20) & ~1);
			b.RtlMoveMemory(buffer, locked, buffer.length);
			let end = 0;
			while (end + 1 < buffer.length && (buffer[end] !== 0 || buffer[end + 1] !== 0)) end += 2;
			return buffer.subarray(0, end).toString('utf16le');
		} finally {
			b.GlobalUnlock(handle);
		}
	});
}

export async function writeClipboardText(text: string): Promise<void> {
	const b = api();
	const encoded = Buffer.from(`${text}\0`, 'utf16le');
	await withClipboard(() => {
		if (!b.EmptyClipboard()) throw new Error('清空剪贴板失败');
		const handle = b.GlobalAlloc(GMEM_MOVEABLE, encoded.length);
		if (!handle) throw new Error('GlobalAlloc 失败');
		const locked = b.GlobalLock(handle);
		if (!locked) {
			b.GlobalFree(handle);
			throw new Error('GlobalLock 失败');
		}
		try {
			b.RtlMoveMemory(locked, encoded, encoded.length);
		} finally {
			b.GlobalUnlock(handle);
		}
		// On success the system owns the memory; free it only on failure.
		if (!b.SetClipboardData(CF_UNICODETEXT, handle)) {
			b.GlobalFree(handle);
			throw new Error('SetClipboardData 失败');
		}
	});
}

/**
 * Paste via clipboard + Ctrl+V. The previous *text* clipboard is restored
 * best-effort; non-text content (images, files) cannot be preserved.
 */
export async function pasteText(text: string, signal?: AbortSignal): Promise<void> {
	let previous: string | null = null;
	try {
		previous = await readClipboardText();
	} catch {
		previous = null;
	}
	await writeClipboardText(text);
	await delay(50, signal);
	tapChord([VK_CONTROL], VK_V);
	// Give the target time to read the clipboard before it is restored.
	await delay(150);
	if (previous !== null && previous !== text) {
		try {
			await writeClipboardText(previous);
		} catch {
			/* restore is best-effort */
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error('已中止'));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error('已中止'));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}
