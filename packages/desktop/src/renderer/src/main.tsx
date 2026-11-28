import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@pidesktop/ui/styles.css';
import { AppShell, selectStartupReady, useChatStore } from '@pidesktop/ui';

// Apply the main-process resolved window theme synchronously before React mounts
// so the very first rendered frame matches the boot splash with zero dark flash.
const launchParams = new URLSearchParams(window.location.search);
const initialTheme = launchParams.get('initialTheme');
if (initialTheme === 'light' || initialTheme === 'dark') {
	document.documentElement.dataset.theme = initialTheme;
	document.documentElement.style.colorScheme = initialTheme;
}
const initialBg = launchParams.get('initialBg');
if (initialBg && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(initialBg)) {
	document.documentElement.style.setProperty('--pd-bg', initialBg);
}

// Wire the preload bridge into the store before first render. Hosted surfaces
// (pai windows and split panes) load this same renderer with ?mode=pai|pane and
// keep only the chat surface, so the store must not ask for the main window's
// workspace and session lists — those channels are main-window-only.
const launchMode = launchParams.get('mode');
useChatStore.getState().setBridge(window.piDesktop, {
	hostedChatWindow: launchMode === 'pai' || launchMode === 'pane',
});

function RendererReady() {
	const ready = useChatStore(selectStartupReady);
	const [appearanceSettled, setAppearanceSettled] = useState(() => typeof window.piDesktop?.getAppearance !== 'function');
	useEffect(() => {
		if (appearanceSettled) return;
		let cancelled = false;
		void window.piDesktop.getAppearance?.().catch(() => null).finally(() => {
			if (!cancelled) setAppearanceSettled(true);
		});
		return () => { cancelled = true; };
	}, [appearanceSettled]);
	useEffect(() => {
		if (!ready || !appearanceSettled) return;
		// The second frame lets the committed conversation paint before showing it.
		let revealFrame: number | undefined;
		const frame = window.requestAnimationFrame(() => {
			revealFrame = window.requestAnimationFrame(() => {
				void window.piDesktop.notifyRendererReady().catch((error: unknown) => {
					console.error('Failed to show the ready renderer', error);
				});
			});
		});
		return () => {
			window.cancelAnimationFrame(frame);
			if (revealFrame !== undefined) window.cancelAnimationFrame(revealFrame);
		};
	}, [ready, appearanceSettled]);
	return null;
}

const root = document.getElementById('root');
if (!root) throw new Error('Pi Desktop renderer root element is missing');
createRoot(root).render(
	<StrictMode>
		<AppShell />
		<RendererReady />
	</StrictMode>,
);
