/**
 * Interface font size, mirroring ZCode's lib/uiFontSize.ts model: the setting
 * writes only the `--pd-ui-font-size` custom property on the document root and
 * never the html font-size, so icons, spacing and radii never scale with it.
 */

export const UI_FONT_SIZE_MIN = 12;
export const UI_FONT_SIZE_MAX = 20;
export const DEFAULT_UI_FONT_SIZE = 13;
const STORAGE_KEY = 'pi-desktop.ui-font-size.v1';
const CSS_PROPERTY = '--pd-ui-font-size';

/** Clamp and round to a whole pixel value; null rejects non-numeric input. */
export function normalizeUiFontSize(value: unknown): number | null {
	const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
	if (!Number.isFinite(parsed)) return null;
	const rounded = Math.round(parsed);
	return Math.min(UI_FONT_SIZE_MAX, Math.max(UI_FONT_SIZE_MIN, rounded));
}

function storage(): Storage | null {
	try {
		const store = typeof localStorage === 'undefined' ? undefined : localStorage;
		return store ?? null;
	} catch {
		// Blocked storage (privacy mode, disabled cookies) falls back to the default.
		return null;
	}
}

/** Saved preference, or the default when absent, blocked or invalid. */
export function readUiFontSize(): number {
	const raw = storage()?.getItem(STORAGE_KEY);
	if (raw == null) return DEFAULT_UI_FONT_SIZE;
	return normalizeUiFontSize(raw) ?? DEFAULT_UI_FONT_SIZE;
}

/** Persist the preference; failures keep the in-memory value usable. */
export function saveUiFontSize(size: number): void {
	storage()?.setItem(STORAGE_KEY, String(size));
}

/** Write the CSS property only. Called on startup and whenever the slider moves. */
export function applyUiFontSize(size: number): void {
	if (typeof document === 'undefined') return;
	document.documentElement.style.setProperty(CSS_PROPERTY, `${size}px`);
}

/** Apply the saved preference and follow same-origin changes from other windows. */
export function initUiFontSize(): number {
	const size = readUiFontSize();
	applyUiFontSize(size);
	if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
		window.addEventListener('storage', (event) => {
			if (event.key !== null && event.key !== STORAGE_KEY) return;
			applyUiFontSize(readUiFontSize());
		});
	}
	return size;
}
