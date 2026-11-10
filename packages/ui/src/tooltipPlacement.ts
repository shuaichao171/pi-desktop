export const TOOLTIP_VIEWPORT_PADDING = 8;
export const TOOLTIP_TRIGGER_GAP = 6;
/** Below this width a right-side hint is unreadable; it hides instead of covering the rows being browsed. */
export const TOOLTIP_MIN_RIGHT_WIDTH = 120;

export interface TooltipRect { left: number; top: number; right: number; bottom: number; width: number; height: number }

export interface TooltipPlacementInput {
	trigger: TooltipRect;
	hint: { width: number; height: number };
	viewport: { width: number; height: number };
	side: 'top' | 'right';
	align: 'start' | 'center' | 'end';
	/**
	 * Right edge of the list a right-side hint belongs to (e.g. the sidebar). Row action buttons
	 * sit side by side, so anchoring at the trigger's own edge would cover the next button
	 * (project "new chat" hides the project menu, "pin" hides "archive"). The hint therefore
	 * starts past the whole rail and never overlaps any sibling control in the row.
	 */
	railRight?: number;
}

export interface TooltipPlacement { left: number; top: number; side: 'top' | 'bottom' | 'right'; availableWidth?: number }

/** Pure placement so it can be regression-tested without a DOM. Returns null when a right-side hint cannot fit. */
export function placeTooltip({ trigger, hint, viewport, side: preferredSide, align, railRight }: TooltipPlacementInput): TooltipPlacement | null {
	if (preferredSide === 'right') {
		const anchor = Math.max(trigger.right, railRight ?? trigger.right) + TOOLTIP_TRIGGER_GAP;
		const availableWidth = viewport.width - anchor - TOOLTIP_VIEWPORT_PADDING;
		if (availableWidth < TOOLTIP_MIN_RIGHT_WIDTH) return null;
		const preferredTop = align === 'start' ? trigger.top : align === 'end' ? trigger.bottom - hint.height : trigger.top + (trigger.height - hint.height) / 2;
		const top = Math.max(TOOLTIP_VIEWPORT_PADDING, Math.min(preferredTop, viewport.height - hint.height - TOOLTIP_VIEWPORT_PADDING));
		return { left: anchor, top, side: 'right', availableWidth };
	}
	const roomAbove = trigger.top - TOOLTIP_TRIGGER_GAP - TOOLTIP_VIEWPORT_PADDING;
	const roomBelow = viewport.height - trigger.bottom - TOOLTIP_TRIGGER_GAP - TOOLTIP_VIEWPORT_PADDING;
	const side = roomAbove >= hint.height || roomAbove >= roomBelow ? 'top' : 'bottom';
	const preferredLeft = align === 'start' ? trigger.left : align === 'end' ? trigger.right - hint.width : trigger.left + (trigger.width - hint.width) / 2;
	const preferredTop = side === 'top' ? trigger.top - hint.height - TOOLTIP_TRIGGER_GAP : trigger.bottom + TOOLTIP_TRIGGER_GAP;
	const left = Math.max(TOOLTIP_VIEWPORT_PADDING, Math.min(preferredLeft, viewport.width - hint.width - TOOLTIP_VIEWPORT_PADDING));
	const top = Math.max(TOOLTIP_VIEWPORT_PADDING, Math.min(preferredTop, viewport.height - hint.height - TOOLTIP_VIEWPORT_PADDING));
	return { left, top, side };
}

/** Closest container whose right edge a right-side hint must clear. */
export const TOOLTIP_RAIL_SELECTOR = '[data-tooltip-rail], .pd-sidebar';
