import { create } from 'zustand';
import type { ResultFileTarget } from '@pidesktop/shared';

/**
 * Result-file previews are opened from links deep inside the transcript, but the
 * open dialog must not live there: conversation turns remount when a session
 * gains its file path (first settle) or when history reloads, and state held by
 * a link would close the dialog under the click that opened it. One stable
 * owner (AppShell) renders the dialog from this store.
 */
interface ResultFilePreviewState {
	target: ResultFileTarget | null;
	open(target: ResultFileTarget): void;
	close(): void;
}

export const useResultFilePreviewStore = create<ResultFilePreviewState>(set => ({
	target: null,
	open: target => set({ target }),
	close: () => set({ target: null }),
}));
