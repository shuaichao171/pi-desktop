import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useChatStore } from '../store';

/** Window event the sidebar dispatches once the main process returned a pane id. */
export const SPLIT_PANE_OPENED_EVENT = 'pi-split-pane-opened';

type Rect = { x: number; y: number; width: number; height: number };
const HIDDEN: Rect = { x: 0, y: 0, width: 0, height: 0 };

function intersects(a: DOMRect, b: DOMRect): boolean {
	return a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0
		&& a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * Overlay surfaces rendered by this (main) renderer: everything React portals
 * into <body> next to the app root — dialogs, menus, pickers, tooltips. A split
 * pane is a native WebContentsView stacked above the whole page, so any of these
 * reaching into a pane's region would be hidden underneath it.
 */
function overlayRects(): DOMRect[] {
	const rects: DOMRect[] = [];
	for (const element of Array.from(document.body.children)) {
		if (element.id === 'root' || element.tagName === 'SCRIPT' || element.tagName === 'STYLE') continue;
		rects.push(element.getBoundingClientRect());
		// Portal wrappers may be zero-sized hosts around fixed-position content.
		for (const child of Array.from(element.children)) rects.push(child.getBoundingClientRect());
	}
	// Native modal dialogs render in the top layer from inside the app tree.
	for (const dialog of Array.from(document.querySelectorAll('dialog[open]'))) rects.push(dialog.getBoundingClientRect());
	return rects;
}

/**
 * Main-window side of split panes: owns the open pane ids, renders nothing
 * itself, and keeps every pane's native view glued to its placeholder region
 * (`[data-pane-id]` inside the host element). `visible` false — or an overlay
 * covering a region — hides that pane instead of letting it cover the overlay.
 */
export function useSplitPaneRegions(enabled: boolean, visible: boolean) {
	const [paneIds, setPaneIds] = useState<number[]>([]);
	const hostRef = useRef<HTMLDivElement | null>(null);
	const lastReported = useRef(new Map<number, string>());
	const visibleRef = useRef(visible);
	visibleRef.current = visible;

	useEffect(() => {
		if (!enabled) return;
		const bridge = useChatStore.getState().bridge;
		let cancelled = false;
		// A reloaded main renderer (dev reload, crash recovery) finds its panes again.
		void bridge?.listSplitPanes?.().then((ids) => {
			if (!cancelled && Array.isArray(ids)) setPaneIds((current) => [...new Set([...current, ...ids])]);
		}).catch(() => { /* Older host without the channel. */ });
		const unsubscribe = bridge?.onSplitPaneClosed?.((paneId) => {
			lastReported.current.delete(paneId);
			setPaneIds((current) => current.filter((id) => id !== paneId));
		});
		const opened = (event: Event) => {
			const paneId = (event as CustomEvent<unknown>).detail;
			if (typeof paneId === 'number') setPaneIds((current) => (current.includes(paneId) ? current : [...current, paneId]));
		};
		window.addEventListener(SPLIT_PANE_OPENED_EVENT, opened);
		return () => {
			cancelled = true;
			unsubscribe?.();
			window.removeEventListener(SPLIT_PANE_OPENED_EVENT, opened);
		};
	}, [enabled]);

	const report = useCallback(() => {
		const bridge = useChatStore.getState().bridge;
		if (!bridge?.setSplitPaneBounds) return;
		const overlays = visibleRef.current ? overlayRects() : [];
		for (const paneId of paneIds) {
			const region = hostRef.current?.querySelector<HTMLElement>(`[data-pane-id="${paneId}"]`);
			const box = region?.getBoundingClientRect();
			const shown = visibleRef.current && box && box.width >= 1 && box.height >= 1 && !overlays.some((overlay) => intersects(overlay, box));
			const rect: Rect = shown && box ? { x: box.x, y: box.y, width: box.width, height: box.height } : HIDDEN;
			const key = `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`;
			if (lastReported.current.get(paneId) === key) continue;
			lastReported.current.set(paneId, key);
			void bridge.setSplitPaneBounds(paneId, rect).catch(() => {
				// The pane may have closed meanwhile; report again next time.
				lastReported.current.delete(paneId);
			});
		}
	}, [paneIds]);

	// Visibility flips (settings, search, page switch) apply before paint.
	useLayoutEffect(() => { report(); }, [report, visible]);

	useEffect(() => {
		if (!enabled || paneIds.length === 0) return;
		let frame = 0;
		const schedule = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(report);
		};
		// Mutations report at once (an opening dialog must not flash under a
		// pane) and again next frame, once the overlay has been positioned.
		const immediate = () => { report(); schedule(); };
		const resize = new ResizeObserver(schedule);
		if (hostRef.current) {
			resize.observe(hostRef.current);
			for (const region of Array.from(hostRef.current.querySelectorAll('[data-pane-id]'))) resize.observe(region);
		}
		const mutations = new MutationObserver(immediate);
		mutations.observe(document.body, { childList: true });
		mutations.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
		window.addEventListener('resize', schedule);
		return () => {
			cancelAnimationFrame(frame);
			resize.disconnect();
			mutations.disconnect();
			window.removeEventListener('resize', schedule);
		};
	}, [enabled, paneIds, report]);

	return { paneIds, hostRef };
}
