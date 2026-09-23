import { useEffect, useState } from 'react';
import { useChatStore } from '../store';
import { Icon } from './Icons';

/** Windows frameless controls, kept above dialogs so the window can always be closed. */
export function WindowControls() {
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
		}).catch(() => { if (mounted) setError('无法读取窗口状态'); });
		return () => {
			mounted = false;
			unsubscribe();
		};
	}, [bridge]);

	if (!bridge?.minimizeWindow || !bridge.toggleMaximizeWindow || !bridge.closeWindow) return null;

	function run(action: () => Promise<void>): void {
		setError(null);
		void action().catch((cause: unknown) => {
			setError(cause instanceof Error ? cause.message : '窗口操作失败');
		});
	}

	return (
		<div className="pd-window-controls" aria-label="窗口控制">
			{error && <span className="pd-window-control-error" role="alert">{error}</span>}
			<button type="button" className="pd-window-control" aria-label="最小化窗口" title="最小化" onClick={() => run(() => bridge.minimizeWindow())}><Icon name="minimize" width="16" height="16" /></button>
			<button type="button" className="pd-window-control" aria-label={maximized ? '还原窗口' : '最大化窗口'} title={maximized ? '还原' : '最大化'} onClick={() => run(() => bridge.toggleMaximizeWindow())}><Icon name={maximized ? 'restore' : 'maximize'} width="16" height="16" /></button>
			<button type="button" className="pd-window-control is-close" aria-label="关闭窗口" title="关闭" onClick={() => run(() => bridge.closeWindow())}><Icon name="close" width="16" height="16" /></button>
		</div>
	);
}
