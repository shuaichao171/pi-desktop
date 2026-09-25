import type { ReactNode, SVGProps } from 'react';

type IconName =
	| 'panel'
	| 'folder'
	| 'plus'
	| 'refresh'
	| 'update'
	| 'queue'
	| 'steer'
	| 'message'
	| 'arrowUp'
	| 'arrowDown'
	| 'arrowLeft'
	| 'arrowRight'
	| 'square'
	| 'spark'
	| 'brain'
	| 'clock'
	| 'automation'
	| 'plugins'
	| 'search'
	| 'close'
	| 'sort'
	| 'settings'
	| 'minimize'
	| 'maximize'
	| 'restore'
	| 'chevronRight'
	| 'chevronDown'
	| 'more'
	| 'archive'
	| 'panelRight'
	| 'file'
	| 'gitBranch'
	| 'terminal'
	| 'hash'
	| 'filter'
	| 'expandAll'
	| 'collapseAll'
	| 'check'
	| 'pin';

const paths: Record<IconName, ReactNode> = {
	hash: <path d="m10 3-4 18M18 3l-4 18M4 9h17M3 15h17" />,
	filter: <path d="M4 6h16M7 12h10M10 18h4" />,
	expandAll: <><path d="M8 3H3v5M3 3l6 6M16 21h5v-5M21 21l-6-6" /></>,
	collapseAll: <><path d="M3 9h6V3M9 9 3 3M21 15h-6v6M15 15l6 6" /></>,
	check: <path d="m5 12 4 4L19 6" />,
	pin: <><path d="m15 3 6 6-3 1-4 4v3l-2 2-7-7 2-2h3l4-4 1-3ZM8 16l-5 5" /></>,
	panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
	folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
	plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
	refresh: <><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M5.9 9a7 7 0 0 1 12.1-2L20 12M4 12l2 5a7 7 0 0 0 12.1-2" /></>,
	update: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" /></>,
	queue: <path d="M4 6h16M4 12h10M4 18h5m7-4 4 4-4 4m-4-4h8" />,
	steer: <path d="M4 20v-8a4 4 0 0 1 4-4h12m-5-5 5 5-5 5" />,
	message: <path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-9.5A7.5 7.5 0 0 1 10.5 4h2A7.5 7.5 0 0 1 20 11.5Z" />,
	arrowUp: <><path d="M12 19V5" /><path d="m6 11 6-6 6 6" /></>,
	arrowDown: <><path d="M12 5v14" /><path d="m6 13 6 6 6-6" /></>,
	arrowLeft: <><path d="M19 12H5" /><path d="m11 6-6 6 6 6" /></>,
	arrowRight: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
	square: <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />,
	spark: <><path d="m12 3 1.9 6.1L20 11l-6.1 1.9L12 19l-1.9-6.1L4 11l6.1-1.9Z" /><path d="m19 17 .5 1.5L21 19l-1.5.5L19 21l-.5-1.5L17 19l1.5-.5Z" /></>,
	brain: <><path d="M12 18V5a3 3 0 0 0-5.8-1A4 4 0 0 0 3 10a4 4 0 0 0 .5 7A4 4 0 0 0 12 18ZM12 5a3 3 0 0 1 5.8-1A4 4 0 0 1 21 10a4 4 0 0 1-.5 7A4 4 0 0 1 12 18" /><path d="M8 8a3 3 0 0 1-2 3M16 8a3 3 0 0 0 2 3M8 16a3 3 0 0 0-2-2M16 16a3 3 0 0 1 2-2" /></>,
	clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
	automation: <path d="m13 2-10 12h8l-1 8 11-12h-8l1-8Z" />,
	plugins: <path d="M9 5V3a2 2 0 0 1 4 0v2h6a1 1 0 0 1 1 1v4h-2a2 2 0 0 0 0 4h2v5a1 1 0 0 1-1 1h-5v-2a2 2 0 0 0-4 0v2H5a1 1 0 0 1-1-1v-5H3a2 2 0 0 1 0-4h1V6a1 1 0 0 1 1-1Z" />,
	search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></>,
	close: <><path d="M5 5 19 19M19 5 5 19" /></>,
	sort: <><path d="M4 7h16M7 12h10M10 17h4" /></>,
	settings: <><path d="M10 2h4l.6 2.4 1.7.7 2.1-1.3 2.8 2.8-1.3 2.1.7 1.7L23 11v2l-2.4.6-.7 1.7 1.3 2.1-2.8 2.8-2.1-1.3-1.7.7L14 22h-4l-.6-2.4-1.7-.7-2.1 1.3-2.8-2.8 1.3-2.1-.7-1.7L1 13v-2l2.4-.6.7-1.7-1.3-2.1 2.8-2.8 2.1 1.3 1.7-.7L10 2Z" /><circle cx="12" cy="12" r="3" /></>,
	minimize: <path d="M5 12h14" />,
	maximize: <rect x="5" y="5" width="14" height="14" rx="1" />,
	restore: <><path d="M8 6V4h12v12h-2" /><rect x="4" y="8" width="12" height="12" rx="1" /></>,
	chevronRight: <path d="m9 5 7 7-7 7" />,
	chevronDown: <path d="m5 9 7 7 7-7" />,
	more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></>,
	archive: <><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" /></>,
	panelRight: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>,
	file: <><path d="M6 3h8l4 4v14H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M14 3v5h5" /></>,
	gitBranch: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="7" r="2" /><path d="M6 7v10M18 9a8 8 0 0 1-8 8H8" /></>,
	terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M12 15h5" /></>,
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
