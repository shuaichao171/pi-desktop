import { useEffect, useState } from 'react';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { Icon } from './Icons';

/** Windows frameless controls, kept above dialogs so the window can always be closed. */
export function WindowControls() {
	const { t } = useT();
	const bridge = useChatStore((state) => state.bridge);
	const [maximized, setMaximized] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!bridge?.getWindowChromeState || !bridge.onWindowChromeStateChanged) return;
		let mounted = true;
		let receivedEvent = false;
		const unsubscribe = bridge.onWindowChromeStateChanged((state) => {
			receivedEvent = true;
			if (mounted) setMaximized(state.isMaximized);
		});
		void bridge.getWindowChromeState().then((state) => {
			if (mounted && !receivedEvent) setMaximized(state.isMaximized);
		}).catch(() => { if (mounted) setError(t('window.stateError')); });
		return () => {
			mounted = false;
			unsubscribe();
		};
	}, [bridge]);

	if (!bridge?.minimizeWindow || !bridge.toggleMaximizeWindow || !bridge.closeWindow) return null;

	function run(action: () => Promise<void>): void {
		setError(null);
		void action().catch((cause: unknown) => {
			setError(cause instanceof Error ? cause.message : t('window.actionError'));
		});
	}

	return (
		<div className="pd-window-controls" aria-label={t('window.controls')}>
			{error && <span className="pd-window-control-error" role="alert">{error}</span>}
			<button type="button" className="pd-window-control" aria-label={t('window.minimize')} title={t('window.minimizeShort')} onClick={() => run(() => bridge.minimizeWindow())}><Icon name="minimize" width="16" height="16" /></button>
			<button type="button" className="pd-window-control" aria-label={t(maximized ? 'window.restore' : 'window.maximize')} title={t(maximized ? 'window.restoreShort' : 'window.maximizeShort')} onClick={() => run(() => bridge.toggleMaximizeWindow())}><Icon name={maximized ? 'restore' : 'maximize'} width="16" height="16" /></button>
			<button type="button" className="pd-window-control is-close" aria-label={t('window.close')} title={t('window.closeShort')} onClick={() => run(() => bridge.closeWindow())}><Icon name="close" width="16" height="16" /></button>
		</div>
	);
}
