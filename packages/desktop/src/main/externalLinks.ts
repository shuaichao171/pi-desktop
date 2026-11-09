/**
 * Link routing for every window that hosts the app renderer.
 *
 * Transcripts, previews and generated content are full of destinations the
 * app itself must never load. A plain anchor click navigates the hosting
 * WebContents, so a dead address (a closed localhost dev server, a stale
 * share link) replaces the whole window with Chromium's error page — or, in a
 * split pane, trips `did-fail-load` and tears the pane down. `window.open`
 * and `target="_blank"` reach the same place through a different entry point.
 *
 * Both entry points therefore lead to the system browser; the app document
 * stays where it is.
 */
import { shell, type WebContents } from 'electron';

/** Opens one http(s) address externally; silently ignores anything else generated content may carry. */
export function openExternalHttpUrl(url: string): void {
	try {
		const parsed = new URL(url);
		if (parsed.protocol === 'https:' || parsed.protocol === 'http:') void shell.openExternal(parsed.toString());
	} catch {
		// Ignore malformed links from generated content.
	}
}

/**
 * Installs the guard for one renderer surface: new-window requests are denied
 * and handed to the browser, and main-frame navigations are cancelled unless
 * they target the document already loaded (a reload).
 */
export function guardExternalNavigation(webContents: WebContents): void {
	webContents.setWindowOpenHandler(({ url }) => {
		openExternalHttpUrl(url);
		return { action: 'deny' };
	});
	webContents.on('will-navigate', (event, url) => {
		if (url === webContents.getURL()) return;
		event.preventDefault();
		openExternalHttpUrl(url);
	});
}
