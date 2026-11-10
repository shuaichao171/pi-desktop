import { useEffect, useReducer, useRef } from 'react';
import { suggestionKey, useNextInputSuggestionPreference } from './nextInputSuggestion';
import { useChatStore } from './store';

/** Settled suggestions by reply identity; '' remembers "nothing to suggest" so it is not retried. */
const suggestions = new Map<string, string>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();
const MAX_CACHED = 50;

function remember(key: string, text: string): void {
	suggestions.delete(key);
	suggestions.set(key, text);
	while (suggestions.size > MAX_CACHED) suggestions.delete(suggestions.keys().next().value!);
	for (const listener of listeners) listener();
}

/**
 * The guessed next message for the open conversation, or null. A request fires once when a
 * reply settles in this window (busy → idle); failures stay silent and never touch the main
 * flow. A new turn or a session switch changes the key, so a late answer for an older reply
 * is cached but never shown.
 */
export function useNextInputSuggestion(): string | null {
	const preference = useNextInputSuggestionPreference();
	const bridge = useChatStore((s) => s.bridge);
	const status = useChatStore((s) => s.status);
	const sessionPath = useChatStore((s) => s.sessionPath);
	const key = useChatStore((s) => suggestionKey(s.sessionPath, s.messages));
	const [, rerender] = useReducer((value: number) => value + 1, 0);
	const sawBusy = useRef(false);

	useEffect(() => { listeners.add(rerender); return () => { listeners.delete(rerender); }; }, []);
	useEffect(() => { sawBusy.current = false; }, [sessionPath]);
	useEffect(() => {
		if (status === 'busy') { sawBusy.current = true; return; }
		if (status !== 'idle' || !sawBusy.current) return;
		sawBusy.current = false;
		if (!preference.enabled || !key || !sessionPath || suggestions.has(key) || inFlight.has(key) || !bridge?.suggestNextInput) return;
		inFlight.add(key);
		const model = preference.model;
		void bridge.suggestNextInput({ sessionPath, ...(model ? { provider: model.provider, model: model.id } : {}) })
			.then((text) => remember(key, typeof text === 'string' ? text.trim() : ''), () => remember(key, ''))
			.finally(() => { inFlight.delete(key); });
	}, [status, key, sessionPath, bridge, preference.enabled, preference.model]);

	if (!preference.enabled || status !== 'idle' || !key) return null;
	return suggestions.get(key) || null;
}
