import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@pidesktop/ui/styles.css';
import { AppShell, useChatStore } from '@pidesktop/ui';

// Wire the preload bridge into the store before first render.
useChatStore.getState().setBridge(window.piDesktop);

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<AppShell />
	</StrictMode>,
);
