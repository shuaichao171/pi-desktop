import { useT } from '../i18n';
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
}

/** Window-wide VS Code-style title bar. It owns app navigation and the current session title. */
export function TopBar({ history, searchOpen, onOpenSearch, mainView, title, sessionPath, cwd, titleRef, onOpenCommit, isWindows }: TopBarProps) {
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
				<ChatHeaderMenu title={title} sessionPath={sessionPath} cwd={cwd} onRename={() => titleRef.current?.beginRename()} onOpenCommit={onOpenCommit} />
				<WorkspaceOpenButton cwd={cwd} />
			</div>}
			<div className="pd-top-bar-actions">{isWindows && <WindowControls inline />}</div>
		</header>
	);
}
