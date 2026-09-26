import { useChatStore } from './store.ts';

/** Only the captured session/branch may receive a paged navigation result. */
export async function locateHistoryMessage(messageId: string, signal: AbortSignal, snippet?: string): Promise<string | null> {
	const initial = useChatStore.getState();
	const current = () => {
		const state = useChatStore.getState();
		return !signal.aborted && state.cwd === initial.cwd && state.sessionPath === initial.sessionPath && state.historyGeneration === initial.historyGeneration && state.navigationRequestId === initial.navigationRequestId;
	};
	const normalize = (text: string) => text.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
	while (current()) {
		const state = useChatStore.getState();
		if (state.messages.some((message) => message.id === messageId)) return messageId;
		if (state.historyTotal <= state.messages.length + state.activities.length) {
			// Persisted search ids can replace transient live ids after output completes.
			const text = normalize((snippet ?? '').replace(/^(?:…|\.{3})|(?:…|\.{3})$/g, ''));
			return text ? state.messages.find((message) => normalize(message.text).includes(text))?.id ?? null : null;
		}
		if (state.loadingOlder) {
			await new Promise<void>((resolve) => {
				const finish = () => { unsubscribe(); signal.removeEventListener('abort', finish); resolve(); };
				const unsubscribe = useChatStore.subscribe((next) => { if (!next.loadingOlder || !current()) finish(); });
				signal.addEventListener('abort', finish, { once: true });
			});
			continue;
		}
		if (!await state.loadOlderMessages()) return null;
	}
	return null;
}
