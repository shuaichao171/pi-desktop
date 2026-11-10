import { useSyncExternalStore } from 'react';

/**
 * "Guess your next message" preferences. Off by default; the model is chosen separately
 * (null = the conversation's own model). Stored in localStorage, which the main window,
 * pai windows and split panes share, and kept in sync across them via storage events.
 */
export interface NextInputSuggestionPreference { enabled: boolean; model: { provider: string; id: string } | null }

const STORAGE_KEY = 'pi-desktop:next-input-suggestion';
const DEFAULT_PREFERENCE: NextInputSuggestionPreference = { enabled: false, model: null };
const listeners = new Set<() => void>();

export function normalizeNextInputSuggestionPreference(value: unknown): NextInputSuggestionPreference {
	if (!value || typeof value !== 'object') return DEFAULT_PREFERENCE;
	const candidate = value as Partial<NextInputSuggestionPreference>;
	const model = candidate.model && typeof candidate.model === 'object'
		&& typeof candidate.model.provider === 'string' && candidate.model.provider
		&& typeof candidate.model.id === 'string' && candidate.model.id
		? { provider: candidate.model.provider, id: candidate.model.id } : null;
	return { enabled: candidate.enabled === true, model };
}

function readStored(): NextInputSuggestionPreference {
	try { return normalizeNextInputSuggestionPreference(typeof window === 'undefined' ? null : JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')); }
	catch { return DEFAULT_PREFERENCE; }
}

let preference = readStored();

function publish(next: NextInputSuggestionPreference): void {
	if (preference.enabled === next.enabled && preference.model?.provider === next.model?.provider && preference.model?.id === next.model?.id) return;
	preference = next;
	for (const listener of listeners) listener();
}

export function getNextInputSuggestionPreference(): NextInputSuggestionPreference { return preference; }

/** Applies locally even when persistence fails; returns whether it was stored. */
export function setNextInputSuggestionPreference(patch: Partial<NextInputSuggestionPreference>): boolean {
	const next = normalizeNextInputSuggestionPreference({ ...preference, ...patch });
	publish(next);
	try {
		if (typeof window !== 'undefined') { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); return true; }
	} catch { /* keep the in-session preference */ }
	return false;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

export function useNextInputSuggestionPreference(): NextInputSuggestionPreference {
	return useSyncExternalStore(subscribe, getNextInputSuggestionPreference, getNextInputSuggestionPreference);
}

if (typeof window !== 'undefined') {
	window.addEventListener('storage', (event) => {
		if (event.key !== null && event.key !== STORAGE_KEY) return;
		try { if (event.storageArea && event.storageArea !== window.localStorage) return; } catch { return; }
		publish(readStored());
	});
}

export interface SuggestionTurn { sessionPath: string | null; replyId: string | null }

/**
 * Identity of the reply a suggestion answers. Only a settled, successful assistant reply that
 * ends the conversation qualifies; a new turn, a session switch or an error invalidates it.
 */
export function suggestionKey(sessionPath: string | null, messages: readonly { id: string; role: string; status?: string; text: string; systemKind?: string }[]): string | null {
	if (!sessionPath) return null;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]!;
		if (message.systemKind || message.role === 'system') continue;
		if (message.role !== 'assistant') return null;
		if (message.status === 'error' || message.status === 'streaming' || !message.text.trim()) return null;
		return `${sessionPath}\0${message.id}`;
	}
	return null;
}
