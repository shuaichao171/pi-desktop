export type ContentFontKind = 'code' | 'command';
export const CONTENT_FONT_MIN = 12;
export const CONTENT_FONT_MAX = 24;
export const DEFAULT_CONTENT_FONT_SIZE = 12;
const key = (kind: ContentFontKind) => `pi-desktop.${kind}-font-size.v1`;
export function normalizeContentFontSize(value: unknown): number {
	const number = typeof value === 'number' || typeof value === 'string' && value.trim() ? Number(value) : NaN;
	return Number.isFinite(number) ? Math.min(CONTENT_FONT_MAX, Math.max(CONTENT_FONT_MIN, Math.round(number))) : DEFAULT_CONTENT_FONT_SIZE;
}
export function readContentFontSize(kind: ContentFontKind): number {
	try { return normalizeContentFontSize(localStorage.getItem(key(kind))); } catch { return DEFAULT_CONTENT_FONT_SIZE; }
}
export function applyContentFontSize(kind: ContentFontKind, value: number) {
	if (typeof document !== 'undefined') document.documentElement.style.setProperty(`--pd-${kind}-font-size`, `${normalizeContentFontSize(value)}px`);
}
export function saveContentFontSize(kind: ContentFontKind, value: number) {
	const size = normalizeContentFontSize(value);
	applyContentFontSize(kind, size);
	try { localStorage.setItem(key(kind), String(size)); } catch { /* The in-memory preference remains usable. */ }
}
export function initContentFontSizes() {
	const apply = () => { for (const kind of ['code', 'command'] as const) applyContentFontSize(kind, readContentFontSize(kind)); };
	apply();
	if (typeof window !== 'undefined') window.addEventListener('storage', event => { if (event.key === null || event.key === key('code') || event.key === key('command')) apply(); });
}
