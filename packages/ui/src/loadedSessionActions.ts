import { translate } from './i18n';
import { addLoadedSession, getLoadedSessions, removeLoadedSession, setLoadedPanes, MAX_LOADED_SESSIONS } from './loadedSessions';
import { operationFeedback } from './operationFeedback';
import { useChatStore } from './store';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Keep a conversation warm in the main window and list it under "Loaded sessions". */
export async function loadSessionIntoMain(cwd: string, path: string): Promise<boolean> {
	const bridge = useChatStore.getState().bridge;
	if (!bridge?.loadSession) return false;
	const { main, panes } = getLoadedSessions();
	// A pane already hosts it: that pane is its loaded form; bring it back instead.
	const pane = panes.find((item) => item.sessionPath === path);
	if (pane) {
		if (pane.hidden) await bridge.setSplitPaneHidden?.(false, pane.paneId).catch(() => {});
		else await bridge.focusHostedSession?.(path).catch(() => false);
		return true;
	}
	if (main.some((item) => item.path === path)) return true;
	if (!addLoadedSession({ cwd, path })) {
		operationFeedback.show({ id: 'loaded-sessions', kind: 'warning', title: translate('loaded.full', { count: MAX_LOADED_SESSIONS }) });
		return false;
	}
	try {
		await bridge.loadSession(cwd, path);
		return true;
	} catch (error) {
		removeLoadedSession(path);
		operationFeedback.show({ id: 'loaded-sessions', kind: 'error', title: translate('loaded.failed'), detail: errorText(error) });
		return false;
	}
}

/** Drop a main-window loaded conversation from the list (a running turn keeps going). */
export async function unloadSessionFromMain(path: string): Promise<void> {
	removeLoadedSession(path);
	await useChatStore.getState().bridge?.unloadSession?.(path).catch(() => {});
}

/** Close a pane for real (its own close button only hides it). Running turns ask first in the main process. */
export async function closeLoadedPane(paneId: number): Promise<void> {
	const bridge = useChatStore.getState().bridge;
	await bridge?.closeSplitPane?.(paneId).catch(() => { /* Confirmation canceled. */ });
}

/** Startup: re-warm the persisted list in the background, dropping entries that no longer open. */
export async function restoreLoadedSessions(): Promise<void> {
	const bridge = useChatStore.getState().bridge;
	if (!bridge?.loadSession) return;
	if (bridge.describeSplitPanes) setLoadedPanes(await bridge.describeSplitPanes().catch(() => []));
	for (const entry of [...getLoadedSessions().main]) {
		try { await bridge.loadSession(entry.cwd, entry.path); }
		catch { removeLoadedSession(entry.path); }
	}
}
