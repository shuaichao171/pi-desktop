import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { UiSessionSummary } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT, type Locale, type Translate } from '../i18n';
import { Icon } from './Icons';

interface SidebarProps {
	open: boolean;
	narrow: boolean;
	onToggle(): void;
	onNavigate(): void;
	onOpenSettings(page?: 'updates'): void;
}

type SessionGroup = 'today' | 'yesterday' | 'week' | 'older';
const GROUP_ORDER: SessionGroup[] = ['today', 'yesterday', 'week', 'older'];

function workspaceName(cwd: string): string {
	return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
}

function sessionTitle(name: string | undefined, firstMessage: string, fallback: string): string {
	return name?.trim() || firstMessage.trim().split(/\r?\n/)[0] || fallback;
}

function sessionDate(value: string, locale: Locale, t: Translate): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return '';
	const today = new Date();
	if (date.toDateString() === today.toDateString()) {
		const minutesAgo = Math.floor((today.getTime() - date.getTime()) / 60000);
		if (minutesAgo === 0) return t('sidebar.justNow');
		if (minutesAgo > 0 && minutesAgo < 60) return t('sidebar.minutesAgo', { count: minutesAgo });
		return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date);
	}
	return new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }).format(date);
}

function sessionGroup(value: string): SessionGroup {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return 'older';
	const now = new Date();
	const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const day = 24 * 60 * 60 * 1000;
	if (date.getTime() >= midnight) return 'today';
	if (date.getTime() >= midnight - day) return 'yesterday';
	if (date.getTime() >= midnight - 6 * day) return 'week';
	return 'older';
}

function groupedSessions(sessions: UiSessionSummary[], query: string, oldestFirst: boolean, unnamed: string) {
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const filtered = sessions.filter((session) => `${sessionTitle(session.name, session.firstMessage, unnamed)}\n${session.firstMessage}\n${session.path}`.toLocaleLowerCase().includes(normalizedQuery));
	filtered.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
	const pinned = filtered.filter((session) => session.pinned);
	const unpinned = filtered.filter((session) => !session.pinned);
	if (oldestFirst) {
		pinned.reverse();
		unpinned.reverse();
	}
	const groups = new Map<SessionGroup, UiSessionSummary[]>();
	for (const session of unpinned) {
		const group = sessionGroup(session.modified);
		groups.set(group, [...(groups.get(group) ?? []), session]);
	}
	const order = oldestFirst ? [...GROUP_ORDER].reverse() : GROUP_ORDER;
	return { count: filtered.length, pinned, groups: order.filter((group) => groups.has(group)).map((group) => ({ label: group, sessions: groups.get(group)! })) };
}

export function Sidebar({ open, narrow, onToggle, onNavigate, onOpenSettings }: SidebarProps) {
	const { t, locale } = useT();
	const bridge = useChatStore((s) => s.bridge);
	const cwd = useChatStore((s) => s.cwd);
	const status = useChatStore((s) => s.status);
	const sessionId = useChatStore((s) => s.sessionId);
	const sessionPath = useChatStore((s) => s.sessionPath);
	const workspaces = useChatStore((s) => s.workspaces);
	const sessionsByWorkspace = useChatStore((s) => s.sessionsByWorkspace);
	const pickWorkspace = useChatStore((s) => s.pickWorkspace);
	const switchWorkspace = useChatStore((s) => s.switchWorkspace);
	const refreshWorkspaces = useChatStore((s) => s.refreshWorkspaces);
	const refreshWorkspaceSessions = useChatStore((s) => s.refreshWorkspaceSessions);
	const newSession = useChatStore((s) => s.newSession);
	const switchSession = useChatStore((s) => s.switchSession);
	const updateSessionMeta = useChatStore((s) => s.updateSessionMeta);
	const [actionError, setActionError] = useState<string | null>(null);
	const [updateReady, setUpdateReady] = useState(false);
	const [search, setSearch] = useState('');
	const [searchOpen, setSearchOpen] = useState(false);
	const [expandedWorkspaces, setExpandedWorkspaces] = useState<Record<string, boolean>>({});
	const [oldestFirst, setOldestFirst] = useState(false);
	const [showArchived, setShowArchived] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [menuPath, setMenuPath] = useState<string | null>(null);
	const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
	const [renamePath, setRenamePath] = useState<string | null>(null);
	const [renameDraft, setRenameDraft] = useState('');
	const searchRef = useRef<HTMLInputElement>(null);
	const renameRef = useRef<HTMLInputElement>(null);
	const renameCancelledRef = useRef(false);
	const collapsed = !open && !narrow;
	const workspacePaths = useMemo(() => cwd && !workspaces.includes(cwd) ? [cwd, ...workspaces] : workspaces, [cwd, workspaces]);
	const workspaceKey = workspacePaths.join('\u0000');
	const totalArchived = workspacePaths.reduce((count, path) => count + (sessionsByWorkspace[path] ?? []).filter((session) => session.archived).length, 0);

	useEffect(() => {
		if (searchOpen && open) searchRef.current?.focus();
	}, [searchOpen, open]);

	useEffect(() => {
		if (!bridge) return;
		let active = true;
		const unsubscribe = bridge.onUpdateStateChanged((state) => { if (active) setUpdateReady(state.phase === 'ready'); });
		void bridge.getUpdateState().then((state) => { if (active) setUpdateReady(state.phase === 'ready'); }).catch(() => {});
		return () => { active = false; unsubscribe(); };
	}, [bridge]);

	useEffect(() => {
		if (renamePath) renameRef.current?.focus();
	}, [renamePath]);

	useEffect(() => {
		if (!cwd) return;
		setExpandedWorkspaces((current) => ({ ...current, [cwd]: true }));
	}, [cwd]);

	useEffect(() => {
		if (!bridge) return;
		void refreshWorkspaces();
	}, [bridge, refreshWorkspaces]);

	useEffect(() => {
		if (!bridge || !workspaceKey) return;
		void Promise.allSettled(workspacePaths.map((path) => refreshWorkspaceSessions(path)));
	}, [bridge, workspaceKey, refreshWorkspaceSessions]);

	useEffect(() => {
		if (!menuPath) return;
		const close = (event: MouseEvent) => {
			if (!(event.target instanceof Element) || !event.target.closest('.pd-session-actions, .pd-session-menu')) setMenuPath(null);
		};
		const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuPath(null); };
		window.addEventListener('mousedown', close);
		window.addEventListener('keydown', onKeyDown);
		return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', onKeyDown); };
	}, [menuPath]);

	function toggleSearch() {
		if (searchOpen && !collapsed) { setSearch(''); setSearchOpen(false); return; }
		if (collapsed) onToggle();
		setSearchOpen(true);
	}

	async function perform(action: () => Promise<void>, navigate = false) {
		setActionError(null);
		try { await action(); if (navigate) onNavigate(); }
		catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
	}

	async function refreshAll() {
		setRefreshing(true);
		try {
			await refreshWorkspaces();
			await Promise.all(workspacePaths.map((path) => refreshWorkspaceSessions(path)));
		} finally { setRefreshing(false); }
	}

	async function openSession(workspace: string, path: string, unread: boolean) {
		await perform(async () => {
			if (workspace !== cwd) await switchWorkspace(workspace);
			await switchSession(path);
			if (unread) await updateSessionMeta(path, { unread: false });
		}, true);
	}

	function startRename(session: UiSessionSummary) {
		renameCancelledRef.current = false;
		setRenamePath(session.path);
		setRenameDraft(session.name?.trim() || sessionTitle(undefined, session.firstMessage, t('sidebar.unnamed')));
		setMenuPath(null);
	}

	async function finishRename(path: string) {
		if (renameCancelledRef.current) { renameCancelledRef.current = false; return; }
		const value = renameDraft.trim();
		setRenamePath(null);
		await perform(() => updateSessionMeta(path, { name: value }));
	}

	function renderSession(session: UiSessionSummary, workspace: string) {
		const active = workspace === cwd && session.path === sessionPath;
		const title = sessionTitle(session.name, session.firstMessage, t('sidebar.unnamed'));
		return <div className={`pd-session-item${active ? ' is-active' : ''}`} key={session.path}>
			{renamePath === session.path ? <input ref={renameRef} className="pd-session-rename" value={renameDraft} aria-label={t('sidebar.renameLabel')} onChange={(event) => setRenameDraft(event.target.value)} onKeyDown={(event) => {
				if (event.key === 'Enter') event.currentTarget.blur();
				if (event.key === 'Escape') { event.preventDefault(); renameCancelledRef.current = true; setRenamePath(null); }
			}} onBlur={() => void finishRename(session.path)} /> : <>
				<button type="button" className="pd-session-row" onClick={() => void openSession(workspace, session.path, Boolean(session.unread))} disabled={status === 'starting'} aria-current={active ? 'page' : undefined} title={t('sidebar.sessionDescription', { title, count: session.messageCount })}>
					{session.unread && <span className="pd-session-unread" aria-label={t('sidebar.unread')} />}
					<span className="pd-session-copy"><strong>{title}</strong></span>
					<time dateTime={session.modified}>{sessionDate(session.modified, locale, t)}</time>
				</button>
				<div className="pd-session-actions">
					<button type="button" className="pd-session-more pd-icon-button" aria-label={t('sidebar.menuLabel', { title })} aria-expanded={menuPath === session.path} title={t('sidebar.menuTitle')} onClick={(event) => {
						const rect = event.currentTarget.getBoundingClientRect();
						setMenuPosition({ top: rect.bottom + 128 < window.innerHeight ? rect.bottom + 4 : rect.top - 130, left: Math.max(8, Math.min(window.innerWidth - 136, rect.right - 128)) });
						setMenuPath((current) => current === session.path ? null : session.path);
					}}><Icon name="more" width="15" height="15" /></button>
					{menuPath === session.path && createPortal(<div className="pd-session-menu" role="menu" aria-label={t('sidebar.menuLabel', { title })} style={menuPosition}>
						<button type="button" role="menuitem" onClick={() => startRename(session)}>{t('sidebar.rename')}</button>
						<button type="button" role="menuitem" onClick={() => { setMenuPath(null); void perform(() => updateSessionMeta(session.path, { pinned: !session.pinned })); }}>{t(session.pinned ? 'sidebar.unpin' : 'sidebar.pin')}</button>
						<button type="button" role="menuitem" onClick={() => { setMenuPath(null); void perform(() => updateSessionMeta(session.path, { unread: !session.unread })); }}>{t(session.unread ? 'sidebar.markRead' : 'sidebar.markUnread')}</button>
						<button type="button" role="menuitem" onClick={() => { setMenuPath(null); void perform(() => updateSessionMeta(session.path, { archived: !session.archived })); }}>{t(session.archived ? 'sidebar.unarchive' : 'sidebar.archive')}</button>
						</div>, document.body)}
				</div>
			</>}
		</div>;
	}

	return <aside className={`pd-sidebar${collapsed ? ' is-collapsed' : ''}${open ? ' is-open' : ''}`} aria-label={t('sidebar.main')} aria-hidden={narrow && !open} inert={narrow && !open}>
		<div className="pd-sidebar-brand pd-sidebar-toolbar">
			<div className="pd-brand-label pd-sidebar-detail"><span className="pd-brand-mark" aria-hidden="true">π</span><strong>Pi Desktop</strong></div>
			<button type="button" className="pd-icon-button pd-sidebar-collapse" onClick={onToggle} aria-label={t(open ? 'sidebar.collapse' : 'sidebar.expand')} title={`${t(open ? 'sidebar.collapse' : 'sidebar.expand')} (Ctrl+B)`}><Icon name="panel" /></button>
		</div>
		<div className="pd-sidebar-top pd-sidebar-navigation">
			<button type="button" className="pd-new-session pd-nav-row" onClick={() => void perform(cwd ? newSession : pickWorkspace, true)} disabled={status === 'starting'} aria-label={t('sidebar.newSession')} title={t('sidebar.newSession')}><Icon name="plus" /><span className="pd-sidebar-detail">{t('sidebar.newSession')}</span></button>
			<button type="button" className={`pd-sidebar-search-trigger pd-nav-row${searchOpen ? ' is-active' : ''}`} onClick={toggleSearch} aria-label={t('sidebar.search')} aria-expanded={searchOpen && !collapsed} title={t('sidebar.search')}><Icon name="search" /><span className="pd-sidebar-detail">{t('sidebar.search')}</span></button>
			{searchOpen && !collapsed && <div className="pd-session-search pd-sidebar-detail"><Icon name="search" width="15" height="15" /><input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setSearch(''); setSearchOpen(false); searchRef.current?.blur(); } }} type="search" aria-label={t('sidebar.searchProjects')} placeholder={t('sidebar.searchProjects')} />{search && <button type="button" className="pd-search-clear" onClick={() => { setSearch(''); searchRef.current?.focus(); }} aria-label={t('sidebar.clearSearch')}><Icon name="close" width="13" height="13" /></button>}</div>}
		</div>
		<div className="pd-sidebar-detail pd-project-section">
			<div className="pd-project-heading"><span>{t('sidebar.projects')} <small>{workspacePaths.length}</small></span><div className="pd-section-actions"><button type="button" className="pd-icon-button" onClick={() => void perform(refreshAll)} disabled={refreshing} aria-label={t('sidebar.refreshProjects')} title={t('sidebar.refresh')}><Icon name="refresh" width="15" height="15" className={refreshing ? 'pd-spinning' : undefined} /></button><button type="button" className="pd-icon-button pd-project-add" onClick={() => void perform(pickWorkspace)} aria-label={t('sidebar.openWorkspace')} title={t('sidebar.openProject')}><Icon name="plus" width="16" height="16" /></button></div></div>
			<div className="pd-project-list" onScroll={() => setMenuPath(null)}>
				{workspacePaths.map((workspace) => {
					const allSessions = sessionsByWorkspace[workspace] ?? [];
					const activeSessions = allSessions.filter((session) => !session.archived);
					const archivedSessions = allSessions.filter((session) => session.archived);
					const activeGroups = groupedSessions(activeSessions, search, oldestFirst, t('sidebar.unnamed'));
					const archiveGroups = groupedSessions(archivedSessions, search, oldestFirst, t('sidebar.unnamed'));
					const matchesWorkspace = workspaceName(workspace).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
					if (search && !matchesWorkspace && activeGroups.count === 0 && (!showArchived || archiveGroups.count === 0)) return null;
					const expanded = Boolean(search) || (expandedWorkspaces[workspace] ?? workspace === cwd);
					const current = workspace === cwd;
					const showUnsaved = current && Boolean(sessionId && !allSessions.some((session) => session.path === sessionPath) && (!search || t('sidebar.newSession').toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
					return <section className={`pd-project${current ? ' is-current' : ''}`} key={workspace} aria-label={t('sidebar.projectLabel', { name: workspaceName(workspace) })}>
						<div className="pd-project-row"><button type="button" className="pd-workspace-button" onClick={() => void perform(() => switchWorkspace(workspace))} aria-current={current ? 'true' : undefined} title={workspace}><Icon name="folder" /><span className="pd-workspace-name">{workspaceName(workspace)}</span></button><button type="button" className="pd-project-expand pd-icon-button" onClick={() => setExpandedWorkspaces((value) => ({ ...value, [workspace]: !expanded }))} aria-label={t(expanded ? 'sidebar.projectSessionsCollapse' : 'sidebar.projectSessionsExpand', { name: workspaceName(workspace) })} aria-expanded={expanded}><Icon name="chevronDown" className={`pd-chevron${expanded ? ' is-open' : ''}`} width="14" height="14" /></button></div>
						{expanded && <div className="pd-session-section"><div className="pd-section-heading"><span>{t('sidebar.sessions')} <small>{activeGroups.count}</small></span><button type="button" className="pd-icon-button" onClick={() => setOldestFirst((value) => !value)} aria-label={t(oldestFirst ? 'sidebar.sortRecent' : 'sidebar.sortOldest')} title={t(oldestFirst ? 'sidebar.currentOldest' : 'sidebar.currentRecent')}><Icon name="sort" width="14" height="14" /></button></div>
							{showUnsaved && <div className="pd-session-item is-active"><div className="pd-session-row" aria-current="page" title={t('sidebar.unsavedTitle')}><span className="pd-session-copy"><strong>{t('sidebar.newSession')}</strong></span><span className="pd-session-unsaved">{t('sidebar.current')}</span></div></div>}
							{activeGroups.pinned.length > 0 && <div className="pd-session-group"><div className="pd-session-group-label">{t('sidebar.pinned')}</div>{activeGroups.pinned.map((session) => renderSession(session, workspace))}</div>}
							{activeGroups.groups.map((group) => <div className="pd-session-group" key={group.label}><div className="pd-session-group-label">{t(`sidebar.${group.label}`)}</div>{group.sessions.map((session) => renderSession(session, workspace))}</div>)}
							{activeGroups.count === 0 && !showUnsaved && <div className="pd-session-empty">{t(search ? 'sidebar.noMatches' : 'sidebar.noSessions')}</div>}
							{showArchived && archiveGroups.count > 0 && <div className="pd-session-group pd-archived-group"><div className="pd-session-group-label">{t('sidebar.archived')} · {archiveGroups.count}</div>{archiveGroups.pinned.map((session) => renderSession(session, workspace))}{archiveGroups.groups.flatMap((group) => group.sessions.map((session) => renderSession(session, workspace)))}</div>}
						</div>}
					</section>;
				})}
				{workspacePaths.length === 0 && <div className="pd-project-empty"><p>{t('sidebar.noProjects')}</p><button type="button" onClick={() => void perform(pickWorkspace)}>{t('sidebar.openFolder')}</button></div>}
			</div>
			{totalArchived > 0 && <button type="button" className={`pd-archive-toggle${showArchived ? ' is-active' : ''}`} onClick={() => setShowArchived((value) => !value)} aria-expanded={showArchived}><Icon name="archive" width="15" height="15" /><span>{t('sidebar.archived')}</span><small>{totalArchived}</small></button>}
		</div>
		<div className="pd-sidebar-footer">
			{actionError && <div className="pd-sidebar-error pd-sidebar-detail" role="alert">{actionError}</div>}
			<button type="button" className="pd-settings-entry" onClick={() => onOpenSettings(updateReady ? 'updates' : undefined)} title={updateReady ? t('settings.updateReadyNotice') : t('sidebar.settings')}><Icon name="settings" width="17" height="17" /><span className="pd-sidebar-detail">{t('sidebar.settings')}</span>{updateReady && <span className="pd-update-ready-badge" aria-label={t('settings.updateReadyNotice')} />}<Icon name="chevronRight" className="pd-sidebar-detail" width="15" height="15" /></button>
		</div>
	</aside>;
}
