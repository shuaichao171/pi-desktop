import type { UiAppearanceState } from '@pidesktop/shared';

/**
 * One source for every startup window's background: the renderer's page
 * background. The defaults are the built-in theme's surfaces (themeColors.ts
 * preset "default"), so a first run — or any theme that never saved shared
 * appearance state — swaps the boot window for the main window without a
 * single frame of color change. A saved appearance overrides them with the
 * user's chosen surface for the effective color mode.
 */
export const WINDOW_BACKGROUND_DEFAULTS = { dark: '#161616', light: '#f8f8f8' } as const;

export interface WindowTheme {
	/** Effective color mode after resolving a 'system' preference. */
	mode: 'dark' | 'light';
	/** Background for BrowserWindow constructors and the boot/error pages. */
	background: string;
}

function isHexColor(value: unknown): value is string {
	return typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value);
}

/**
 * Resolve the shared appearance state into the colors every window shows
 * before (and behind) the renderer paints. `systemPrefersDark` comes from
 * Electron's nativeTheme at the call site so this stays pure and testable.
 */
export function resolveWindowTheme(appearance: UiAppearanceState | null | undefined, systemPrefersDark: boolean): WindowTheme {
	const mode = appearance?.theme === 'dark' || appearance?.theme === 'light'
		? appearance.theme
		: systemPrefersDark ? 'dark' : 'light';
	const surface = appearance?.colors?.[mode]?.surface;
	return { mode, background: isHexColor(surface) ? surface : WINDOW_BACKGROUND_DEFAULTS[mode] };
}

/** The slice of BrowserWindow the background sync needs (kept narrow for tests). */
export interface BackgroundTarget {
	isDestroyed(): boolean;
	setBackgroundColor(color: string): void;
}

/**
 * Re-apply the resolved background to windows that already exist. A
 * BrowserWindow's `backgroundColor` is fixed at construction, so without this
 * a runtime theme switch would leave the previous surface showing through on
 * the frames Chromium paints before the page (resize, un-minimize, reload).
 * Returns the background applied so callers can skip redundant work.
 */
export function syncWindowBackgrounds(
	windows: readonly BackgroundTarget[],
	appearance: UiAppearanceState | null | undefined,
	systemPrefersDark: boolean,
): string {
	const { background } = resolveWindowTheme(appearance, systemPrefersDark);
	for (const win of windows) {
		if (win.isDestroyed()) continue;
		try { win.setBackgroundColor(background); } catch { /* window torn down mid-loop */ }
	}
	return background;
}
