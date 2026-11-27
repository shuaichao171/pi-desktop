import { useT } from '../i18n';
import { Icon } from './Icons';
import { HoverTooltip } from './HoverTooltip';
import { HistoryNavigation, type HistoryNavigationProps } from './HistoryNavigation';
import { SearchButton } from './SearchButton';
import { ChatHeaderMenu } from './ChatHeaderMenu';
import { WindowControls } from './WindowControls';
import type { RefObject } from 'react';

interface TopBarProps {
	history: HistoryNavigationProps;
	searchOpen: boolean;
	searchButtonRef: RefObject<HTMLButtonElement | null>;
	onOpenSearch(): void;
	mainView: 'chat' | 'automations' | 'plugins' | 'remote';
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
export function TopBar({ history, searchOpen, searchButtonRef, onOpenSearch, mainView, title, sessionPath, cwd, onOpenCommit, isWindows, workbenchOpen, onToggleWorkbench, workbenchToggleRef }: TopBarProps) {
	const { t } = useT();
	return (
		<header className="pd-top-bar" aria-label={t('sidebar.main')}>
			{/* Brand tile: the packaged app icon itself, synced from packages/desktop/build/icon.png
			    by scripts/sync-renderer-icon.mjs into the renderer public dir. */}
			<img className="pd-brand-mark" src="./icon.png" alt="" aria-hidden="true" draggable={false} />
			<div className="pd-top-bar-navigation">
				<HistoryNavigation {...history} />
				<SearchButton open={searchOpen} buttonRef={searchButtonRef} onClick={onOpenSearch} />
			</div>
			<div className="pd-top-bar-session">
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
