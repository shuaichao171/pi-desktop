/**
 * The boot→main window swap (TODO: 启动窗口与主窗无缝衔接). The main window is
 * shown only after its renderer painted (ready-to-show) and committed the
 * restored conversation (renderer-ready), so at reveal time it already holds a
 * finished frame. The boot window must then disappear without a gap: it closes
 * once the main window is actually on screen — its `show` event has fired or
 * `isVisible()` reports it — with a short timer as a fallback for platforms
 * that report neither. Both windows share the same bounds and background
 * (windowTheme.ts), so the swap reads as an in-place content change instead of
 * a window switch.
 */
export interface SwapWindow {
	once(event: 'show', listener: () => void): unknown;
	isDestroyed(): boolean;
	isVisible(): boolean;
	close(): void;
}

/** Close the boot window once the main window is on screen. Idempotent. */
export function swapSplashForMainWindow(
	mainWindow: SwapWindow,
	splash: SwapWindow,
	scheduleFallback: (close: () => void) => void = (close) => { setTimeout(close, 250); },
): void {
	if (splash.isDestroyed()) return;
	let closed = false;
	const closeSplash = (): void => {
		if (closed || splash.isDestroyed()) return;
		closed = true;
		splash.close();
	};
	mainWindow.once('show', closeSplash);
	// reveal() shows the window before this helper runs, so the event may
	// already have fired; trust the window's own visibility state instead.
	if (mainWindow.isVisible()) closeSplash();
	scheduleFallback(closeSplash);
}
