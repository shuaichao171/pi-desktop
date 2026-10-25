import { useChatStore } from '../store';
import { useT } from '../i18n';
import { Icon } from './Icons';
import { HoverTooltip } from './HoverTooltip';
import { HistoryNavigation, type HistoryNavigationProps } from './HistoryNavigation';
import { SearchButton } from './SearchButton';

interface TopBarProps {
	history: HistoryNavigationProps;
	searchOpen: boolean;
	onOpenSearch(): void;
	/** Collapses/expands the sidebar pane (Ctrl+B twin). The rail is always visible. */
	sidebarOpen: boolean;
	onToggleSidebar(): void;
}

/**
 * Window-wide top bar: brand mark leftmost, history navigation, search, and
 * the sidebar toggle on the right. Replaces the sidebar's old brand row so the
 * chrome stays reachable even when the sidebar pane is collapsed.
 */
export function TopBar({ history, searchOpen, onOpenSearch, sidebarOpen, onToggleSidebar }: TopBarProps) {
	const { t } = useT();
	const platform = useChatStore((s) => s.appInfo?.platform);
	return (
		<header className="pd-top-bar" aria-label={t('sidebar.main')}>
			<span className="pd-brand-mark" aria-hidden="true">π</span>
			<div className="pd-top-bar-navigation">
				<HistoryNavigation {...history} />
				<SearchButton open={searchOpen} onClick={onOpenSearch} />
			</div>
			<div className="pd-top-bar-actions">
				<HoverTooltip title={t(sidebarOpen ? 'sidebar.collapse' : 'sidebar.expand')} shortcut={platform === 'darwin' ? '⌘B' : 'Ctrl+B'}>
					<button type="button" className="pd-icon-button pd-sidebar-collapse" onClick={onToggleSidebar} aria-label={t(sidebarOpen ? 'sidebar.collapse' : 'sidebar.expand')}><Icon name="panel" width="16" height="16" /></button>
				</HoverTooltip>
			</div>
		</header>
	);
}
