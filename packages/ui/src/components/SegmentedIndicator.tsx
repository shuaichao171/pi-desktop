import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import './shellMotion.css';

type Bounds = { left: number; top: number; width: number; height: number; animate: boolean };

/** Move only the selection surface; each button keeps its layout and hit target. */
export function SegmentedIndicator({ activeKey, children, className, label, as: Element = 'div' }: {
	activeKey: string;
	children: ReactNode;
	className: string;
	label: string;
	as?: 'div' | 'nav';
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [bounds, setBounds] = useState<Bounds | null>(null);
	const selectedKey = useRef(activeKey);
	selectedKey.current = activeKey;
	const measure = useRef((_animate: boolean) => {});

	useLayoutEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const buttons = [...container.querySelectorAll<HTMLElement>('[data-segment-key]')];
		const update = (animate = false) => {
			const selected = buttons.find((button) => button.dataset.segmentKey === selectedKey.current);
			if (!selected || selected.offsetWidth === 0 || selected.offsetHeight === 0) {
				setBounds(null);
				return;
			}
			// offset geometry is in local CSS pixels, so ancestor transforms and
			// browser zoom cannot displace the background from its button.
			const next = { left: selected.offsetLeft, top: selected.offsetTop, width: selected.offsetWidth, height: selected.offsetHeight };
			setBounds((previous) => previous && previous.left === next.left && previous.top === next.top && previous.width === next.width && previous.height === next.height
				? previous : { ...next, animate: animate && previous !== null });
		};
		measure.current = update;
		update();
		const remeasure = () => update();
		const observer = new ResizeObserver(remeasure);
		observer.observe(container);
		for (const button of buttons) observer.observe(button);
		window.addEventListener('resize', remeasure);
		return () => { observer.disconnect(); window.removeEventListener('resize', remeasure); measure.current = () => {}; };
	}, []);

	useLayoutEffect(() => { measure.current(true); }, [activeKey]);

	return <Element ref={containerRef} className={`${className} pd-segmented`} role={Element === 'div' ? 'group' : undefined} aria-label={label} data-indicator-ready={Boolean(bounds)}>
		{bounds && <span className="pd-segmented-indicator" aria-hidden="true" style={{ width: bounds.width, height: bounds.height, transform: `translate(${bounds.left}px, ${bounds.top}px)`, transition: bounds.animate ? undefined : 'none' }} />}
		{children}
	</Element>;
}
