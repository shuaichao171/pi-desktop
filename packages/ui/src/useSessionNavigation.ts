import { useEffect, useState, useSyncExternalStore } from 'react';
import { translate } from './i18n.ts';
import { SessionNavigationController, type SessionNavigationSource } from './sessionNavigation.ts';
import { useChatStore } from './store.ts';

function navigationSource(): SessionNavigationSource {
	const state = useChatStore.getState();
	return {
		owner: state.bridge,
		intent: state.navigationRequestId,
		ready: !state.navigationPending && (state.status === 'idle' || state.status === 'busy'),
		target: state.cwd && state.sessionId ? { cwd: state.cwd, sessionId: state.sessionId, sessionPath: state.sessionPath } : null,
	};
}

/** Mount once in AppShell so sidebar collapse/resizing cannot reset history. */
export function useSessionNavigation() {
	const [controller] = useState(() => new SessionNavigationController({
		read: navigationSource,
		switchWorkspace: (cwd) => useChatStore.getState().switchWorkspace(cwd),
		switchSession: (path) => useChatStore.getState().switchSession(path),
		message: (kind) => translate(`navigation.${kind}`),
	}));
	const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
	const ready = useChatStore((state) => Boolean(state.bridge && state.sessionId && !state.navigationPending && (state.status === 'idle' || state.status === 'busy')));
	useEffect(() => {
		const unsubscribe = useChatStore.subscribe(controller.observe);
		controller.observe();
		return () => { unsubscribe(); controller.cancel(); };
	}, [controller]);
	return {
		canGoBack: ready && !snapshot.navigating && snapshot.history.cursor > 0,
		canGoForward: ready && !snapshot.navigating && snapshot.history.cursor >= 0 && snapshot.history.cursor < snapshot.history.entries.length - 1,
		navigating: snapshot.navigating,
		error: snapshot.error,
		goBack: controller.goBack,
		goForward: controller.goForward,
		clearError: controller.clearError,
	};
}
