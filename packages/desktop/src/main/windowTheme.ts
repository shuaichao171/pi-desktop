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
