import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// Popovers mark the <html> element so drag regions (frameless title areas)
// can stop swallowing mouse events while a menu is open — otherwise clicks
// on the header never reach the outside-press handler that closes it.
let openPopoverCount = 0;

/** A measured, keyboard-accessible menu shared by the sidebar controls. */
export function SidebarPopover({ anchor, label, dialog = false, placement = 'bottom', children, onClose }: {
	anchor: HTMLElement; label: string; dialog?: boolean; placement?: 'bottom' | 'top'; children: ReactNode; onClose(): void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;

	useEffect(() => {
		openPopoverCount += 1;
		document.documentElement.classList.add('pd-popover-open');
		return () => {
			openPopoverCount -= 1;
			if (openPopoverCount === 0) document.documentElement.classList.remove('pd-popover-open');
		};
	}, []);
	const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
	useLayoutEffect(() => {
		const menu = ref.current;
		if (!menu) return;
		const place = () => {
			const rect = anchor.getBoundingClientRect();
			const box = menu.getBoundingClientRect();
			const next = {
				left: Math.max(8, Math.min(rect.right - box.width, window.innerWidth - box.width - 8)),
				top: placement === 'top'
					? Math.max(8, Math.min(rect.top - box.height - 5, window.innerHeight - box.height - 8))
					: Math.max(8, Math.min(rect.bottom + 5, window.innerHeight - box.height - 8)),
			};
			setPosition((old) => old?.top === next.top && old.left === next.left ? old : next);
		};
		place();
		const observer = new ResizeObserver(place);
		observer.observe(menu);
		window.addEventListener('resize', place);
		return () => { observer.disconnect(); window.removeEventListener('resize', place); };
	}, [anchor, placement]);
	const positioned = position !== null;
	useLayoutEffect(() => {
		if (positioned) ref.current?.querySelector<HTMLElement>('input, button:not(:disabled)')?.focus();
	}, [positioned]);
	useEffect(() => {
		const outside = (event: Event) => {
			const target = event.target as Node;
			if (!ref.current?.contains(target) && !anchor.contains(target)) closeRef.current();
		};
		document.addEventListener('pointerdown', outside);
		document.addEventListener('focusin', outside);
		return () => {
			document.removeEventListener('pointerdown', outside);
			document.removeEventListener('focusin', outside);
			queueMicrotask(() => {
				// Keep a newly mounted editor's focus; otherwise restore keyboard
				// navigation after an action unmounts this portal.
				if (document.activeElement !== document.body) return;
				const available = (element: HTMLElement) => !element.closest('[inert]') && element.getClientRects().length > 0;
				if (anchor.isConnected && available(anchor)) { anchor.focus(); return; }
				[...document.querySelectorAll<HTMLButtonElement>('.pd-sidebar-mode [aria-selected="true"], .pd-new-session, .pd-header-sidebar-toggle')].find(available)?.focus();
			});
		};
	}, [anchor]);
	return createPortal(<div ref={ref} className={`pd-sidebar-popover${dialog ? ' is-form' : ''}`} role={dialog ? 'dialog' : 'menu'} aria-label={label}
		style={{ ...position, visibility: positioned ? 'visible' : 'hidden' }} onKeyDown={(event) => {
			if (event.nativeEvent.isComposing) return;
			if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); anchor.focus(); return; }
			if (dialog || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
			event.preventDefault();
			const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
			const index = items.indexOf(document.activeElement as HTMLButtonElement);
			const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
			items[next]?.focus();
		}}>{children}</div>, document.body);
}
