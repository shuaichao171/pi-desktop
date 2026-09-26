/**
 * Declarative shortcut registry (4.3). Handlers match events through
 * matchesShortcut() so user overrides apply everywhere at once, and the
 * settings page renders straight from this list.
 */
export type ShortcutScope = 'global' | 'composer' | 'transcript';

export interface ShortcutBinding {
	id: string;
	/** Default key spec, e.g. 'Ctrl+K'; empty means unassigned. Ctrl renders as ⌘ on macOS. */
	keys: string;
	/** i18n key for the human label. */
	labelKey: string;
	scope: ShortcutScope;
	/** Typing semantics (Enter family, Esc stop) stay fixed. */
	fixed?: boolean;
}

export const SHORTCUT_BINDINGS: readonly ShortcutBinding[] = [
	{ id: 'search', keys: 'Ctrl+K', labelKey: 'settings.shortcutSearch', scope: 'global' },
	{ id: 'commandPalette', keys: 'Ctrl+Shift+P', labelKey: 'settings.shortcutPalette', scope: 'global' },
	{ id: 'toggleSidebar', keys: 'Ctrl+B', labelKey: 'settings.shortcutSidebar', scope: 'global' },
	{ id: 'historyBack', keys: 'Ctrl+[', labelKey: 'settings.shortcutHistoryBack', scope: 'global' },
	{ id: 'historyForward', keys: 'Ctrl+]', labelKey: 'settings.shortcutHistoryForward', scope: 'global' },
	{ id: 'findInTranscript', keys: 'Ctrl+F', labelKey: 'chat.find.label', scope: 'transcript' },
	{ id: 'previousTurn', keys: 'Alt+ArrowUp', labelKey: 'settings.shortcutPrevTurn', scope: 'transcript' },
	{ id: 'nextTurn', keys: 'Alt+ArrowDown', labelKey: 'settings.shortcutNextTurn', scope: 'transcript' },
	{ id: 'stopGeneration', keys: 'Escape', labelKey: 'settings.shortcutStop', scope: 'transcript', fixed: true },
	{ id: 'send', keys: 'Enter', labelKey: 'settings.shortcutSend', scope: 'composer', fixed: true },
	{ id: 'newline', keys: 'Shift+Enter', labelKey: 'settings.shortcutNewline', scope: 'composer', fixed: true },
	{ id: 'steer', keys: 'Ctrl+Enter', labelKey: 'settings.shortcutSteer', scope: 'composer', fixed: true },
];

export const SHORTCUT_STORAGE_KEY = 'pi-desktop.shortcuts.v1';

export interface ParsedKeys { ctrl: boolean; shift: boolean; alt: boolean; key: string }

const KEY_ALIASES: Record<string, string> = {
	'[': '[',
	']': ']',
	escape: 'Escape',
	enter: 'Enter',
	arrowup: 'ArrowUp',
	arrowdown: 'ArrowDown',
	arrowleft: 'ArrowLeft',
	arrowright: 'ArrowRight',
};

/** Parses a 'Ctrl+Shift+X' spec; Ctrl means the primary modifier (Ctrl/⌘). */
export function parseKeys(spec: string): ParsedKeys | null {
	const parts = spec.split('+').map((part) => part.trim()).filter(Boolean);
	if (parts.length === 0) return null;
	const parsed: ParsedKeys = { ctrl: false, shift: false, alt: false, key: '' };
	for (const part of parts) {
		const lower = part.toLowerCase();
		if (lower === 'ctrl' || lower === 'cmd' || lower === 'meta') parsed.ctrl = true;
		else if (lower === 'shift') parsed.shift = true;
		else if (lower === 'alt') parsed.alt = true;
		else parsed.key = KEY_ALIASES[lower] ?? part;
	}
	if (!parsed.key) return null;
	return parsed;
}

function eventKey(event: { key: string; code?: string }): string {
	const key = event.key.toLowerCase();
	if (KEY_ALIASES[key]) return KEY_ALIASES[key];
	const code = event.code ?? '';
	if (code === 'BracketLeft') return '[';
	if (code === 'BracketRight') return ']';
	return key.length === 1 ? key : event.key;
}

/** True when a keyboard event matches a 'Ctrl+Shift+X' spec (IME-safe: callers guard isComposing). */
export function matchesShortcut(event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; key: string; code?: string }, spec: string): boolean {
	const parsed = parseKeys(spec);
	if (!parsed) return false;
	const primary = event.ctrlKey || event.metaKey;
	if (parsed.ctrl !== primary) return false;
	if (parsed.shift !== event.shiftKey) return false;
	if (parsed.alt !== event.altKey) return false;
	return eventKey(event).toLowerCase() === parsed.key.toLowerCase();
}

export function readShortcutOverrides(): Record<string, string> {
	try {
		if (typeof localStorage === 'undefined') return {};
		const raw = localStorage.getItem(SHORTCUT_STORAGE_KEY);
		if (!raw) return {};
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
		const overrides: Record<string, string> = {};
		for (const [id, keys] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof keys === 'string' && parseKeys(keys)) overrides[id] = keys;
		}
		return overrides;
	} catch {
		return {};
	}
}

export function writeShortcutOverrides(overrides: Record<string, string>): void {
	try {
		if (typeof localStorage === 'undefined') return;
		localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(overrides));
	} catch { /* storage unavailable — overrides stay session-only */ }
}

/** Effective keys for a binding id: the user override or the registry default. */
export function bindingKeysFor(id: string, overrides: Record<string, string> = readShortcutOverrides()): string {
	return overrides[id] ?? SHORTCUT_BINDINGS.find((binding) => binding.id === id)?.keys ?? '';
}
