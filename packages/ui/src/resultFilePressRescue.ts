import { parseResultFileReference } from './resultFileReferences';
import { useChatStore } from './store';
import { useResultFilePreviewStore } from './resultFilePreviewStore';

/**
 * A click is only dispatched when its mousedown and mouseup land on the same
 * element. Conversation completion restructures the transcript (the reply
 * moves from the running process fold to its settled answer slot, and the
 * settle resync rewrites entry ids), so a press on a result-file link that
 * straddles that moment loses its target and silently does nothing. This
 * rescue re-opens the preview from the recorded press when no click arrived.
 */
let installed = false;
let press: { href: string; x: number; y: number } | null = null;

function openFromPress(href: string): void {
	const state = useChatStore.getState();
	if (!state.bridge || !state.cwd || state.navigationPending) return;
	const reference = parseResultFileReference(href);
	if (!reference) return;
	useResultFilePreviewStore.getState().open({ ...reference, cwd: state.cwd });
}

export function installResultFilePressRescue(): void {
	if (installed || typeof window === 'undefined') return;
	installed = true;
	window.addEventListener('pointerdown', (event: PointerEvent) => {
		if (event.button !== 0) { press = null; return; }
		const target = event.target instanceof Element ? event.target : null;
		const link = target?.closest('a.pd-result-file-link');
		const href = link?.getAttribute('href');
		press = typeof href === 'string' && href ? { href, x: event.clientX, y: event.clientY } : null;
	}, true);
	window.addEventListener('pointerup', (event: PointerEvent) => {
		const pending = press;
		press = null;
		if (!pending || event.button !== 0) return;
		// A drag that moved away from the link is a selection, not a click.
		if (Math.abs(event.clientX - pending.x) > 6 || Math.abs(event.clientY - pending.y) > 6) return;
		// The normal path lets the link's own click handler run first; when the
		// node was replaced mid-press no click fires and this open stands alone.
		openFromPress(pending.href);
	}, true);
	window.addEventListener('pointercancel', () => { press = null; }, true);
}
