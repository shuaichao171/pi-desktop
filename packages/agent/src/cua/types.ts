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
