/**
 * Optional font-family overrides, mirroring contentFontSize's localStorage
 * model: each setting writes one CSS custom property on the document root and
 * persists the raw choice. An empty value means "use the built-in stack".
 *
 * Two kinds are exposed: `mono` covers code, tool output and paths
 * (`--pd-font-mono`); `sans` covers the whole interface (`--pd-font-sans`).
 */

export type FontFamilyKind = 'mono' | 'sans';

/** Curated candidates: every entry ships with every supported platform (via fallbacks) or is a common OS face. */
export const FONT_FAMILY_CHOICES: ReadonlyArray<{ value: string; labelKey: string }> = [
	{ value: '', labelKey: 'settings.fontDefault' },
	// Monospace faces (mono picker): the fallback stack appended below keeps
	// CJK glyphs rendering even when the chosen face lacks them.
	{ value: "'Cascadia Code'", labelKey: 'settings.fontCascadiaCode' },
	{ value: "'JetBrains Mono'", labelKey: 'settings.fontJetBrainsMono' },
	{ value: 'Consolas', labelKey: 'settings.fontConsolas' },
	{ value: 'Menlo', labelKey: 'settings.fontMenlo' },
	{ value: 'Monaco', labelKey: 'settings.fontMonaco' },
	{ value: '"Source Code Pro"', labelKey: 'settings.fontSourceCodePro' },
	{ value: 'Roboto Mono', labelKey: 'settings.fontRobotoMono' },
	{ value: 'Courier New', labelKey: 'settings.fontCourierNew' },
	// Interface faces (sans picker).
	{ value: 'system-ui', labelKey: 'settings.fontSystemUi' },
	{ value: '"Segoe UI"', labelKey: 'settings.fontSegoeUi' },
	{ value: 'Arial', labelKey: 'settings.fontArial' },
	{ value: 'Tahoma', labelKey: 'settings.fontTahoma' },
	{ value: '"Noto Sans SC"', labelKey: 'settings.fontNotoSansSc' },
	{ value: 'Microsoft YaHei', labelKey: 'settings.fontMicrosoftYaHei' },
	{ value: 'SimHei', labelKey: 'settings.fontSimHei' },
	{ value: 'KaiTi', labelKey: 'settings.fontKaiTi' },
];

/** Faces that are monospace by design; only these may target the mono variable. */
export const MONO_CHOICES: ReadonlySet<string> = new Set(["'Cascadia Code'", "'JetBrains Mono'", 'Consolas', 'Menlo', 'Monaco', '"Source Code Pro"', 'Roboto Mono', 'Courier New']);

const key = (kind: FontFamilyKind) => `pi-desktop.${kind}-font-family.v1`;

/** Reject anything that is not a bare identifier or quoted name list (no inline CSS). */
function sanitize(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 120) return null;
	// Allow quoted names, bare identifiers, and commas only — never brackets,
	// semicolons or braces that could break out of the font-family property.
	return /^[A-Za-z0-9\-,'" ]+$/.test(trimmed) ? trimmed : null;
}

/** Saved raw choice, or '' for the built-in stack. */
export function readFontFamily(kind: FontFamilyKind): string {
	try { return sanitize(localStorage.getItem(key(kind))) ?? ''; } catch { return ''; }
}

/** Write the CSS variable and persist; invalid input resets to the default stack. */
export function saveFontFamily(kind: FontFamilyKind, value: string): void {
	const clean = sanitize(value) ?? '';
	applyFontFamily(kind, clean);
	try { localStorage.setItem(key(kind), clean); } catch { /* The applied in-memory preference remains. */ }
}

export function applyFontFamily(kind: FontFamilyKind, value: string): void {
	if (typeof document === 'undefined') return;
	const clean = sanitize(value) ?? '';
	// The chosen face first, then the built-in stack so missing glyphs (CJK in a
	// Latin-only mono face, emoji anywhere) still render.
	const monoFallback = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \'Liberation Mono\', \'Courier New\', \'Microsoft YaHei UI\', \'Microsoft YaHei\', \'PingFang SC\', \'Noto Sans CJK SC\', monospace';
	const sansFallback = '-apple-system, BlinkMacSystemFont, \'Segoe UI\', \'PingFang SC\', \'Hiragino Sans GB\', \'Microsoft YaHei UI\', \'Microsoft YaHei\', \'Noto Sans CJK SC\', \'Noto Sans SC\', Roboto, \'Helvetica Neue\', Arial, sans-serif, \'Apple Color Emoji\', \'Segoe UI Emoji\', \'Segoe UI Symbol\', \'Noto Color Emoji\'';
	const chain = clean ? `${clean}, ${kind === 'mono' ? monoFallback : sansFallback}` : '';
	document.documentElement.style.setProperty(`--pd-${kind}-font-override`, chain);
}

/** A sanitized choice that is safe to show in the picker, or '' for default. */
export function normalizeFontFamilyChoice(kind: FontFamilyKind, value: unknown): string {
	const clean = sanitize(value) ?? '';
	// A mono-targeted face saved under the sans slot (or vice versa) would render
	// fine via fallbacks, but keep pickers honest by rejecting cross-kind values.
	if (clean && kind === 'mono' && !MONO_CHOICES.has(clean)) return '';
	return clean;
}

export function initFontFamilies(): void {
	const apply = () => { for (const kind of ['mono', 'sans'] as const) applyFontFamily(kind, readFontFamily(kind)); };
	apply();
	if (typeof window !== 'undefined') window.addEventListener('storage', event => { if (event.key === null || event.key === key('mono') || event.key === key('sans')) apply(); });
}
