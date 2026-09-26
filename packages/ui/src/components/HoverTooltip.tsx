import {
	cloneElement,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
	type ButtonHTMLAttributes,
	type ReactElement,
	type ReactNode,
	type RefAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import './hoverTooltip.css';

export interface HoverTooltipProps {
	children: ReactElement;
	title: ReactNode;
	description?: ReactNode;
	shortcut?: string;
	disabled?: boolean;
	align?: 'start' | 'center' | 'end';
	side?: 'top' | 'right';
}

type TriggerProps = ButtonHTMLAttributes<HTMLButtonElement> & RefAttributes<HTMLButtonElement>;
type TooltipPosition = { left: number; top: number; side: 'top' | 'bottom' | 'right'; zIndex: number };

const VIEWPORT_PADDING = 8;
const TRIGGER_GAP = 6;
const TOOLTIP_OPEN_EVENT = 'pd:hover-tooltip-open';
const CLOSE_DELAY = 180;
const interactivePopoverOpen = () => [...document.querySelectorAll<HTMLElement>('.pd-sidebar-popover, .pd-composer-config-popover, .pd-search-dialog')].some(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');

/** A layout-neutral hint for a native button, including aria-disabled buttons. */
export function HoverTooltip({ children, title, description, shortcut, disabled = false, align = 'center', side: preferredSide = 'top' }: HoverTooltipProps) {
	const trigger = children as ReactElement<TriggerProps>;
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const tooltipRef = useRef<HTMLDivElement | null>(null);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pointerInTrigger = useRef(false);
	const pointerInTooltip = useRef(false);
	const selectionPointer = useRef<number | null>(null);
	const tooltipId = useId();
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState<TooltipPosition | null>(null);
	const visible = open && !disabled;
	const originalRef = trigger.props.ref;

	const composedRef = useCallback((element: HTMLButtonElement | null) => {
		triggerRef.current = element;
		const cleanup = typeof originalRef === 'function' ? originalRef(element) : undefined;
		if (originalRef && typeof originalRef !== 'function') originalRef.current = element;
		return () => {
			triggerRef.current = null;
			if (typeof cleanup === 'function') cleanup();
			else if (typeof originalRef === 'function') originalRef(null);
			else if (originalRef) originalRef.current = null;
		};
	}, [originalRef]);

	const clearCloseTimer = useCallback(() => {
		if (closeTimer.current !== null) clearTimeout(closeTimer.current);
		closeTimer.current = null;
	}, []);

	const close = useCallback(() => {
		clearCloseTimer();
		selectionPointer.current = null;
		pointerInTrigger.current = false;
		pointerInTooltip.current = false;
		setOpen(false);
		setPosition(null);
	}, [clearCloseTimer]);

	const hasSelectedText = useCallback(() => {
		const selection = window.getSelection();
		return Boolean(selection && !selection.isCollapsed && (tooltipRef.current?.contains(selection.anchorNode) || tooltipRef.current?.contains(selection.focusNode)));
	}, []);

	const leave = useCallback(() => {
		clearCloseTimer();
		if (selectionPointer.current !== null) return;
		// Keep the hint reachable across its gap. Selected text stays available for
		// copying even when the drag ends just outside the hint.
		closeTimer.current = setTimeout(() => {
			if (!pointerInTrigger.current && !pointerInTooltip.current && selectionPointer.current === null && !hasSelectedText()) close();
		}, CLOSE_DELAY);
	}, [clearCloseTimer, close, hasSelectedText]);

	const show = useCallback(() => {
		clearCloseTimer();
		if (disabled || interactivePopoverOpen()) return;
		// Match a shared tooltip provider: moving between controls never stacks hints.
		// A hint being drag-selected may veto replacement until selection finishes.
		if (!window.dispatchEvent(new CustomEvent(TOOLTIP_OPEN_EVENT, { detail: tooltipId, cancelable: true }))) return;
		setOpen(true);
	}, [clearCloseTimer, disabled, tooltipId]);

	useEffect(() => clearCloseTimer, [clearCloseTimer]);
	useEffect(() => { if (disabled) close(); }, [disabled, close]);
	useEffect(() => {
		if (!visible) return;
		const observer = new MutationObserver(() => { if (interactivePopoverOpen()) close(); });
		observer.observe(document.body, { childList: true, subtree: true });
		return () => observer.disconnect();
	}, [visible, close]);

	useLayoutEffect(() => {
		if (!visible) return;
		const button = triggerRef.current;
		const hint = tooltipRef.current;
		if (!button || !hint) return;
		const place = () => {
			const rect = button.getBoundingClientRect();
			const width = document.documentElement.clientWidth;
			const height = document.documentElement.clientHeight;
			if (preferredSide === 'right') {
				const availableWidth = width - rect.right - TRIGGER_GAP - VIEWPORT_PADDING;
				// A sidebar hint must never fall back over the rows being browsed.
				// Hide it when the window cannot fit a readable hint beside the list.
				if (availableWidth < 120) { setPosition(null); return; }
				hint.style.setProperty('--pd-tooltip-available-width', `${availableWidth}px`);
			} else hint.style.removeProperty('--pd-tooltip-available-width');
			const bounds = hint.getBoundingClientRect();
			const roomAbove = rect.top - TRIGGER_GAP - VIEWPORT_PADDING;
			const roomBelow = height - rect.bottom - TRIGGER_GAP - VIEWPORT_PADDING;
			const side = preferredSide === 'right' ? 'right' : roomAbove >= bounds.height || roomAbove >= roomBelow ? 'top' : 'bottom';
			const preferredLeft = side === 'right' ? rect.right + TRIGGER_GAP : align === 'start' ? rect.left : align === 'end' ? rect.right - bounds.width : rect.left + (rect.width - bounds.width) / 2;
			const preferredTop = side === 'right'
				? align === 'start' ? rect.top : align === 'end' ? rect.bottom - bounds.height : rect.top + (rect.height - bounds.height) / 2
				: side === 'top' ? rect.top - bounds.height - TRIGGER_GAP : rect.bottom + TRIGGER_GAP;
			const left = side === 'right' ? preferredLeft : Math.max(VIEWPORT_PADDING, Math.min(preferredLeft, width - bounds.width - VIEWPORT_PADDING));
			const top = Math.max(VIEWPORT_PADDING, Math.min(preferredTop, height - bounds.height - VIEWPORT_PADDING));
			// Hints inside a picker must sit above that picker; ordinary composer hints
			// retain their low layer so they cannot cover settings or search dialogs.
			let zIndex = 20;
			for (let ancestor: HTMLElement | null = button; ancestor; ancestor = ancestor.parentElement) {
				const layer = Number.parseInt(window.getComputedStyle(ancestor).zIndex, 10);
				if (Number.isFinite(layer)) zIndex = Math.max(zIndex, layer + 1);
			}
			setPosition((current) => current?.left === left && current.top === top && current.side === side && current.zIndex === zIndex ? current : { left, top, side, zIndex });
		};
		place();
		const observer = new ResizeObserver(place);
		observer.observe(button);
		observer.observe(hint);
		window.addEventListener('resize', place);
		window.addEventListener('scroll', place, true);
		const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
		const onOtherTooltip = (event: Event) => {
			if ((event as CustomEvent<string>).detail === tooltipId) return;
			if (selectionPointer.current !== null || hasSelectedText()) event.preventDefault();
			else close();
		};
		const onSelectionChange = () => {
			if (hasSelectedText()) clearCloseTimer();
			else if (!pointerInTrigger.current && !pointerInTooltip.current) leave();
		};
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (target instanceof Node && (button.contains(target) || hint.contains(target))) return;
			close();
		};
		const onPointerUp = (event: PointerEvent) => {
			if (selectionPointer.current !== event.pointerId) return;
			selectionPointer.current = null;
			// A drag may cross other controls or capture events; check its actual endpoint.
			const target = document.elementFromPoint(event.clientX, event.clientY);
			pointerInTrigger.current = target !== null && button.contains(target);
			pointerInTooltip.current = target !== null && hint.contains(target);
			leave();
		};
		const onPointerCancel = (event: PointerEvent) => { if (selectionPointer.current === event.pointerId) close(); };
		window.addEventListener('keydown', onKeyDown);
		window.addEventListener(TOOLTIP_OPEN_EVENT, onOtherTooltip);
		window.addEventListener('pointerdown', onPointerDown, true);
		window.addEventListener('pointerup', onPointerUp, true);
		window.addEventListener('pointercancel', onPointerCancel, true);
		window.addEventListener('blur', close);
		document.addEventListener('selectionchange', onSelectionChange);
		return () => {
			observer.disconnect();
			window.removeEventListener('resize', place);
			window.removeEventListener('scroll', place, true);
			window.removeEventListener('keydown', onKeyDown);
			window.removeEventListener(TOOLTIP_OPEN_EVENT, onOtherTooltip);
			window.removeEventListener('pointerdown', onPointerDown, true);
			window.removeEventListener('pointerup', onPointerUp, true);
			window.removeEventListener('pointercancel', onPointerCancel, true);
			window.removeEventListener('blur', close);
			document.removeEventListener('selectionchange', onSelectionChange);
		};
	}, [visible, align, preferredSide, close, leave, clearCloseTimer, hasSelectedText, title, description, shortcut, tooltipId]);

	return <>
		{cloneElement(trigger, {
			ref: composedRef,
			// The custom tooltip replaces the browser's delayed native title bubble.
			title: undefined,
			'aria-describedby': [trigger.props['aria-describedby'], visible ? tooltipId : undefined].filter(Boolean).join(' ') || undefined,
			onPointerEnter: (event) => {
				trigger.props.onPointerEnter?.(event);
				if (!event.defaultPrevented && event.pointerType !== 'touch') {
					pointerInTrigger.current = true;
					show();
				}
			},
			onPointerLeave: (event) => { trigger.props.onPointerLeave?.(event); pointerInTrigger.current = false; leave(); },
			onPointerCancel: (event) => { trigger.props.onPointerCancel?.(event); close(); },
			onFocus: (event) => { trigger.props.onFocus?.(event); if (!event.defaultPrevented) show(); },
			onBlur: (event) => {
				trigger.props.onBlur?.(event);
				// Clicking selectable text blurs its trigger without moving focus to a field.
				if (event.relatedTarget && !tooltipRef.current?.contains(event.relatedTarget)) close();
				else if (!pointerInTooltip.current && selectionPointer.current === null) close();
			},
			onClick: (event) => { close(); trigger.props.onClick?.(event); },
			onKeyDown: (event) => { if (event.key === 'Escape') close(); trigger.props.onKeyDown?.(event); },
		})}
		{visible && typeof document !== 'undefined' && createPortal(
			<div
				ref={tooltipRef}
				id={tooltipId}
				role="tooltip"
				className={`pd-hover-tooltip${description != null ? ' has-description' : ''}`}
				data-side={position?.side ?? preferredSide}
				style={{ left: position?.left ?? 0, top: position?.top ?? 0, zIndex: position?.zIndex, visibility: position ? 'visible' : 'hidden' }}
				onPointerEnter={() => { pointerInTooltip.current = true; clearCloseTimer(); }}
				onPointerLeave={() => { pointerInTooltip.current = false; leave(); }}
				onFocus={(event) => event.stopPropagation()}
				onClick={(event) => event.stopPropagation()}
				onPointerDown={(event) => {
					// Portaled hints still belong to their picker. Do not let an owner's
					// document outside-click listener unmount selectable text mid-drag.
					event.stopPropagation();
					if (event.button !== 0) return;
					selectionPointer.current = event.pointerId;
					clearCloseTimer();
				}}
			>
				<div className="pd-hover-tooltip-heading">
					<span className="pd-hover-tooltip-title">{title}</span>
					{shortcut && <kbd className="pd-hover-tooltip-shortcut">{shortcut}</kbd>}
				</div>
				{description != null && <div className="pd-hover-tooltip-description">{description}</div>}
			</div>, document.body,
		)}
	</>;
}
