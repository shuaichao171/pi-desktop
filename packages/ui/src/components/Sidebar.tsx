import { useCallback, useState } from 'react';
import { useT } from '../i18n';
import { SidebarSessionPanel } from './SidebarSessionPanel';
import { operationFeedback } from '../operationFeedback';

interface SidebarProps {
	open: boolean;
	projectRevealRequest?: number;
	narrow: boolean;
	onNavigate(): void;
	/** False while a non-chat view (automations/plugins) is the active page; clears the session-list highlight. */
	sessionsActive: boolean;
}

export function Sidebar({ open, projectRevealRequest = 0, narrow, onNavigate, sessionsActive }: SidebarProps) {
	const { t } = useT();
	const [actionError, setActionError] = useState<string | null>(null);
	const reportActionError = useCallback((message: string | null) => {
		setActionError(message);
		if (message) operationFeedback.show({ id: `sidebar:${message}`, kind: 'error', title: message });
	}, []);
	const collapsed = !open && !narrow;
	return <aside className={`pd-sidebar${collapsed ? ' is-collapsed' : ''}${open ? ' is-open' : ''}`} aria-label={t('sidebar.main')} aria-hidden={narrow && !open} inert={narrow && !open}>
		<div className="pd-sidebar-session-content" aria-hidden={!open} inert={!open}>
			<SidebarSessionPanel visible={open} projectRevealRequest={projectRevealRequest} alternateViewOpen={!sessionsActive} onNavigate={onNavigate} onError={reportActionError} />
		</div>
		{actionError && <div className="pd-sidebar-error pd-sidebar-detail" role="alert">{actionError}</div>}
	</aside>;
}
