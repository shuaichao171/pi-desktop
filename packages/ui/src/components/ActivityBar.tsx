import { useEffect, useState } from 'react';
import type { UiUpdateState } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { Icon } from './Icons';
import { HoverTooltip } from './HoverTooltip';

/** A view the activity bar can switch the sidebar/main area to. Builtin ids are
 * matched against the AppShell main view; contributions are reserved for the
 * future extension/plugin system (stable interface, see shared/src/activity.ts). */
export type ActivityViewId = 'automations' | 'plugins' | (string & {});

interface ActivityBarProps {
	/** Active main view: 'chat' means the sidebar shows the session list. */
	mainView: 'chat' | 'automations' | 'plugins';
	onOpenView(view: ActivityViewId): void;
	onNewSession(): void;
	onOpenSettings(): void;
	/** Opens settings on the updates page; the rail shows this entry only while a newer version exists. */
	onOpenUpdates(): void;
	/** True while a session navigation is pending; disables the new-session action. */
	navigationPending: boolean;
	/** Sidebar pane visibility; the top rail button toggles it (Ctrl+B twin). */
	sidebarOpen: boolean;
	onToggleSidebar(): void;
}

export function ActivityBar({ mainView, onOpenView, onNewSession, onOpenSettings, onOpenUpdates, navigationPending, sidebarOpen, onToggleSidebar }: ActivityBarProps) {
	const { t } = useT();
	const bridge = useChatStore((s) => s.bridge);
	const platform = useChatStore((s) => s.appInfo?.platform);
	const [updateSnapshot, setUpdateSnapshot] = useState<UiUpdateState | null>(null);

	useEffect(() => {
		if (!bridge) return;
		let active = true;
		let receivedEvent = false;
		const unsubscribe = bridge.onUpdateStateChanged((next) => {
			receivedEvent = true;
			if (active) setUpdateSnapshot(next);
		});
		void bridge.getUpdateState().then((next) => { if (active && !receivedEvent) setUpdateSnapshot(next); }).catch(() => {});
		return () => { active = false; unsubscribe(); };
	}, [bridge]);

	const updateState = updateSnapshot;
	const updateAvailable = updateState?.phase === 'available' || updateState?.phase === 'downloading' || updateState?.phase === 'ready' || updateState?.phase === 'installing'
		|| Boolean(updateState?.availableVersion && (updateState.phase === 'error' || updateState.phase === 'checking'));
	const updateVersion = updateState?.availableVersion ?? '';
	const updateTitle = updateState?.phase === 'downloading'
		? t('activity.updateDownloading', { version: updateVersion, percent: String(Math.round(updateState.progressPercent ?? 0)) })
		: updateState?.phase === 'ready' || updateState?.phase === 'installing' ? t('activity.updateReady', { version: updateVersion })
			: t('activity.updateAvailable', { version: updateVersion });

	return (
		<nav className="pd-activity-bar" aria-label={t('activity.barLabel')}>
			<div className="pd-activity-bar-top">
				<HoverTooltip title={t(sidebarOpen ? 'sidebar.collapse' : 'sidebar.expand')} shortcut={platform === 'darwin' ? '⌘B' : 'Ctrl+B'}>
					<button type="button" className={`pd-activity-item pd-activity-sessions${sidebarOpen ? ' is-active' : ''}`} aria-label={t('activity.sessionsView')} aria-current={sidebarOpen ? 'page' : undefined} onClick={onToggleSidebar}><Icon name="message" width="20" height="20" /></button>
				</HoverTooltip>
				<HoverTooltip title={t('sidebar.newSession')}>
					<button type="button" className="pd-activity-item pd-activity-new-session" disabled={navigationPending} aria-label={t('sidebar.newSession')} onClick={() => void onNewSession()}><Icon name="plus" width="20" height="20" /></button>
				</HoverTooltip>
				<HoverTooltip title={t('sidebar.automation')}>
					<button type="button" className={`pd-activity-item pd-activity-automations${mainView === 'automations' ? ' is-active' : ''}`} aria-label={t('sidebar.automation')} aria-current={mainView === 'automations' ? 'page' : undefined} onClick={() => onOpenView('automations')}><Icon name="automation" width="20" height="20" /></button>
				</HoverTooltip>
				<HoverTooltip title={t('sidebar.plugins')}>
					<button type="button" className={`pd-activity-item pd-activity-plugins${mainView === 'plugins' ? ' is-active' : ''}`} aria-label={t('sidebar.plugins')} aria-current={mainView === 'plugins' ? 'page' : undefined} onClick={() => onOpenView('plugins')}><Icon name="plugins" width="20" height="20" /></button>
				</HoverTooltip>
				{/* Extension contribution slots render here once the plugin system
				 * opens: each ActivityViewContribution gains an icon below plugins. */}
			</div>
			<div className="pd-activity-bar-bottom">
				{/* A newer version gets its own entry above settings (replacing the old
				 * red dot on the gear): it names the version and opens the updates page. */}
				{updateAvailable && <HoverTooltip title={updateTitle}>
					<button type="button" className="pd-activity-item pd-activity-update has-notice" aria-label={updateTitle} onClick={() => onOpenUpdates()}><Icon name="update" width="20" height="20" /></button>
				</HoverTooltip>}
				<HoverTooltip title={t('sidebar.settings')}>
					<button type="button" className="pd-activity-item pd-settings-entry" aria-label={t('sidebar.settings')} onClick={() => onOpenSettings()}><Icon name="settings" width="20" height="20" /></button>
				</HoverTooltip>
			</div>
		</nav>
	);
}
