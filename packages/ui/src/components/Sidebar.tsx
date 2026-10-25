import { useCallback, useState } from 'react';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { Icon } from './Icons';
import { HoverTooltip } from './HoverTooltip';
import { SidebarSessionPanel } from './SidebarSessionPanel';
import { HistoryNavigation, type HistoryNavigationProps } from './HistoryNavigation';
import { SearchButton } from './SearchButton';
import { operationFeedback } from '../operationFeedback';

interface SidebarProps {
	open: boolean;
	projectRevealRequest?: number;
	narrow: boolean;
	onToggle(): void;
	onNavigate(): void;
	onOpenSearch(): void;
	searchOpen: boolean;
	history: HistoryNavigationProps;
	/** False while a non-chat view (automations/plugins) is the active page; clears the session-list highlight. */
	sessionsActive: boolean;
}

export function Sidebar({ open, projectRevealRequest = 0, narrow, onToggle, onNavigate, onOpenSearch, searchOpen, sessionsActive, history }: SidebarProps) {
	const { t } = useT();
	const platform = useChatStore((s) => s.appInfo?.platform);
	const [actionError, setActionError] = useState<string | null>(null);
	const reportActionError = useCallback((message: string | null) => {
		setActionError(message);
		if (message) operationFeedback.show({ id: `sidebar:${message}`, kind: 'error', title: message });
	}, []);
	const collapsed = !open && !narrow;
	return <aside className={`pd-sidebar${collapsed ? ' is-collapsed' : ''}${open ? ' is-open' : ''}`} aria-label={t('sidebar.main')} aria-hidden={narrow && !open} inert={narrow && !open}>
		<div className="pd-sidebar-brand pd-sidebar-toolbar">
			<div className="pd-sidebar-brand-group pd-sidebar-detail"><span className="pd-brand-mark" aria-hidden="true">π</span><HistoryNavigation {...history} /></div>
			<div className="pd-sidebar-header-actions">
				{!collapsed && <SearchButton open={searchOpen} onClick={onOpenSearch} />}
				<HoverTooltip title={t(open ? 'sidebar.collapse' : 'sidebar.expand')} shortcut={platform === 'darwin' ? '⌘B' : 'Ctrl+B'}><button type="button" className="pd-icon-button pd-sidebar-collapse" onClick={onToggle} aria-label={t(open ? 'sidebar.collapse' : 'sidebar.expand')}><Icon name="panel" width="16" height="16" /></button></HoverTooltip>
			</div>
		</div>
		<div className="pd-sidebar-session-content" aria-hidden={!open} inert={!open}>
			<SidebarSessionPanel visible={open} projectRevealRequest={projectRevealRequest} alternateViewOpen={!sessionsActive} onNavigate={onNavigate} onError={reportActionError} />
		</div>
		{actionError && <div className="pd-sidebar-error pd-sidebar-detail" role="alert">{actionError}</div>}
	</aside>;
}
