export type ColorMode = 'light' | 'dark';
export type ColorPresetId = 'default' | 'codex' | 'ocean' | 'forest' | 'sand' | 'custom';

export interface ThemeColors { accent: string; surface: string; ink: string; contrast: number }
export interface ThemeColorChoice extends ThemeColors { preset: ColorPresetId }
export interface ThemeColorPreferences { light: ThemeColorChoice; dark: ThemeColorChoice }

export const COLOR_PRESET_IDS = ['default', 'codex', 'ocean', 'forest', 'sand'] as const;
const STORAGE_KEY = 'pi-desktop.colors.v1';
type NamedPreset = Exclude<ColorPresetId, 'custom'>;

const PRESETS: Record<NamedPreset, Record<ColorMode, ThemeColors>> = {
	default: {
		light: { accent: '#445ca8', surface: '#ffffff', ink: '#20232b', contrast: 50 },
		dark: { accent: '#aebaff', surface: '#111216', ink: '#ececef', contrast: 50 },
	},
	codex: {
		light: { accent: '#171717', surface: '#ffffff', ink: '#171717', contrast: 50 },
		dark: { accent: '#eeeeee', surface: '#171717', ink: '#ededed', contrast: 50 },
	},
	ocean: {
		light: { accent: '#126cbb', surface: '#f4f9ff', ink: '#1e3047', contrast: 50 },
		dark: { accent: '#7abcf8', surface: '#111923', ink: '#e3eef8', contrast: 50 },
	},
	forest: {
		light: { accent: '#23784b', surface: '#f4f8f2', ink: '#20362a', contrast: 50 },
		dark: { accent: '#82c7a1', surface: '#121c17', ink: '#e1eee4', contrast: 50 },
	},
	sand: {
		light: { accent: '#9b622d', surface: '#fbf6ec', ink: '#3b3024', contrast: 50 },
		dark: { accent: '#dcb580', surface: '#201b15', ink: '#f1e7d6', contrast: 50 },
	},
};

// Keep the built-in appearance exactly aligned with styles.css. Reset removes
// inline overrides, while these values also support an accurate default preview.
const DEFAULT_TOKENS: Record<ColorMode, Record<string, string>> = {
	dark: {
		'--pd-bg': '#111216', '--pd-sidebar': '#18191d', '--pd-header': '#141518', '--pd-surface': '#1d1f24',
		'--pd-surface-hover': '#272a30', '--pd-selected': '#2a2d34', '--pd-border': '#303238', '--pd-border-soft': '#27292e',
		'--pd-text': '#ececef', '--pd-text-subtle': '#a8a9b1', '--pd-text-weak': '#777a84',
		'--pd-brand': '#aebaff', '--pd-brand-hover': '#c1cbff', '--pd-brand-ink': '#161b37',
		'--pd-danger': '#f2a6a6', '--pd-warning': '#e8c18a', '--pd-success': '#93cdb5',
		'--pd-chrome-border': '#25272d', '--pd-surface-raised': '#23252b', '--pd-surface-muted': '#17191e',
		'--pd-border-strong': '#444852', '--pd-user-surface': '#25282f', '--pd-code-surface': '#22252c',
		'--pd-code-text': '#d7dcff', '--pd-overlay': '#07090d80',
		'--pd-selection-bg': '#6575ba80', '--pd-selection-ink': '#ffffff', '--pd-mark-border': '#7783c152',
		'--pd-assistant-mark-bg': '#6f7fbd24', '--pd-brand-mark-bg': '#6f7fbd20',
	},
	light: {
		'--pd-bg': '#ffffff', '--pd-sidebar': '#f6f7f9', '--pd-header': '#ffffff', '--pd-surface': '#ffffff',
		'--pd-surface-hover': '#e9ecf2', '--pd-selected': '#e6eafa', '--pd-border': '#d9dce3', '--pd-border-soft': '#e9ebef',
		'--pd-text': '#20232b', '--pd-text-subtle': '#555b67', '--pd-text-weak': '#757c89',
		'--pd-brand': '#445ca8', '--pd-brand-hover': '#344e9c', '--pd-brand-ink': '#ffffff',
		'--pd-danger': '#ac3947', '--pd-warning': '#9a671c', '--pd-success': '#237552',
		'--pd-chrome-border': '#dfe2e8', '--pd-surface-raised': '#ffffff', '--pd-surface-muted': '#f7f8fa',
		'--pd-border-strong': '#c8cdd8', '--pd-user-surface': '#eef1f6', '--pd-code-surface': '#f1f3f8',
		'--pd-code-text': '#344b91', '--pd-overlay': '#15203c40',
		'--pd-selection-bg': '#6575ba80', '--pd-selection-ink': '#ffffff', '--pd-mark-border': '#b8c3e8',
		'--pd-assistant-mark-bg': '#e7ecfc', '--pd-brand-mark-bg': '#e7ecfc',
	},
};
const DERIVED_DEFAULT_TOKENS = {
	'--pd-focus-border': 'color-mix(in srgb, var(--pd-brand) 65%, var(--pd-border))',
	'--pd-danger-surface': 'color-mix(in srgb, var(--pd-danger) 6%, transparent)',
	'--pd-danger-border': 'color-mix(in srgb, var(--pd-danger) 32%, transparent)',
};
const COLOR_TOKENS = [...Object.keys(DEFAULT_TOKENS.dark), ...Object.keys(DERIVED_DEFAULT_TOKENS)];

export function getPresetColors(id: NamedPreset, mode: ColorMode): ThemeColorChoice {
	const preset = COLOR_PRESET_IDS.includes(id) ? id : 'default';
	return { preset, ...PRESETS[preset][mode] };
}

export function defaultColorPreferences(): ThemeColorPreferences {
	return { light: getPresetColors('default', 'light'), dark: getPresetColors('default', 'dark') };
}

export function normalizeHexColor(input: string): string | null {
	if (typeof input !== 'string') return null;
	const value = input.trim().toLowerCase();
	if (/^#[0-9a-f]{6}$/.test(value)) return value;
	if (/^#[0-9a-f]{3}$/.test(value)) return `#${[...value.slice(1)].map((digit) => digit + digit).join('')}`;
	return null;
}

function record(input: unknown): Record<string, unknown> | null {
	return input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
}

function normalizeChoice(input: unknown, mode: ColorMode): ThemeColorChoice {
	const value = record(input);
	if (!value) return getPresetColors('default', mode);
	const known = COLOR_PRESET_IDS.includes(value.preset as NamedPreset) ? value.preset as NamedPreset : 'default';
	const fallback = getPresetColors(known, mode);
	const choice: ThemeColorChoice = {
		preset: value.preset === 'custom' ? 'custom' : known,
		accent: normalizeHexColor(value.accent as string) ?? fallback.accent,
		surface: normalizeHexColor(value.surface as string) ?? fallback.surface,
		ink: normalizeHexColor(value.ink as string) ?? fallback.ink,
		contrast: typeof value.contrast === 'number' && Number.isFinite(value.contrast) ? Math.round(Math.max(0, Math.min(100, value.contrast))) : fallback.contrast,
	};
	// A changed preset is a custom choice; its values must not disappear when
	// applying the default preset's intentional "remove inline styles" behavior.
	if (['accent', 'surface', 'ink', 'contrast'].some((key) => choice[key as keyof ThemeColors] !== fallback[key as keyof ThemeColors])) choice.preset = 'custom';
	return choice;
}

export function normalizeColorPreferences(input: unknown): ThemeColorPreferences {
	const value = record(input);
	return { light: normalizeChoice(value?.light, 'light'), dark: normalizeChoice(value?.dark, 'dark') };
}

function browserStorage(): Storage | undefined {
	return typeof window === 'undefined' ? undefined : window.localStorage;
}

export function readColorPreferences(storage?: Pick<Storage, 'getItem'>): ThemeColorPreferences {
	try {
		const saved = (storage ?? browserStorage())?.getItem(STORAGE_KEY);
		return saved ? normalizeColorPreferences(JSON.parse(saved)) : defaultColorPreferences();
	} catch { return defaultColorPreferences(); }
}

export function writeColorPreferences(prefs: ThemeColorPreferences, storage?: Pick<Storage, 'setItem'>): boolean {
	try {
		const target = storage ?? browserStorage();
		if (!target) return false;
		target.setItem(STORAGE_KEY, JSON.stringify(normalizeColorPreferences(prefs)));
		return true;
	} catch { return false; }
}

function rgb(hex: string): [number, number, number] {
	return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
}

function mix(a: string, b: string, amount: number): string {
	const first = rgb(a), second = rgb(b);
	return `#${first.map((value, index) => Math.round(value + (second[index]! - value) * amount).toString(16).padStart(2, '0')).join('')}`;
}

function luminance(hex: string): number {
	const channels = rgb(hex).map((value) => { const channel = value / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4; });
	return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function contrast(a: string, b: string): number {
	const first = luminance(a), second = luminance(b);
	return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function readable(candidate: string, backgrounds: string[], target: number): string {
	const score = (color: string) => Math.min(...backgrounds.map((background) => contrast(color, background)));
	if (score(candidate) >= target) return candidate;
	const endpoint = score('#000000') >= score('#ffffff') ? '#000000' : '#ffffff';
	if (score(endpoint) < target) return endpoint;
	let low = 0, high = 1;
	for (let step = 0; step < 12; step++) {
		const middle = (low + high) / 2;
		if (score(mix(candidate, endpoint, middle)) >= target) high = middle;
		else low = middle;
	}
	return mix(candidate, endpoint, high);
}

export function buildThemeTokens(choice: ThemeColorChoice, mode: ColorMode): Record<string, string> {
	const colors = normalizeChoice(choice, mode);
	if (colors.preset === 'default') return { ...DEFAULT_TOKENS[mode], ...DERIVED_DEFAULT_TOKENS };
	const { surface: bg, accent: brand } = colors;
	const strength = colors.contrast / 100;
	// Custom backgrounds can be lighter/darker than their selected mode. Derive
	// readable surfaces from the actual background instead of assuming its tone.
	const light = luminance(bg) > 0.35;
	const direction = light ? '#000000' : '#ffffff';
	const tone = (amount: number) => mix(bg, direction, amount);
	const primaryEndpoint = contrast(bg, '#000000') >= contrast(bg, '#ffffff') ? '#000000' : '#ffffff';
	const safeSurface = (candidate: string) => {
		if (contrast(candidate, primaryEndpoint) >= 4.5) return candidate;
		// Mid-gray custom backgrounds sit close to the black/white crossover.
		// Keep raised/selected surfaces from crossing into unreadable territory.
		let low = 0, high = 1;
		for (let step = 0; step < 12; step++) {
			const middle = (low + high) / 2;
			if (contrast(mix(candidate, bg, middle), primaryEndpoint) >= 4.5) high = middle;
			else low = middle;
		}
		return mix(candidate, bg, high);
	};
	const surface = safeSurface(tone(light ? 0.008 + strength * 0.008 : 0.025 + strength * 0.025));
	const raised = safeSurface(tone(light ? 0 : 0.04 + strength * 0.04));
	const hover = safeSurface(tone(0.05 + strength * 0.065));
	const selected = safeSurface(mix(tone(0.045 + strength * 0.04), brand, 0.025 + strength * 0.04));
	const user = safeSurface(tone(0.04 + strength * 0.045));
	const code = safeSurface(tone(0.03 + strength * 0.04));
	const sidebar = safeSurface(tone(0.018 + strength * 0.025));
	const header = safeSurface(tone(0.006 + strength * 0.01));
	const muted = safeSurface(tone(0.012 + strength * 0.014));
	const backgrounds = [bg, surface, raised, hover, selected, user, code, sidebar, header, muted];
	const text = readable(colors.ink, backgrounds, 7);
	const subtle = readable(mix(bg, text, 0.72), backgrounds, 4.5);
	const weak = readable(mix(bg, text, 0.54), backgrounds, 3);
	const brandInk = contrast(brand, '#000000') >= contrast(brand, '#ffffff') ? '#000000' : '#ffffff';
	const danger = readable(light ? '#ac3947' : '#f2a6a6', backgrounds, 4.5);
	const border = tone(0.12 + strength * 0.16);
	return {
		'--pd-bg': bg, '--pd-sidebar': sidebar, '--pd-header': header,
		'--pd-surface': surface, '--pd-surface-hover': hover, '--pd-selected': selected,
		'--pd-border': border, '--pd-border-soft': tone(0.07 + strength * 0.10),
		'--pd-text': text, '--pd-text-subtle': subtle, '--pd-text-weak': weak,
		'--pd-brand': brand, '--pd-brand-hover': mix(brand, brandInk === '#000000' ? '#ffffff' : '#000000', 0.12), '--pd-brand-ink': brandInk,
		'--pd-danger': danger, '--pd-warning': readable(light ? '#9a671c' : '#e8c18a', backgrounds, 4.5),
		'--pd-success': readable(light ? '#237552' : '#93cdb5', backgrounds, 4.5),
		'--pd-chrome-border': tone(0.08 + strength * 0.09), '--pd-surface-raised': raised,
		'--pd-surface-muted': muted, '--pd-border-strong': tone(0.2 + strength * 0.2),
		'--pd-user-surface': user, '--pd-code-surface': code, '--pd-code-text': readable(mix(text, brand, 0.2), [code], 4.5),
		'--pd-overlay': light ? '#14203044' : '#00000088', '--pd-focus-border': mix(brand, border, 0.35),
		'--pd-danger-surface': `${danger}0f`, '--pd-danger-border': `${danger}52`,
		'--pd-selection-bg': brand, '--pd-selection-ink': brandInk, '--pd-mark-border': `${brand}52`,
		'--pd-assistant-mark-bg': `${brand}24`, '--pd-brand-mark-bg': `${brand}20`,
	};
}

export function applyThemeColors(root: HTMLElement, choice: ThemeColorChoice, mode: ColorMode): void {
	for (const token of COLOR_TOKENS) root.style.removeProperty(token);
	const normalized = normalizeChoice(choice, mode);
	if (normalized.preset === 'default') return;
	for (const [token, value] of Object.entries(buildThemeTokens(normalized, mode))) root.style.setProperty(token, value);
}
