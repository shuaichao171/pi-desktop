import { useCallback, useState } from 'react';
import { useT } from '../i18n';
import { useChatStore } from '../store';
import { bindingKeysFor } from '../shortcuts/bindings';
import { Icon } from './Icons';
import { HoverTooltip } from './HoverTooltip';
import { SidebarSessionPanel } from './SidebarSessionPanel';
import { operationFeedback } from '../operationFeedback';

interface SidebarProps {
	open: boolean;
	projectRevealRequest?: number;
	narrow: boolean;
	onNavigate(): void;
	/** Starts a new conversation; the sidebar's primary action, first in the pane. */
	onNewSession(): void;
	/** False while a non-chat view (automations/plugins) is the active page; clears the session-list highlight. */
	sessionsActive: boolean;
	onOpenTerminal?: () => void;
}

export function Sidebar({ open, projectRevealRequest = 0, narrow, onNavigate, onNewSession, sessionsActive, onOpenTerminal }: SidebarProps) {
	const { t } = useT();
	const [actionError, setActionError] = useState<string | null>(null);
	const navigationPending = useChatStore((state) => state.navigationPending || state.sessionLoading);
	const platform = useChatStore((state) => state.appInfo?.platform);
	const reportActionError = useCallback((message: string | null) => {
		setActionError(message);
		if (message) operationFeedback.show({ id: `sidebar:${message}`, kind: 'error', title: message });
	}, []);
	const keys = bindingKeysFor('newSession');
	const shortcut = platform === 'darwin' ? keys.replace(/Ctrl/gi, '⌘').replace(/Shift/gi, '⇧').replace(/Alt/gi, '⌥').replace(/\+/g, '') : keys;
	const collapsed = !open && !narrow;
	// The pane's primary action shares the project heading row, just left of the view options.
	const newSession = <HoverTooltip title={t('sidebar.newConversation')} shortcut={shortcut || undefined}>
		<button type="button" className="pd-sidebar-new-session" disabled={navigationPending} aria-label={t('sidebar.newConversation')} aria-keyshortcuts={keys || undefined} onClick={onNewSession}>
			<Icon name="plus" width="14" height="14" aria-hidden="true" />
			<span>{t('sidebar.newConversation')}</span>
		</button>
	</HoverTooltip>;
	return <aside className={`pd-sidebar${collapsed ? ' is-collapsed' : ''}${open ? ' is-open' : ''}`} aria-label={t('sidebar.main')} aria-hidden={narrow && !open} inert={narrow && !open}>
		<div className="pd-sidebar-session-content" aria-hidden={!open} inert={!open}>
			<SidebarSessionPanel visible={open} newSessionAction={newSession} projectRevealRequest={projectRevealRequest} alternateViewOpen={!sessionsActive} onNavigate={onNavigate} onError={reportActionError} onOpenTerminal={onOpenTerminal} />
		</div>
		{actionError && <div className="pd-sidebar-error pd-sidebar-detail" role="alert">{actionError}</div>}
	</aside>;
}
