import { useCallback, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { UiUpdateState } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { Icon } from './Icons';
import { HoverTooltip } from './HoverTooltip';
import { SidebarSessionPanel } from './SidebarSessionPanel';
import { HistoryNavigation, type HistoryNavigationProps } from './HistoryNavigation';
import { SearchButton } from './SearchButton';
import { operationFeedback, runWithFeedback } from '../operationFeedback';

interface SidebarProps {
	open: boolean;
	narrow: boolean;
	onToggle(): void;
	onNavigate(): void;
	onOpenSettings(page?: 'updates'): void;
	onOpenSearch(): void;
	searchOpen: boolean;
	automationsOpen: boolean;
	onOpenAutomations(): void;
	pluginsOpen: boolean;
	onOpenPlugins(): void;
	history: HistoryNavigationProps;
}

export function Sidebar({ open, narrow, onToggle, onNavigate, onOpenSettings, onOpenSearch, searchOpen, automationsOpen, onOpenAutomations, pluginsOpen, onOpenPlugins, history }: SidebarProps) {
	const { t, locale } = useT();
	const bridge = useChatStore((s) => s.bridge);
	const platform = useChatStore((s) => s.appInfo?.platform);
	const cwd = useChatStore((s) => s.cwd);
	const status = useChatStore((s) => s.status);
	const pickWorkspace = useChatStore((s) => s.pickWorkspace);
	const newSession = useChatStore((s) => s.newSession);
	const [actionError, setActionError] = useState<string | null>(null);
	const reportActionError = useCallback((message: string | null) => {
		setActionError(message);
		if (message) operationFeedback.show({ id: `sidebar:${message}`, kind: 'error', title: message });
	}, []);
	const [updateActionError, setUpdateActionError] = useState<string | null>(null);
	const [updatePending, setUpdatePending] = useState(false);
	const updateActionLock = useRef(false);
	const [updateSnapshot, setUpdateSnapshot] = useState<{ bridge: typeof bridge; state: UiUpdateState } | null>(null);
	const updateState = updateSnapshot?.bridge === bridge ? updateSnapshot.state : null;
	const updateAvailable = updateState?.phase === 'available' || updateState?.phase === 'downloading' || updateState?.phase === 'ready' || updateState?.phase === 'installing'
		|| Boolean(updateState?.availableVersion && (updateState.phase === 'error' || updateState.phase === 'checking'));
	const updatePercent = Number.isFinite(updateState?.progressPercent) ? Math.round(Math.max(0, Math.min(100, updateState!.progressPercent!))) : 0;
	const updateBusy = updatePending || Boolean(updateState?.installRequested) || updateState?.phase === 'installing';
	const updateError = updateActionError ?? (updateState?.phase === 'error' && updateState.availableVersion ? updateState.error : null);
	const updateLabel = updateError ? `${updateError}\n${t('settings.updateRetryNotice')}`
		: updateState?.phase === 'installing' ? t('settings.updateInstalling')
		: updateState?.installRequested ? t('settings.updateRequestedNotice')
		: updateState?.phase === 'ready' ? t('settings.updateReadyNotice')
		: updateState?.phase === 'downloading' ? t('settings.updateDownloadNotice', { percent: updatePercent })
		: t('settings.updateAvailableNotice');
	// zcode-style: hovering the entry shows the release notes. The changelog is
	// hidden once the download is underway — progress becomes the story then.
	const notesState = updateState?.releaseNotes ? updateState : null;
	const updateNotesVisible = notesState !== null && notesState.phase !== 'downloading' && notesState.phase !== 'installing';
	const rawNotesDate = notesState?.releaseDate;
	const updateNotesDate = rawNotesDate && !Number.isNaN(Date.parse(rawNotesDate))
		? new Intl.DateTimeFormat(locale === 'en-US' ? 'en-US' : 'zh-CN', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(rawNotesDate))
		: null;
	const updateButtonText = updateState?.phase === 'installing' ? t('sidebar.updateRestarting')
		: updateState?.phase === 'downloading' ? `${updatePercent}%`
		: updateBusy ? t('sidebar.updatePending')
		: updateError ? t('sidebar.updateRetry') : t('sidebar.update');
	const collapsed = !open && !narrow;

	useEffect(() => {
		if (!bridge) return;
		let active = true;
		let receivedEvent = false;
		const unsubscribe = bridge.onUpdateStateChanged((state) => {
			receivedEvent = true;
			if (active) {
				setUpdateSnapshot({ bridge, state });
				if (state.phase !== 'error') setUpdateActionError(null);
			}
		});
		// A delayed initial read must not replace a newer download notification.
		void bridge.getUpdateState().then((state) => {
			if (active && !receivedEvent) setUpdateSnapshot({ bridge, state });
		}).catch(() => {});
		return () => { active = false; unsubscribe(); };
	}, [bridge]);

	async function startSession() {
		setActionError(null);
		const origin = cwd;
		await runWithFeedback({ id: `new-session:${origin}`, title: t('sidebar.newSession'), run: async () => {
			if (useChatStore.getState().cwd !== origin) throw new Error(locale === 'zh-CN' ? '请返回原工作区后重试。' : 'Return to the original workspace before retrying.');
			await (origin ? newSession() : pickWorkspace()); onNavigate();
		} });
	}

	async function updateNow() {
		if (!bridge || !updateAvailable || updateBusy || updateActionLock.current) return;
		await runWithFeedback({ id: 'install-update', title: t('sidebar.update'), run: async () => {
			updateActionLock.current = true;
			setUpdatePending(true);
			setUpdateActionError(null);
			try { await bridge.installUpdate(); }
			catch (error) { setUpdateActionError(error instanceof Error ? error.message : String(error)); throw error; }
			finally { updateActionLock.current = false; setUpdatePending(false); }
		} });
	}

	return <aside className={`pd-sidebar${collapsed ? ' is-collapsed' : ''}${open ? ' is-open' : ''}`} aria-label={t('sidebar.main')} aria-hidden={narrow && !open} inert={narrow && !open}>
		<div className="pd-sidebar-brand pd-sidebar-toolbar">
			<div className="pd-sidebar-brand-group pd-sidebar-detail"><span className="pd-brand-mark" aria-hidden="true">π</span><HistoryNavigation {...history} /></div>
			<div className="pd-sidebar-header-actions">
				{!collapsed && <SearchButton open={searchOpen} onClick={onOpenSearch} />}
				<HoverTooltip title={t(open ? 'sidebar.collapse' : 'sidebar.expand')} shortcut={platform === 'darwin' ? '⌘B' : 'Ctrl+B'}><button type="button" className="pd-icon-button pd-sidebar-collapse" onClick={onToggle} aria-label={t(open ? 'sidebar.collapse' : 'sidebar.expand')}><Icon name="panel" width="16" height="16" /></button></HoverTooltip>
			</div>
		</div>
		<div className="pd-sidebar-top pd-sidebar-navigation">
			<button type="button" className="pd-new-session pd-nav-row" onClick={() => void startSession()} disabled={status === 'starting'} aria-label={t('sidebar.newSession')}><Icon name="plus" /><span className="pd-sidebar-detail">{t('sidebar.newSession')}</span></button>
			<button type="button" className={`pd-sidebar-automation pd-nav-row${automationsOpen ? ' is-active' : ''}`} aria-label={t('sidebar.automation')} aria-current={automationsOpen ? 'page' : undefined} onClick={onOpenAutomations}><Icon name="automation" /><span className="pd-sidebar-detail">{t('sidebar.automation')}</span></button>
			<button type="button" className={`pd-sidebar-plugins pd-nav-row${pluginsOpen ? ' is-active' : ''}`} aria-label={t('sidebar.plugins')} aria-current={pluginsOpen ? 'page' : undefined} onClick={onOpenPlugins}><Icon name="plugins" /><span className="pd-sidebar-detail">{t('sidebar.plugins')}</span></button>
		</div>
		<div className="pd-sidebar-session-content" aria-hidden={!open} inert={!open}>
			<SidebarSessionPanel visible={open} onNavigate={onNavigate} onError={reportActionError} />
		</div>
		<div className="pd-sidebar-footer">
			{actionError && <div className="pd-sidebar-error pd-sidebar-detail" role="alert">{actionError}</div>}
			{updateError && <div className="pd-sidebar-error pd-sidebar-detail" role="alert">{updateError}</div>}
			<div className="pd-sidebar-footer-actions">
				<HoverTooltip title={t('sidebar.settings')} align="start"><button type="button" className="pd-settings-entry" aria-label={t('sidebar.settings')} onClick={() => onOpenSettings()}><Icon name="settings" width="17" height="17" /><span className="pd-sidebar-detail">{t('sidebar.settings')}</span><Icon name="chevronRight" className="pd-sidebar-detail" width="15" height="15" /></button></HoverTooltip>
				{updateAvailable && <HoverTooltip title={updateLabel} align="end" description={updateNotesVisible ? (
					<div className="pd-update-notes">
						{updateNotesDate && <div className="pd-update-notes-date">{updateNotesDate}</div>}
						<div className="pd-update-notes-body"><Markdown remarkPlugins={[remarkGfm]}>{notesState!.releaseNotes}</Markdown></div>
					</div>
				) : undefined}>
					<button type="button" className={`pd-sidebar-update${updateState?.phase === 'downloading' ? ' is-downloading' : ''}`} aria-label={updateLabel} aria-busy={updateBusy} disabled={updateBusy || !bridge} data-update-phase={updateState?.phase} onClick={() => void updateNow()}>
						<Icon name="update" width="13" height="13" aria-hidden="true" /><span className="pd-sidebar-update-label" aria-hidden="true">{updateButtonText}</span>
					</button>
				</HoverTooltip>}
			</div>
		</div>
	</aside>;
}
