import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { UiSessionGroup, UiSidebarGroupChange } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { buildSidebarGroups, collectSidebarSessions, groupSessionsByDate, readSidebarPreferences, saveSidebarPreferences, selectSidebarSessions, type SidebarPreferences, type SidebarSession } from '../sidebarOrganization';
import { HoverTooltip } from './HoverTooltip';
import { Icon } from './Icons';
import { SidebarPopover } from './SidebarPopover';
import './sidebarOrganization.css';

type Popup = { anchor: HTMLElement } & (
	| { kind: 'filter' }
	| { kind: 'session' | 'move'; session: SidebarSession }
	| { kind: 'group'; group: UiSessionGroup }
	| { kind: 'edit-group'; group?: UiSessionGroup }
);
const workspaceName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const groupKey = (id: string) => `group:${id}`;
const projectKey = (path: string) => `project:${path}`;

export function SidebarSessionPanel({ visible, onNavigate, onError }: { visible: boolean; onNavigate(): void; onError(value: string | null): void }) {
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
	const selectSession = useChatStore((s) => s.selectSession);
	const updateSessionMeta = useChatStore((s) => s.updateSessionMeta);
	const [preferences, setPreferences] = useState(readSidebarPreferences);
	const [groups, setGroups] = useState<UiSessionGroup[]>([]);
	const [groupsLoading, setGroupsLoading] = useState(true);
	const [groupsError, setGroupsError] = useState(false);
	const [archived, setArchived] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [popup, setPopup] = useState<Popup | null>(null);
	const popupRef = useRef(popup);
	popupRef.current = popup;
	const navigationPending = useRef(false);
	const [navigating, setNavigating] = useState(false);
	const [groupDraft, setGroupDraft] = useState('');
	const [formError, setFormError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const pendingRef = useRef(false);
	const groupRequest = useRef(0);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [renameDraft, setRenameDraft] = useState('');
	const renameRef = useRef<HTMLInputElement>(null);
	const renameCancelled = useRef(false);
	const listed = useRef(new Set<string>());
	const listedBridge = useRef<typeof bridge>(null);
	const workspacePaths = useMemo(() => cwd && !workspaces.includes(cwd) ? [cwd, ...workspaces] : workspaces, [cwd, workspaces]);
	const allSessions = useMemo(() => collectSidebarSessions(workspacePaths, sessionsByWorkspace), [workspacePaths, sessionsByWorkspace]);
	const sessions = useMemo(() => selectSidebarSessions(allSessions, { archived, filter: preferences.filter, sort: preferences.sort }), [allSessions, archived, preferences.filter, preferences.sort]);
	const grouped = useMemo(() => buildSidebarGroups(sessions, groups), [sessions, groups]);
	const dates = useMemo(() => {
		const result = groupSessionsByDate(archived ? sessions : sessions.filter((session) => !session.pinned));
		return preferences.sort === 'oldest' ? result.reverse() : result;
	}, [sessions, preferences.sort, archived]);
	const collapsed = useMemo(() => new Set(preferences.collapsed), [preferences.collapsed]);
	const loadingSessions = workspacePaths.some((path) => !Object.hasOwn(sessionsByWorkspace, path));
	const showUnsaved = !archived && preferences.filter === 'all' && Boolean(cwd && sessionId && !allSessions.some((s) => s.path === sessionPath));
	const totalArchived = allSessions.filter((s) => s.archived).length;
	const bodySectionKeys = archived || (preferences.mode === 'project' && preferences.projectView === 'timeline')
		? dates.map((date) => `${archived ? 'archive' : 'date'}:${date.id}`)
		: preferences.mode === 'project' ? workspacePaths.map(projectKey)
			: groups.map((group) => groupKey(group.id));
	const sectionKeys = !archived && grouped.pinned.length ? ['pinned', ...bodySectionKeys] : bodySectionKeys;
	const allExpanded = sectionKeys.length > 0 && sectionKeys.every((key) => !collapsed.has(key));

	useEffect(() => { saveSidebarPreferences(preferences); }, [preferences]);
	useEffect(() => { if (!visible) setPopup(null); }, [visible]);
	useEffect(() => {
		if (!bridge) return;
		const request = ++groupRequest.current;
		setGroupsLoading(true);
		setGroupsError(false);
		void bridge.listSessionGroups().then((value) => {
			if (request === groupRequest.current) setGroups(value);
		}).catch((error: unknown) => {
			if (request === groupRequest.current) { setGroupsError(true); onError(error instanceof Error ? error.message : String(error)); }
		}).finally(() => { if (request === groupRequest.current) setGroupsLoading(false); });
		return () => { groupRequest.current += 1; };
	}, [bridge, onError]);
	useEffect(() => {
		if (!bridge) return;
		if (listedBridge.current !== bridge) { listedBridge.current = bridge; listed.current.clear(); }
		for (const path of workspacePaths) {
			if (path === cwd || Object.hasOwn(sessionsByWorkspace, path) || listed.current.has(path)) continue;
			listed.current.add(path);
			void refreshWorkspaceSessions(path);
		}
	}, [bridge, workspacePaths, cwd, sessionsByWorkspace, refreshWorkspaceSessions]);
	useEffect(() => { if (renaming) { renameRef.current?.focus(); renameRef.current?.select(); } }, [renaming]);

	function preference(patch: Partial<SidebarPreferences>) { setPreferences((current) => ({ ...current, ...patch })); }
	function toggleSection(key: string) {
		setPreferences((current) => ({ ...current, collapsed: current.collapsed.includes(key) ? current.collapsed.filter((id) => id !== key) : [...current.collapsed, key] }));
	}
	function toggleAll() {
		setPreferences((current) => ({ ...current, collapsed: allExpanded ? [...new Set([...current.collapsed, ...sectionKeys])] : current.collapsed.filter((key) => !sectionKeys.includes(key)) }));
	}
	async function perform(action: () => Promise<void>, navigate = false) {
		onError(null);
		try { await action(); if (navigate) onNavigate(); }
		catch (error) { onError(error instanceof Error ? error.message : String(error)); }
	}
	async function refresh() {
		setRefreshing(true);
		try {
			await refreshWorkspaces();
			await Promise.all(useChatStore.getState().workspaces.map(refreshWorkspaceSessions));
			if (bridge && !pendingRef.current) {
				const request = ++groupRequest.current;
				const value = await bridge.listSessionGroups();
				if (request === groupRequest.current) { setGroups(value); setGroupsError(false); setGroupsLoading(false); }
			}
		} finally { setRefreshing(false); }
	}
	async function changeGroups(change: UiSidebarGroupChange): Promise<boolean> {
		if (!bridge || pendingRef.current) return false;
		pendingRef.current = true;
		setPending(true);
		const request = ++groupRequest.current;
		try {
			const value = await bridge.updateSessionGroups(change);
			if (request === groupRequest.current) { setGroups(value); setGroupsError(false); setGroupsLoading(false); }
			return true;
		} finally { pendingRef.current = false; setPending(false); }
	}
	function editGroup(anchor: HTMLElement, group?: UiSessionGroup) {
		setGroupDraft(group?.name ?? ''); setFormError(null); setPopup({ kind: 'edit-group', anchor, group });
	}
	function openSession(session: SidebarSession) {
		if (navigationPending.current) return;
		navigationPending.current = true;
		setNavigating(true);
		void perform(async () => {
			try {
				if (!await selectSession(session.workspace, session.path)) return;
				onNavigate();
				if (session.unread) await updateSessionMeta(session.path, { unread: false });
			} finally { navigationPending.current = false; setNavigating(false); }
		});
	}
	function sessionAction(session: SidebarSession, anchor: HTMLElement, action: () => Promise<void>) {
		setPopup(null);
		void perform(async () => {
			await action();
			requestAnimationFrame(() => {
				if (document.activeElement !== document.body && document.activeElement !== anchor) return;
				// Moving, pinning or filtering a row can replace its DOM after the
				// menu has already restored focus to the original trigger.
				const row = [...document.querySelectorAll<HTMLElement>('.pd-session-item[data-session-path]')].find((item) => item.dataset.sessionPath === session.path);
				const target = row?.querySelector<HTMLButtonElement>('.pd-session-more') ?? document.querySelector<HTMLButtonElement>('.pd-sidebar-mode [aria-selected="true"]');
				if (target && !target.closest('[inert]') && target.getClientRects().length) target.focus();
			});
		});
	}
	const titleOf = (session: SidebarSession) => session.name?.trim() || session.firstMessage.trim().split(/\r?\n/)[0] || t('sidebar.unnamed');
	function dateLabel(value: string) {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return '';
		const now = new Date();
		if (date.toDateString() === now.toDateString()) {
			const minutes = Math.floor((now.getTime() - date.getTime()) / 60000);
			if (minutes === 0) return t('sidebar.justNow');
			if (minutes > 0 && minutes < 60) return t('sidebar.minutesAgo', { count: minutes });
			return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date);
		}
		return new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }).format(date);
	}
	function renderSession(session: SidebarSession, source = true) {
		const active = session.workspace === cwd && session.path === sessionPath;
		const title = titleOf(session);
		return <div className={`pd-session-item${active ? ' is-active' : ''}`} key={session.path} data-session-path={session.path}>
			{renaming === session.path ? <input ref={renameRef} className="pd-session-rename" value={renameDraft} aria-label={t('sidebar.renameLabel')} onChange={(event) => setRenameDraft(event.target.value)} onKeyDown={(event) => {
				if (event.nativeEvent.isComposing) return;
				if (event.key === 'Enter') event.currentTarget.blur();
				if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); renameCancelled.current = true; setRenaming(null); }
			}} onBlur={() => { if (renameCancelled.current) return; setRenaming(null); void perform(() => updateSessionMeta(session.path, { name: renameDraft.trim() })); }} /> : <>
				<HoverTooltip title={title} description={`${session.workspace} · ${t('sidebar.messageCount', { count: session.messageCount })}`} side="right" align="start">
					<button type="button" className="pd-session-row" onClick={() => openSession(session)} disabled={status === 'starting' || navigating} aria-current={active ? 'page' : undefined}>
						{session.unread && <span className="pd-session-unread" aria-label={t('sidebar.unread')} />}
						<span className="pd-session-copy"><strong>{title}</strong>{source && <small>{workspaceName(session.workspace)}</small>}</span>
						{!archived && session.pinned && <Icon name="pin" width="11" height="11" className="pd-session-pin" />}
						<time dateTime={session.modified}>{dateLabel(session.modified)}</time>
					</button>
				</HoverTooltip>
				<div className="pd-session-actions"><HoverTooltip title={t('sidebar.menuTitle')} side="right"><button type="button" className="pd-session-more pd-icon-button" aria-label={t('sidebar.menuLabel', { title })} aria-haspopup="menu" aria-expanded={(popup?.kind === 'session' || popup?.kind === 'move') && popup.session.path === session.path} onClick={(event) => setPopup({ kind: 'session', anchor: event.currentTarget, session })}><Icon name="more" width="15" height="15" /></button></HoverTooltip></div>
			</>}
		</div>;
	}
	function unsaved(source = true) {
		return <div className="pd-session-item is-active"><div className="pd-session-row" aria-current="page"><span className="pd-session-copy"><strong>{t('sidebar.newSession')}</strong>{source && <small>{workspaceName(cwd)}</small>}</span><span className="pd-session-unsaved">{t('sidebar.current')}</span></div></div>;
	}
	function section(key: string, name: string, count: number, content: ReactNode, options: { icon?: 'hash' | 'folder' | 'pin' | 'clock'; group?: UiSessionGroup; workspace?: string } = {}) {
		const expanded = !collapsed.has(key);
		const color = options.group ? ['#9290d2', '#72a699', '#bc9683', '#749cbe'][[...options.group.id].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0, 0) % 4] : undefined;
		return <section className={`pd-sidebar-group${options.group ? ' is-custom' : ''}${options.workspace === cwd ? ' is-current' : ''}`} key={key} data-section-key={key} style={{ '--pd-group-color': color } as CSSProperties}>
			<div className="pd-sidebar-group-heading">
				<HoverTooltip title={name} description={options.workspace} align="start"><button type="button" className="pd-sidebar-group-toggle" aria-expanded={expanded} onClick={() => toggleSection(key)}>
					<Icon name={options.icon ?? 'hash'} width="14" height="14" /><span>{name}</span><Icon name="chevronRight" width="12" height="12" className={expanded ? 'is-expanded' : ''} /><small>{count}</small>
				</button></HoverTooltip>
				{options.group && <HoverTooltip title={t('sidebar.groupActions')}><button type="button" className="pd-icon-button pd-group-more" aria-label={t('sidebar.groupMenuLabel', { name })} aria-haspopup="menu" onClick={(event) => setPopup({ kind: 'group', anchor: event.currentTarget, group: options.group! })}><Icon name="more" width="15" height="15" /></button></HoverTooltip>}
				{options.workspace && <HoverTooltip title={t('sidebar.openProject')}><button type="button" className="pd-icon-button pd-group-more" aria-label={t('sidebar.activateProject', { name })} disabled={status === 'starting' || navigating} onClick={() => {
					if (navigationPending.current) return;
					navigationPending.current = true; setNavigating(true);
					void perform(async () => { try { await switchWorkspace(options.workspace!); } finally { navigationPending.current = false; setNavigating(false); } }, true);
				}}><Icon name="chevronRight" width="14" height="14" /></button></HoverTooltip>}
			</div>
			{expanded && <div className="pd-sidebar-group-content">{content}</div>}
		</section>;
	}
	const iconButton = (label: string, icon: Parameters<typeof Icon>[0]['name'], onClick: (element: HTMLButtonElement) => void, extra: { disabled?: boolean; active?: boolean; expanded?: boolean } = {}) => <HoverTooltip title={label}><button type="button" className={`pd-icon-button${extra.active ? ' is-active' : ''}`} aria-label={label} disabled={extra.disabled} aria-pressed={extra.active === undefined ? undefined : extra.active} aria-expanded={extra.expanded} onClick={(event) => onClick(event.currentTarget)}><Icon name={icon} width="14" height="14" /></button></HoverTooltip>;
	function radio(label: string, selected: boolean, action: () => void) {
		return <button type="button" role="menuitemradio" aria-checked={selected} onClick={action}><span>{label}</span>{selected && <Icon name="check" width="14" height="14" />}</button>;
	}
	const filtered = preferences.filter !== 'all';
	return <div className="pd-sidebar-detail pd-project-section pd-organized-sessions">
		<div className="pd-sidebar-organize-toolbar">
			<div className="pd-sidebar-mode" role="tablist" aria-label={t('sidebar.organize')}>
				{(['grouped', 'project'] as const).map((mode) => <button key={mode} type="button" role="tab" aria-selected={preferences.mode === mode} onClick={() => { preference({ mode }); setArchived(false); setPopup(null); }} onKeyDown={(event) => {
					if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'grouped' : event.key === 'End' ? 'project' : mode === 'grouped' ? 'project' : 'grouped'; preference({ mode: next }); setArchived(false); event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)?.focus(); }
				}} tabIndex={preferences.mode === mode ? 0 : -1} data-mode={mode}><Icon name={mode === 'grouped' ? 'hash' : 'folder'} width="12" height="12" />{t(mode === 'grouped' ? 'sidebar.groups' : 'sidebar.projects')}</button>)}
			</div>
			{iconButton(t(allExpanded ? 'sidebar.collapseAll' : 'sidebar.expandAll'), allExpanded ? 'collapseAll' : 'expandAll', toggleAll, { disabled: sectionKeys.length === 0 })}
			<div className="pd-sidebar-organize-actions">
				{iconButton(t('sidebar.newGroup'), 'hash', (anchor) => editGroup(anchor), { disabled: !bridge || groupsLoading || pending })}
				{iconButton(t('sidebar.filter'), 'filter', (anchor) => setPopup(popup?.kind === 'filter' ? null : { kind: 'filter', anchor }), { active: filtered, expanded: popup?.kind === 'filter' })}
				{iconButton(t(archived ? 'sidebar.closeArchive' : 'sidebar.showArchive'), archived ? 'close' : 'archive', () => { setArchived((value) => !value); setPopup(null); }, { active: archived })}
			</div>
		</div>
		{archived ? <div className="pd-sidebar-list-heading"><span>{t('sidebar.archived')} <small>{totalArchived}</small></span></div>
			: <div className="pd-sidebar-list-heading"><span>{t(preferences.mode === 'grouped' ? 'sidebar.sessions' : preferences.projectView === 'timeline' ? 'sidebar.byTime' : 'sidebar.projects')} <small>{preferences.mode === 'project' && preferences.projectView === 'project' ? workspacePaths.length : sessions.length}</small></span><div className="pd-section-actions">
				{iconButton(t('sidebar.refreshProjects'), 'refresh', () => void perform(refresh), { disabled: refreshing })}
				{iconButton(t('sidebar.openProject'), 'plus', () => void perform(pickWorkspace))}
			</div></div>}
		{filtered && <button type="button" className="pd-sidebar-filter-chip" aria-label={`${t(preferences.filter === 'unread' ? 'sidebar.onlyUnread' : 'sidebar.onlyPinned')} · ${t('sidebar.clearFilter')}`} onClick={() => preference({ filter: 'all' })}>{t(preferences.filter === 'unread' ? 'sidebar.onlyUnread' : 'sidebar.onlyPinned')}<Icon name="close" width="11" height="11" /></button>}
		<div className="pd-project-list pd-organized-list" onScroll={() => setPopup(null)}>
			{!archived && grouped.pinned.length > 0 && section('pinned', t('sidebar.pinned'), grouped.pinned.length, grouped.pinned.map((s) => renderSession(s)), { icon: 'pin' })}
			{archived || (preferences.mode === 'project' && preferences.projectView === 'timeline') ? <>
				{showUnsaved && unsaved()}
				{dates.map((date) => section(`${archived ? 'archive' : 'date'}:${date.id}`, t(`sidebar.${date.id}`), date.sessions.length, date.sessions.map((s) => renderSession(s)), { icon: 'clock' }))}
				{!sessions.length && !showUnsaved && <div className="pd-session-empty">{t(loadingSessions ? 'sidebar.loading' : filtered ? 'sidebar.noMatches' : archived ? 'sidebar.noArchived' : 'sidebar.noSessions')}</div>}
			</> : preferences.mode === 'grouped' ? groupsLoading ? <div className="pd-session-empty">{t('sidebar.loading')}</div> : groupsError ? <button type="button" className="pd-sidebar-retry" onClick={() => void perform(refresh)}>{t('sidebar.retryGroups')}</button> : <>
				{grouped.groups.map((group) => section(groupKey(group.id), group.name, group.sessions.length, group.sessions.length ? group.sessions.map((s) => renderSession(s)) : <div className="pd-session-empty pd-group-empty">{t(filtered ? 'sidebar.noMatches' : 'sidebar.emptyGroup')}</div>, { group: groups.find((g) => g.id === group.id) }))}
				{groups.length > 0 && (grouped.ungrouped.length > 0 || showUnsaved) && <div className="pd-sidebar-ungrouped-label">{t('sidebar.ungrouped')}</div>}
				{showUnsaved && unsaved()}
				{grouped.ungrouped.map((s) => renderSession(s))}
				{!sessions.length && !showUnsaved && !groups.length && <div className="pd-session-empty">{t(loadingSessions ? 'sidebar.loading' : filtered ? 'sidebar.noMatches' : 'sidebar.noSessions')}</div>}
			</> : <>
				{workspacePaths.map((workspace) => {
					const items = sessions.filter((s) => s.workspace === workspace && !s.pinned);
					return section(projectKey(workspace), workspaceName(workspace), items.length, <>
						{showUnsaved && workspace === cwd && unsaved(false)}
						{items.map((s) => renderSession(s, false))}
						{!items.length && !(showUnsaved && workspace === cwd) && <div className="pd-session-empty">{t(!Object.hasOwn(sessionsByWorkspace, workspace) ? 'sidebar.loading' : filtered ? 'sidebar.noMatches' : 'sidebar.noSessions')}</div>}
					</>, { icon: 'folder', workspace });
				})}
			</>}
			{!workspacePaths.length && !archived && <div className="pd-project-empty"><p>{t('sidebar.noProjects')}</p><button type="button" onClick={() => void perform(pickWorkspace)}>{t('sidebar.openFolder')}</button></div>}
		</div>
		{popup && <SidebarPopover key={popup.kind} anchor={popup.anchor} label={t(popup.kind === 'filter' ? 'sidebar.filter' : popup.kind === 'edit-group' ? popup.group ? 'sidebar.renameGroup' : 'sidebar.newGroup' : popup.kind === 'move' ? 'sidebar.moveToGroup' : popup.kind === 'group' ? 'sidebar.groupActions' : 'sidebar.menuTitle')} dialog={popup.kind === 'edit-group'} onClose={() => setPopup(null)}>
			{popup.kind === 'filter' && <>
				{preferences.mode === 'project' && !archived && <><div className="pd-sidebar-menu-label">{t('sidebar.organize')}</div>{radio(t('sidebar.byProject'), preferences.projectView === 'project', () => preference({ projectView: 'project' }))}{radio(t('sidebar.byTime'), preferences.projectView === 'timeline', () => preference({ projectView: 'timeline' }))}<hr /></>}
				<div className="pd-sidebar-menu-label">{t('sidebar.filter')}</div>
				{(['all', 'unread', 'pinned'] as const).map((filter) => <div key={filter}>{radio(t(filter === 'all' ? 'sidebar.allSessions' : filter === 'unread' ? 'sidebar.onlyUnread' : 'sidebar.onlyPinned'), preferences.filter === filter, () => preference({ filter }))}</div>)}
				<hr /><div className="pd-sidebar-menu-label">{t('sidebar.sortOrder')}</div>
				{radio(t('sidebar.sortRecent'), preferences.sort === 'newest', () => preference({ sort: 'newest' }))}{radio(t('sidebar.sortOldest'), preferences.sort === 'oldest', () => preference({ sort: 'oldest' }))}
			</>}
			{popup.kind === 'edit-group' && <form onSubmit={(event) => {
				event.preventDefault();
				if (!groupDraft.trim() || pendingRef.current) return;
				setFormError(null);
				const target = popup;
				void changeGroups(target.group ? { type: 'rename', id: target.group.id, name: groupDraft.trim() } : { type: 'create', name: groupDraft.trim() }).then((done) => {
					if (!done) return;
					if (popupRef.current === target) {
						if (!target.group) { preference({ mode: 'grouped' }); setArchived(false); }
						setPopup(null);
					}
				}).catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					if (popupRef.current === target) setFormError(message); else onError(message);
				});
			}}>
				<label htmlFor="pd-sidebar-group-name">{t(popup.group ? 'sidebar.renameGroup' : 'sidebar.newGroup')}</label>
				<input id="pd-sidebar-group-name" maxLength={80} value={groupDraft} placeholder={t('sidebar.groupName')} disabled={pending} onChange={(event) => setGroupDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }} />
				{formError && <p role="alert">{formError}</p>}
				<div className="pd-sidebar-form-actions"><button type="button" onClick={() => { setPopup(null); popup.anchor.focus(); }}>{t('sidebar.cancel')}</button><button type="submit" disabled={!groupDraft.trim() || pending}>{t(pending ? 'sidebar.saving' : 'sidebar.save')}</button></div>
			</form>}
			{popup.kind === 'group' && <><button type="button" role="menuitem" onClick={() => editGroup(popup.anchor, popup.group)}>{t('sidebar.renameGroup')}</button><button type="button" role="menuitem" disabled={pending} onClick={() => { const group = popup.group; setPopup(null); void perform(async () => { await changeGroups({ type: 'delete', id: group.id }); }); }}>{t('sidebar.dissolveGroup')}</button><p className="pd-sidebar-menu-note">{t('sidebar.dissolveGroupHint')}</p></>}
			{popup.kind === 'session' && <>
				<button type="button" role="menuitem" onClick={() => { renameCancelled.current = false; setRenaming(popup.session.path); setRenameDraft(titleOf(popup.session)); setPopup(null); }}>{t('sidebar.rename')}</button>
				<button type="button" role="menuitem" onClick={() => { const s = popup.session; sessionAction(s, popup.anchor, () => updateSessionMeta(s.path, { pinned: !s.pinned })); }}>{t(popup.session.pinned ? 'sidebar.unpin' : 'sidebar.pin')}</button>
				<button type="button" role="menuitem" disabled={groupsLoading || groupsError || pending} onClick={() => setPopup({ ...popup, kind: 'move' })}>{t('sidebar.moveToGroup')}<Icon name="chevronRight" width="13" height="13" /></button>
				<button type="button" role="menuitem" onClick={() => { const s = popup.session; sessionAction(s, popup.anchor, () => updateSessionMeta(s.path, { unread: !s.unread })); }}>{t(popup.session.unread ? 'sidebar.markRead' : 'sidebar.markUnread')}</button>
				<hr /><button type="button" role="menuitem" onClick={() => { const s = popup.session; sessionAction(s, popup.anchor, () => updateSessionMeta(s.path, { archived: !s.archived })); }}>{t(popup.session.archived ? 'sidebar.unarchive' : 'sidebar.archive')}</button>
			</>}
			{popup.kind === 'move' && <>
				<button type="button" role="menuitem" onClick={() => setPopup({ ...popup, kind: 'session' })}>{t('sidebar.back')}</button><hr />
				{[null, ...groups].map((group) => <div key={group?.id ?? 'ungrouped'}>{radio(group?.name ?? t('sidebar.ungrouped'), group ? group.sessionPaths.includes(popup.session.path) : !groups.some((g) => g.sessionPaths.includes(popup.session.path)), () => {
					const session = popup.session; sessionAction(session, popup.anchor, async () => { await changeGroups({ type: 'move-session', sessionPath: session.path, groupId: group?.id ?? null }); });
				})}</div>)}
				{groups.length === 0 && <p className="pd-sidebar-menu-note">{t('sidebar.createGroupFirst')}</p>}
			</>}
		</SidebarPopover>}
	</div>;
}
