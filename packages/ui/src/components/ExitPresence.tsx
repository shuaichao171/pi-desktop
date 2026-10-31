import { useEffect, useRef, useState, type ReactNode } from 'react';

/** How long the frozen subtree stays mounted while the exit animation plays.
	Matches --pd-motion-fast, the exit budget shared by every surface. */
const EXIT_MS = 150;

/**
 * Delayed-unmount wrapper that plays a CSS exit animation on close.
 *
 * Callers convert `{cond && <X/>}` into
 * `<ExitPresence show={cond} surface="x-root-class">{cond && <X/>}</ExitPresence>`.
 * While `show` is true the children render exactly as before. When it flips
 * false the LAST rendered subtree stays mounted — React bails out on the
 * identical element references, so the DOM is untouched — while `is-closing`
 * is added to its root class and the CSS exit animation plays; after EXIT_MS
 * the subtree finally unmounts.
 *
 * `surface` names the root class of the wrapped surface instead of relying on
 * wrapper DOM, because most of these surfaces render through createPortal to
 * document.body and can never match a wrapper selector. Each surface class has
 * at most one live instance, so the lookup is unambiguous.
 */
export function ExitPresence({ show, surface, children }: { show: boolean; surface: string; children: ReactNode }) {
	const [render, setRender] = useState(show);
	// Latest rendered children, frozen during the exit window. Written during
	// render on purpose: the value must be current before the closing effect
	// runs, and rewrites are idempotent for identical shows.
	const frozen = useRef(show ? children : null);
	if (show) frozen.current = children;
	useEffect(() => {
		if (show) { setRender(true); return; }
		if (!frozen.current) { setRender(false); return; }
		const roots = Array.from(document.getElementsByClassName(surface));
		roots.forEach((element) => element.classList.add('is-closing'));
		const timer = setTimeout(() => setRender(false), EXIT_MS);
		return () => {
			roots.forEach((element) => element.classList.remove('is-closing'));
			clearTimeout(timer);
		};
	}, [show, surface]);
	return render ? frozen.current : null;
}
