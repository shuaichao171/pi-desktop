import { useT } from '../i18n';
import { Icon } from './Icons';
import { HoverTooltip } from './HoverTooltip';
import { HistoryNavigation, type HistoryNavigationProps } from './HistoryNavigation';
import { SearchButton } from './SearchButton';
import { ChatTitle, type ChatTitleHandle } from './ChatTitle';
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
	titleRef: RefObject<ChatTitleHandle | null>;
	onOpenCommit(): void;
	isWindows: boolean;
	workbenchOpen: boolean;
	onToggleWorkbench(): void;
	workbenchToggleRef: RefObject<HTMLButtonElement | null>;
}

/** Window-wide VS Code-style title bar. It owns app navigation and the current session title. */
export function TopBar({ history, searchOpen, onOpenSearch, mainView, title, sessionPath, cwd, titleRef, onOpenCommit, isWindows, workbenchOpen, onToggleWorkbench, workbenchToggleRef }: TopBarProps) {
	const { t } = useT();
	return (
		<header className="pd-top-bar" aria-label={t('sidebar.main')}>
			<span className="pd-brand-mark" aria-hidden="true">π</span>
			<div className="pd-top-bar-navigation">
				<HistoryNavigation {...history} />
				<SearchButton open={searchOpen} onClick={onOpenSearch} />
			</div>
			{mainView === 'chat' && <div className="pd-top-bar-session">
				<ChatTitle ref={titleRef} title={title} sessionPath={sessionPath} />
				<div className="pd-top-bar-workspace-actions">
					<WorkspaceOpenButton cwd={cwd} />
					<HoverTooltip title={t(workbenchOpen ? 'app.closeWorkbench' : 'app.openWorkbench')}>
						<button ref={workbenchToggleRef} type="button" className={`pd-top-bar-workspace-button${workbenchOpen ? ' is-active' : ''}`} aria-label={t(workbenchOpen ? 'app.closeWorkbench' : 'app.openWorkbench')} aria-pressed={workbenchOpen} onClick={onToggleWorkbench}><Icon name="panelRight" width="17" height="17" /></button>
					</HoverTooltip>
				</div>
					<ChatHeaderMenu title={title} sessionPath={sessionPath} cwd={cwd} onRename={() => titleRef.current?.beginRename()} onOpenCommit={onOpenCommit} />
			</div>}
			<div className="pd-top-bar-actions">{isWindows && <WindowControls inline />}</div>
		</header>
	);
}
