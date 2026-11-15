/** Shared CUA types usable without pulling in the native layer. */

export interface RawCapture {
	width: number;
	height: number;
	/** Top-down 32bpp BGRA with alpha forced to 0xff. */
	bgra: Buffer;
}

export interface WindowInfo {
	hwnd: number;
	title: string;
	pid: number;
	/** Executable file name of the owning process, when it can be queried. */
	processName?: string;
	x: number;
	y: number;
	width: number;
	height: number;
	minimized: boolean;
	foreground: boolean;
}

export interface VirtualScreen {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

// ---------------------------------------------------------------------------
// Typed errors (zcode-style closed taxonomy + actionSent semantics)
// ---------------------------------------------------------------------------

export type CuaErrorCode =
	| 'PERMISSION_DENIED'
	| 'UNSUPPORTED_PLATFORM'
	| 'INVALID_ARGUMENTS'
	| 'SCREEN_LOCKED'
	| 'STALE_STATE'
	| 'TARGET_GONE'
	| 'AMBIGUOUS_TARGET'
	| 'FOREGROUND_FAILED'
	| 'INPUT_BLOCKED'
	| 'CAPTURE_BLOCKED'
	| 'CLIPBOARD_BUSY'
	| 'ABORTED'
	| 'ABORTED'
	| 'ELEMENT_UNAVAILABLE'
	| 'INTERNAL';

/**
 * Every CUA tool failure is a CuaError whose message embeds the code and the
 * actionSent flag (`CUA <CODE> (actionSent=<bool>): <detail>`), so the model
 * can branch on both without structured-error support in the host:
 *
 *  - `code` — closed taxonomy; `STALE_STATE` / `SCREEN_LOCKED` / `TARGET_GONE`
 *    tell the model to re-observe instead of blindly retrying.
 *  - `actionSent` — whether any part of the action may already have reached
 *    the target app. Only retry non-idempotent actions when it is `false`;
 *    otherwise observe first (zcode's possibly-sent semantics).
 */
export class CuaError extends Error {
	readonly code: CuaErrorCode;
	readonly actionSent: boolean;
	/** The detail text without the `CUA <code>` prefix. */
	readonly detail: string;

	constructor(code: CuaErrorCode, detail: string, options: { actionSent?: boolean } = {}) {
		super(`CUA ${code} (actionSent=${options.actionSent === true}): ${detail}`);
		this.name = 'CuaError';
		this.code = code;
		this.actionSent = options.actionSent === true;
		this.detail = detail;
	}

	/** Raise actionSent once more input may have been delivered than first reported. */
	escalateActionSent(): CuaError {
		return this.actionSent ? this : new CuaError(this.code, this.detail, { actionSent: true });
	}

	/** Normalize any thrown value into a CuaError; unknown errors become INTERNAL. */
	static from(error: unknown, fallback: { code?: CuaErrorCode; actionSent?: boolean } = {}): CuaError {
		const actionSent = fallback.actionSent === true;
		if (error instanceof CuaError) {
			return !actionSent || error.actionSent ? error : error.escalateActionSent();
		}
		return new CuaError(fallback.code ?? 'INTERNAL', error instanceof Error ? error.message : String(error));
	}
}

// ---------------------------------------------------------------------------
// Frame records (screenshot staleness checks for coordinate actions)
// ---------------------------------------------------------------------------

export interface FrameRecord {
	seq: number;
	/** Full virtual-screen bounds at capture time (physical px). */
	screen: VirtualScreen;
	/** Captured region, or null when the whole desktop was captured. */
	region: { x: number; y: number; width: number; height: number } | null;
	time: number;
	/** Set when the frame is a window-scoped capture: window identity + its
	 * on-screen rectangle at capture time, re-validated before element actions. */
	windowHwnd?: number;
	windowRect?: Rect;
}

// ---------------------------------------------------------------------------
// UIA accessibility tree (zcode-style get_app_state surface)
// ---------------------------------------------------------------------------

/** One node of a captured UIA control-view tree (read-only properties). */
export interface UiaElementNode {
	/** Lower-cased control-type name, e.g. "button", "edit", "text". */
	role: string;
	name: string;
	automationId?: string;
	className?: string;
	/** Current ValuePattern value when the element exposes one. */
	value?: string;
	rect: Rect | null;
	enabled: boolean;
	focusable: boolean;
	focused: boolean;
	offscreen: boolean;
	password: boolean;
	/** Native window handle when the element is (or owns) a top-level window. */
	hwnd?: number;
	children: UiaElementNode[];
}

export interface UiaTreeCapture {
	/** The window element itself (root of the walked subtree). */
	root: UiaElementNode;
	/** Total nodes captured (root included). */
	count: number;
	truncated: boolean;
}

/** Flattened element kept for index addressing after one cua_get_state call. */
export interface ObservedElement {
	role: string;
	name: string;
	rect: Rect | null;
	offscreen: boolean;
	enabled: boolean;
}

/** The most recent cua_get_state observation, for element-index addressing. */
export interface ElementObservation {
	hwnd: number;
	title: string;
	rect: Rect;
	/** Pre-order DFS flat list; index i of the displayed tree = flat[i]. */
	flat: ObservedElement[];
	time: number;
}
