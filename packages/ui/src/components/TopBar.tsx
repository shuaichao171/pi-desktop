import { useT } from '../i18n';
import { Icon } from './Icons';
import { HoverTooltip } from './HoverTooltip';
import { HistoryNavigation, type HistoryNavigationProps } from './HistoryNavigation';
import { SearchButton } from './SearchButton';
import { ChatHeaderMenu } from './ChatHeaderMenu';
import { WorkspaceOpenButton } from './WorkspaceOpenButton';
import { WindowControls } from './WindowControls';
import type { RefObject } from 'react';

interface TopBarProps {
	history: HistoryNavigationProps;
	searchOpen: boolean;
	onOpenSearch(): void;
	mainView: 'chat' | 'automations' | 'plugins';
	title: string;
	sessionPath: string | null;
	cwd: string;
	onOpenCommit(): void;
	isWindows: boolean;
	workbenchOpen: boolean;
	onToggleWorkbench(): void;
	workbenchToggleRef: RefObject<HTMLButtonElement | null>;
}

/** Window-wide VS Code-style title bar. It owns app navigation and the current session title. */
export function TopBar({ history, searchOpen, onOpenSearch, mainView, title, sessionPath, cwd, onOpenCommit, isWindows, workbenchOpen, onToggleWorkbench, workbenchToggleRef }: TopBarProps) {
	const { t } = useT();
	return (
		<header className="pd-top-bar" aria-label={t('sidebar.main')}>
			{/* Brand tile: same art as the packaged icon (deep-navy gradient tile, cyan-gradient π mark, orange dot). */}
			<svg className="pd-brand-mark" viewBox="0 0 224 224" aria-hidden="true" focusable="false">
				<defs>
					<linearGradient id="pd-brand-bg" x1="0" x2="1" y1="0" y2="1">
						<stop stop-color="#343081"/><stop offset="1" stop-color="#171729"/>
					</linearGradient>
					<linearGradient id="pd-brand-fill" x1="0" x2="1" y1="0" y2="1">
						<stop stop-color="#a4fff0"/><stop offset="1" stop-color="#60ddf4"/>
					</linearGradient>
				</defs>
				<rect x="4" y="4" width="216" height="216" rx="48" fill="url(#pd-brand-bg)"/>
				<rect x="4.5" y="4.5" width="215" height="215" rx="47.5" fill="none" stroke="#7774b0" stroke-width="1"/>
				<path d="M52 72h120v24H52zM68 92h24v76c0 12-8 20-20 20h-4V92zm72 0h24v76c0 12-8 20-20 20h-4V92z" fill="url(#pd-brand-fill)"/>
				<circle cx="168" cy="164" r="12" fill="#ffb36a"/>
			</svg>
			<div className="pd-top-bar-navigation">
				<HistoryNavigation {...history} />
				<SearchButton open={searchOpen} onClick={onOpenSearch} />
			</div>
			{/* The session row stays mounted on every main view: the capsule slot
				reserves its footprint so the title never shifts when the capsule
				hides on the automations/plugins pages. */}
			<div className="pd-top-bar-session">
				<div className="pd-workspace-open-slot">{mainView === 'chat' && <WorkspaceOpenButton cwd={cwd} />}</div>
				{mainView === 'chat' && <>
					<div className="pd-top-bar-workspace-actions">
						<HoverTooltip title={t(workbenchOpen ? 'app.closeWorkbench' : 'app.openWorkbench')}>
							<button ref={workbenchToggleRef} type="button" className={`pd-top-bar-workspace-button${workbenchOpen ? ' is-active' : ''}`} aria-label={t(workbenchOpen ? 'app.closeWorkbench' : 'app.openWorkbench')} aria-pressed={workbenchOpen} onClick={onToggleWorkbench}><Icon name="panelRight" width="16" height="16" /></button>
						</HoverTooltip>
					</div>
					<ChatHeaderMenu title={title} sessionPath={sessionPath} cwd={cwd} onOpenCommit={onOpenCommit} />
				</>}
			</div>
			{/* Extension slot: views contributed by plugins render here, left of the divider. */}
			<div className="pd-top-bar-extensions" data-extension-slot="top-bar" />
			<div className="pd-top-bar-divider" aria-hidden="true" />
			<div className="pd-top-bar-actions">{isWindows && <WindowControls inline />}</div>
		</header>
	);
}
