import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import '@pidesktop/ui/styles.css';
import { AppShell, selectStartupReady, useChatStore } from '@pidesktop/ui';

// Wire the preload bridge into the store before first render. A hosted pai chat
// window loads this same renderer with ?mode=pai and keeps only the chat surface,
// so the store must not ask for the main window's workspace and session lists.
useChatStore.getState().setBridge(window.piDesktop, {
	hostedChatWindow: new URLSearchParams(window.location.search).get('mode') === 'pai',
});

function RendererReady() {
	const ready = useChatStore(selectStartupReady);
	useEffect(() => {
		if (!ready) return;
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
	}, [ready]);
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
