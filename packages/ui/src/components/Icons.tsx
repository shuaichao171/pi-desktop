import type { ReactNode, SVGProps } from 'react';

type IconName =
	| 'panel'
	| 'folder'
	| 'plus'
	| 'refresh'
	| 'message'
	| 'arrowUp'
	| 'square'
	| 'spark'
	| 'clock'
	| 'search'
	| 'close'
	| 'sort'
	| 'settings'
	| 'minimize'
	| 'maximize'
	| 'restore'
	| 'chevronRight'
	| 'chevronDown';

const paths: Record<IconName, ReactNode> = {
	panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
	folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
	plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
	refresh: <><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M5.9 9a7 7 0 0 1 12.1-2L20 12M4 12l2 5a7 7 0 0 0 12.1-2" /></>,
	message: <path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-9.5A7.5 7.5 0 0 1 10.5 4h2A7.5 7.5 0 0 1 20 11.5Z" />,
	arrowUp: <><path d="M12 19V5" /><path d="m6 11 6-6 6 6" /></>,
	square: <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />,
	spark: <><path d="m12 3 1.9 6.1L20 11l-6.1 1.9L12 19l-1.9-6.1L4 11l6.1-1.9Z" /><path d="m19 17 .5 1.5L21 19l-1.5.5L19 21l-.5-1.5L17 19l1.5-.5Z" /></>,
	clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
	search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></>,
	close: <><path d="M5 5 19 19M19 5 5 19" /></>,
	sort: <><path d="M4 7h16M7 12h10M10 17h4" /></>,
	settings: <><path d="M10 2h4l.6 2.4 1.7.7 2.1-1.3 2.8 2.8-1.3 2.1.7 1.7L23 11v2l-2.4.6-.7 1.7 1.3 2.1-2.8 2.8-2.1-1.3-1.7.7L14 22h-4l-.6-2.4-1.7-.7-2.1 1.3-2.8-2.8 1.3-2.1-.7-1.7L1 13v-2l2.4-.6.7-1.7-1.3-2.1 2.8-2.8 2.1 1.3 1.7-.7L10 2Z" /><circle cx="12" cy="12" r="3" /></>,
	minimize: <path d="M5 12h14" />,
	maximize: <rect x="5" y="5" width="14" height="14" rx="1" />,
	restore: <><path d="M8 6V4h12v12h-2" /><rect x="4" y="8" width="12" height="12" rx="1" /></>,
	chevronRight: <path d="m9 5 7 7-7 7" />,
	chevronDown: <path d="m5 9 7 7 7-7" />,
};

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
	return (
		<svg
			viewBox="0 0 24 24"
			width="18"
			height="18"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.7"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			{...props}
		>
			{paths[name]}
		</svg>
	);
}
