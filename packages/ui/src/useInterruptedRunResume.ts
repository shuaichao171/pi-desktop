import { useEffect, useRef } from 'react';
import { translate } from './i18n';
import { resumeInterruptedRuns } from './interruptedRunResume';
import { operationFeedback } from './operationFeedback';
import { useChatStore } from './store';

/**
 * Main window only: once the startup conversation is ready, continue every conversation
 * the previous app exit interrupted. The main process hands the list out once, so a
 * renderer reload never restarts the same turns twice.
 */
export function useInterruptedRunResume(enabled: boolean): void {
	const started = useRef(false);
	const ready = useChatStore((s) => s.status === 'idle' && Boolean(s.sessionId) && !s.navigationPending && !s.sessionLoading);
	const bridge = useChatStore((s) => s.bridge);
	useEffect(() => {
		if (!enabled || !ready || started.current || !bridge?.takeInterruptedRuns) return;
		started.current = true;
		void (async () => {
			const runs = await bridge.takeInterruptedRuns!().catch(() => []);
			if (!runs.length) return;
			operationFeedback.show({ id: 'interrupted-runs', kind: 'pending', title: translate('resume.pending', { count: runs.length }) });
			const result = await resumeInterruptedRuns(runs, {
				current: () => { const state = useChatStore.getState(); return { cwd: state.cwd || null, path: state.sessionPath }; },
				select: (cwd, path) => useChatStore.getState().selectSession(cwd, path),
				send: (text) => useChatStore.getState().send(text),
			});
			operationFeedback.show(result.failed.length
				? { id: 'interrupted-runs', kind: 'warning', title: translate('resume.partial', { resumed: result.resumed.length, failed: result.failed.length }), detail: result.failed.map(({ error }) => error).join('\n') }
				: { id: 'interrupted-runs', kind: 'success', title: translate('resume.done', { count: result.resumed.length }) });
		})();
	}, [enabled, ready, bridge]);
}
