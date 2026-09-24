import { useLayoutEffect, useRef, type ReactNode } from 'react';
import '../transcript.css';

/** Keep the subtree mounted so live updates never reset the reader's controls. */
export function ActivityDisclosure({ id, expanded, children }: { id: string; expanded: boolean; children: ReactNode }) {
	const contentRef = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		if (expanded || !contentRef.current?.contains(document.activeElement)) return;
		// Completion may collapse an untouched disclosure with focus in its content.
		document.querySelector<HTMLButtonElement>('button[aria-controls="' + CSS.escape(id) + '"]')?.focus();
	}, [expanded, id]);
	return (
		<div className={'pd-activity-disclosure' + (expanded ? ' is-expanded' : '')} id={id} aria-hidden={!expanded} inert={!expanded}>
			<div className="pd-activity-disclosure-inner" ref={contentRef}>{children}</div>
		</div>
	);
}

export function ActivityLabel({ active = false, children }: { active?: boolean; children: ReactNode }) {
	return <span className={'pd-activity-label' + (active ? ' is-active' : '')}>{children}</span>;
}
