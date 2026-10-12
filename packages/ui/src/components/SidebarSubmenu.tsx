import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * A flyout that opens beside a row of a SidebarPopover menu ("Open in ›").
 * It is portaled to <body> because the parent menu scrolls and animates, which
 * would clip or offset a nested fixed element; SidebarPopover treats clicks and
 * focus inside `.pd-sidebar-submenu` as part of the menu.
 */
export function SidebarSubmenu({ anchor, label, autoFocus, children, onClose, onPointerEnter }: {
	/** The row that opened the flyout; it is aligned to this row and regains focus on close. */
	anchor: HTMLElement;
	label: string;
	/** Keyboard opening moves focus into the flyout; hovering leaves focus on the row. */
	autoFocus: boolean;
	children: ReactNode;
	onClose(restoreFocus: boolean): void;
	onPointerEnter?(): void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
	useLayoutEffect(() => {
		const menu = ref.current;
		if (!menu) return;
		const row = anchor.getBoundingClientRect();
		const parent = (anchor.closest('.pd-sidebar-popover') ?? anchor).getBoundingClientRect();
		const box = menu.getBoundingClientRect();
		// Open to the right of the parent menu; flip left when the window edge is near.
		const right = parent.right + 4;
		const left = right + box.width <= window.innerWidth - 8 ? right : Math.max(8, parent.left - box.width - 4);
		const top = Math.max(8, Math.min(row.top - 5, window.innerHeight - box.height - 8));
		setPosition((old) => old?.left === left && old.top === top ? old : { left, top });
	}, [anchor, children]);
	useLayoutEffect(() => {
		if (position && autoFocus) ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
	}, [position !== null, autoFocus]);
	return createPortal(<div ref={ref} className="pd-sidebar-popover pd-sidebar-submenu" role="menu" aria-label={label}
		style={{ ...position, visibility: position ? 'visible' : 'hidden' }}
		onPointerEnter={onPointerEnter}
		onKeyDown={(event) => {
			if (event.nativeEvent.isComposing) return;
			const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
			if (event.key === 'ArrowLeft' || event.key === 'Escape') {
				// Only this flyout closes; the parent menu stays open on its row.
				event.preventDefault(); event.stopPropagation();
				onClose(true);
				return;
			}
			if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
				event.preventDefault(); event.stopPropagation();
				const index = items.indexOf(document.activeElement as HTMLButtonElement);
				const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
				items[next]?.focus();
				return;
			}
			if (/^[1-9]$/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
				const target = items.find((item) => item.dataset.shortcut === event.key);
				event.preventDefault(); event.stopPropagation();
				target?.click();
			}
		}}>{children}</div>, document.body);
}
