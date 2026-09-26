import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { UiSessionGroup, UiSidebarGroupChange } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { buildSidebarGroups, clearPinnedProjects, collectSidebarSessions, groupSessionsByDate, orderSessions, readPinnedProjects, readSidebarPreferences, saveSidebarPreferences, selectSidebarSessions, type SidebarPreferences, type SidebarSession } from '../sidebarOrganization';
import { HoverTooltip } from './HoverTooltip';
import { Icon } from './Icons';
import { SidebarPopover } from './SidebarPopover';
import './sidebarOrganization.css';

type Popup = { anchor: HTMLElement } & (
	| { kind: 'filter' }
	| { kind: 'session' | 'move'; session: SidebarSession }
	| { kind: 'group'; group: UiSessionGroup }
	| { kind: 'project'; workspace: string }
	| { kind: 'edit-group'; group?: UiSessionGroup }
);

/** A sidebar list that participates in drag reordering. */
type DragSection = { key: string; sessions: SidebarSession[] };

type DragItem =
	| { kind: 'session'; path: string; from: string }
	| { kind: 'group'; id: string };

/**
 * Live drag arrangement following zcode's sidebar logic: rows reorder in
 * place while hovering (the insertion side follows the vertical drag
 * direction), collapsed groups receive drops, dragged groups auto-collapse,
 * and the final arrangement is persisted optimistically on drop.
 */
type DragState = {
	item: DragItem;
	direction: 'before' | 'after';
	/** Ordered paths for every container touched by the current drag. */
	orders: Map<string, string[]>;
	/** Preview group order while dragging a group heading. */
	groupOrder: string[] | null;
	ghost: { x: number; y: number; width: number };
};

const workspaceName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const groupKey = (id: string) => `group:${id}`;
const projectKey = (path: string) => `project:${path}`;
const UNGROUPED_KEY = 'ungrouped';
const DRAG_THRESHOLD = 5;
const EDGE_SCROLL_MARGIN = 28;
const EDGE_SCROLL_STEP = 9;

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
	const removeWorkspace = useChatStore((s) => s.removeWorkspace);
	const newSession = useChatStore((s) => s.newSession);
	const refreshWorkspaces = useChatStore((s) => s.refreshWorkspaces);
	const refreshWorkspaceSessions = useChatStore((s) => s.refreshWorkspaceSessions);
	const selectSession = useChatStore((s) => s.selectSession);
	const updateSessionMeta = useChatStore((s) => s.updateSessionMeta);
	const updateSessionOrders = useChatStore((s) => s.updateSessionOrders);
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
	const [pinnedProjects, setPinnedProjects] = useState<string[]>(readPinnedProjects);
	const listed = useRef(new Set<string>());
	const listedBridge = useRef<typeof bridge>(null);
	const workspacePaths = useMemo(() => cwd && !workspaces.includes(cwd) ? [cwd, ...workspaces] : workspaces, [cwd, workspaces]);
	const pinnedWorkspaceSet = useMemo(() => new Set(pinnedProjects), [pinnedProjects]);
	// Pinned projects float to the top (stable sort keeps relative order).
	const orderedWorkspaces = useMemo(() => [...workspacePaths].sort((a, b) => Number(pinnedWorkspaceSet.has(b)) - Number(pinnedWorkspaceSet.has(a))), [workspacePaths, pinnedWorkspaceSet]);
	const allSessions = useMemo(() => collectSidebarSessions(workspacePaths, sessionsByWorkspace), [workspacePaths, sessionsByWorkspace]);
	const sessions = useMemo(() => selectSidebarSessions(allSessions, { archived, filter: preferences.filter, sort: preferences.sort }), [allSessions, archived, preferences.filter, preferences.sort]);
	const grouped = useMemo(() => buildSidebarGroups(sessions, groups), [sessions, groups]);
	const sessionByPath = useMemo(() => new Map(sessions.map((session) => [session.path, session])), [sessions]);
	const dragMode = !archived && (preferences.mode === 'grouped' || preferences.projectView === 'project');
	const dragSections = useMemo<DragSection[]>(() => {
		if (!dragMode) return [];
		if (preferences.mode === 'grouped') {
			return [...grouped.groups.map((group) => ({ key: groupKey(group.id), sessions: group.sessions })),
				{ key: UNGROUPED_KEY, sessions: grouped.ungrouped }];
		}
		return orderedWorkspaces.map((workspace) => ({ key: projectKey(workspace), sessions: orderSessions(sessions.filter((session) => session.workspace === workspace && !session.pinned)) }));
	}, [dragMode, preferences.mode, grouped, sessions, orderedWorkspaces]);
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

	// --- Drag state (zcode-style live reordering) -------------------------------
	const [drag, setDrag] = useState<DragState | null>(null);
	const dragRef = useRef<DragState | null>(null);
	dragRef.current = drag;
	/** Container orders frozen at drag start, like zcode's origin view snapshot. */
	const dragSnapshot = useRef<Map<string, string[]> | null>(null);
	const pressRef = useRef<{ item: DragItem; startX: number; startY: number; width: number } | null>(null);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const scrollFrameRef = useRef<number | null>(null);
	const pointerRef = useRef({ x: 0, y: 0 });

	useEffect(() => { saveSidebarPreferences(preferences); }, [preferences]);
	useEffect(() => { if (!visible) setPopup(null); }, [visible]);
	useEffect(() => {
		if (!bridge || workspacePaths.length === 0) return;
		let cancelled = false;
		const legacy = readPinnedProjects();
		void (async () => {
			const persisted = await bridge.listPinnedWorkspaces();
			const registered = new Set(workspacePaths);
			const migration = legacy.filter((path) => registered.has(path));
			const next = persisted.length === 0 && migration.length > 0 ? await bridge.setPinnedWorkspaces(migration) : persisted;
			if (cancelled) return;
			setPinnedProjects(next);
			clearPinnedProjects();
		})().catch((error: unknown) => {
			if (!cancelled) onError(error instanceof Error ? error.message : String(error));
		});
		return () => { cancelled = true; };
	}, [bridge, workspacePaths, onError]);
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
	useEffect(() => () => {
		pressRef.current = null;
		dragRef.current = null;
		if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
		document.body.classList.remove('pd-sidebar-dragging');
	}, []);

	function snapshotOrder(key: string): string[] {
		return dragSnapshot.current?.get(key) ?? dragSections.find((section) => section.key === key)?.sessions.map((session) => session.path) ?? [];
	}

	/** Preview orders for a container: drag overrides, else the frozen snapshot. */
	function previewOrder(key: string): string[] {
		return dragRef.current?.orders.get(key) ?? snapshotOrder(key);
	}

	/**
	 * Resolve the drop target under the pointer: a session row (insert
	 * before/after by drag direction, zcode semantics), an expanded section
	 * heading (prepend), or a collapsed heading / list tail (append).
	 */
	function resolveDrop(state: DragState): { container: string; index: number } | null {
		if (!dragSnapshot.current) return null;
		const element = document.elementFromPoint(pointerRef.current.x, pointerRef.current.y);
		const containerElement = element?.closest<HTMLElement>('[data-drag-container]');
		if (!containerElement) return null;
		const container = containerElement.dataset.dragContainer!;
		if (container.startsWith('project:') && state.item.kind === 'session' && state.item.from !== container) return null;
		const current = state.orders.get(container) ?? snapshotOrder(container);
		const row = element?.closest<HTMLElement>('[data-drag-path]');
		const rowPath = row?.dataset.dragPath;
		if (rowPath && current.includes(rowPath)) {
			if (rowPath === (state.item.kind === 'session' ? state.item.path : '')) return null;
			const rowIndex = current.indexOf(rowPath);
			const removeIndex = state.item.kind === 'session' && state.item.from === container ? current.indexOf(state.item.path) : -1;
			let index = state.direction === 'after' ? rowIndex + 1 : rowIndex;
			if (removeIndex >= 0 && removeIndex < index) index -= 1;
			return { container, index };
		}
		const heading = element?.closest<HTMLElement>('[data-drag-heading]');
		if (heading) return { container, index: collapsed.has(container) ? current.length : 0 };
		return { container, index: current.length };
	}

	function applyDropPreview(state: DragState): DragState {
		const item = state.item;
		if (item.kind === 'group') {
			const element = document.elementFromPoint(pointerRef.current.x, pointerRef.current.y);
			const heading = element?.closest<HTMLElement>('[data-drag-heading]')?.dataset.dragHeading;
			if (!heading?.startsWith('group:')) return state;
			const targetId = heading.slice(groupKey('').length);
			const ids = state.groupOrder ?? groups.map((group) => group.id);
			const from = ids.indexOf(item.id);
			const to = ids.indexOf(targetId);
			if (from < 0 || to < 0 || from === to) return state;
			const next = [...ids];
			next.splice(to, 0, next.splice(from, 1)[0]!);
			return { ...state, groupOrder: next };
		}
		const drop = resolveDrop(state);
		if (!drop) return state;
		const orders = new Map(state.orders);
		const origin = orders.get(item.from) ?? snapshotOrder(item.from);
		orders.set(item.from, origin.filter((path) => path !== item.path));
		// Cross-container hovers can leave the path in an earlier target; always
		// insert into a deduplicated list so the preview never duplicates a row.
		const target = (orders.get(drop.container) ?? snapshotOrder(drop.container)).filter((path) => path !== item.path);
		const insertAt = Math.max(0, Math.min(drop.index, target.length));
		orders.set(drop.container, [...target.slice(0, insertAt), item.path, ...target.slice(insertAt)]);
		return { ...state, orders };
	}

	function edgeScroll(): void {
		const container = scrollRef.current;
		if (!dragRef.current || !container) { scrollFrameRef.current = null; return; }
		const rect = container.getBoundingClientRect();
		const y = pointerRef.current.y;
		if (y < rect.top + EDGE_SCROLL_MARGIN) container.scrollTop -= EDGE_SCROLL_STEP;
		else if (y > rect.bottom - EDGE_SCROLL_MARGIN) container.scrollTop += EDGE_SCROLL_STEP;
		scrollFrameRef.current = requestAnimationFrame(edgeScroll);
	}

	function beginDrag(item: DragItem, event: ReactPointerEvent): void {
		if (event.button !== 0) return;
		if (status === 'starting' || navigating || dragRef.current) return;
		if (item.kind === 'session' && renaming === item.path) return;
		const row = event.currentTarget as HTMLElement;
		pressRef.current = { item, startX: event.clientX, startY: event.clientY, width: row.getBoundingClientRect().width || 240 };
	}

	function onPointerMove(event: PointerEvent): void {
		pointerRef.current = { x: event.clientX, y: event.clientY };
		const press = pressRef.current;
		if (press) {
			if (Math.abs(event.clientX - press.startX) < DRAG_THRESHOLD && Math.abs(event.clientY - press.startY) < DRAG_THRESHOLD) return;
			pressRef.current = null;
			dragSnapshot.current = new Map(dragSections.map((section) => [section.key, section.sessions.map((session) => session.path)]));
			let next: DragState = {
				item: press.item,
				direction: event.clientY >= press.startY ? 'after' : 'before',
				orders: new Map(),
				groupOrder: null,
				ghost: { x: event.clientX, y: event.clientY, width: press.width },
			};
			next = applyDropPreview(next);
			dragRef.current = next;
			setDrag(next);
			document.body.classList.add('pd-sidebar-dragging');
			if (scrollFrameRef.current === null) scrollFrameRef.current = requestAnimationFrame(edgeScroll);
			return;
		}
		const state = dragRef.current;
		if (!state) return;
		const direction = event.clientY > state.ghost.y ? 'after' : event.clientY < state.ghost.y ? 'before' : state.direction;
		let next: DragState = { ...state, direction, ghost: { ...state.ghost, x: event.clientX, y: event.clientY } };
		next = applyDropPreview(next);
		dragRef.current = next;
		if (next.direction !== state.direction || next.groupOrder !== state.groupOrder || ordersSignature(next.orders) !== ordersSignature(state.orders) || next.ghost !== state.ghost) setDrag(next);
	}

	function finishDrag(commit: boolean): void {
		const state = dragRef.current;
		pressRef.current = null;
		if (scrollFrameRef.current !== null) { cancelAnimationFrame(scrollFrameRef.current); scrollFrameRef.current = null; }
		document.body.classList.remove('pd-sidebar-dragging');
		if (!state) { setDrag(null); return; }
		dragRef.current = null;
		dragSnapshot.current = null;
		setDrag(null);
		if (!commit) return;
		const item = state.item;
		if (item.kind === 'group') {
			if (!state.groupOrder || state.groupOrder.join(',') === groups.map((group) => group.id).join(',')) return;
			void perform(async () => { await changeGroups({ type: 'reorder-groups', ids: state.groupOrder! }); });
			return;
		}
		const targetKey = [...state.orders.keys()].find((key) => key !== item.from && (state.orders.get(key) ?? []).includes(item.path));
		const entries: { path: string; order: number }[] = [];
		for (const paths of state.orders.values()) paths.forEach((path, index) => entries.push({ path, order: index }));
		if (targetKey !== undefined && preferences.mode === 'grouped') {
			const groupId = targetKey === UNGROUPED_KEY ? null : targetKey.slice(groupKey('').length);
			const index = Math.max(0, (state.orders.get(targetKey) ?? []).indexOf(item.path));
			void perform(async () => {
				await changeGroups({ type: 'move-session', sessionPath: item.path, groupId, index });
				if (entries.length) await updateSessionOrders(entries);
			});
			return;
		}
		if (entries.length) void perform(() => updateSessionOrders(entries));
	}

	// Window-level drag phase listeners stay bound for the panel's lifetime:
	// the press→drag transition itself must be observed (the first move fires
	// outside the pressed row), and closures are refreshed through a ref.
	const dragHandlers = useRef({ move: (_: PointerEvent) => {}, up: () => {}, cancel: () => {}, key: (_: KeyboardEvent) => {} });
	dragHandlers.current = {
		move: (event) => onPointerMove(event),
		up: () => finishDrag(true),
		cancel: () => finishDrag(false),
		key: (event) => { if (event.key === 'Escape') finishDrag(false); },
	};
	useEffect(() => {
		const move = (event: PointerEvent) => dragHandlers.current.move(event);
		const up = () => dragHandlers.current.up();
		const cancel = () => dragHandlers.current.cancel();
		const key = (event: KeyboardEvent) => dragHandlers.current.key(event);
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', cancel);
		window.addEventListener('keydown', key);
		return () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', cancel);
			window.removeEventListener('keydown', key);
		};
	}, []);

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
	function renderSession(session: SidebarSession, container: string | null, source = true) {
		const active = session.workspace === cwd && session.path === sessionPath;
		const title = titleOf(session);
		const dragItem = drag?.item;
		const isDragSource = dragItem?.kind === 'session' && dragItem.path === session.path;
		return <div className={`pd-session-item${active ? ' is-active' : ''}${isDragSource ? ' is-drag-source' : ''}`} key={session.path} data-session-path={session.path}
			data-drag-path={container ?? undefined} onPointerDown={container && dragMode ? (event) => beginDrag({ kind: 'session', path: session.path, from: container }, event) : undefined}>
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
	function renderOrdered(key: string, source = true) {
		return previewOrder(key).map((path) => sessionByPath.get(path)).filter((session): session is SidebarSession => Boolean(session)).map((session) => renderSession(session, key, source));
	}
	function unsaved(source = true) {
		return <div className="pd-session-item is-active"><div className="pd-session-row" aria-current="page"><span className="pd-session-copy"><strong>{t('sidebar.newSession')}</strong>{source && <small>{workspaceName(cwd)}</small>}</span><span className="pd-session-unsaved">{t('sidebar.current')}</span></div></div>;
	}
	function section(key: string, name: string, count: number, content: ReactNode, options: { icon?: 'hash' | 'folder' | 'pin' | 'clock'; group?: UiSessionGroup; workspace?: string } = {}) {
		const dragItem = drag?.item;
		const draggingGroup = dragItem?.kind === 'group';
		const isDraggedGroup = dragItem?.kind === 'group' && dragItem.id === options.group?.id;
		const expanded = !collapsed.has(key) && !isDraggedGroup;
		const color = options.group ? ['#9290d2', '#72a699', '#bc9683', '#749cbe'][[...options.group.id].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0, 0) % 4] : undefined;
		const droppable = (options.group !== undefined || options.workspace !== undefined) && dragMode;
		return <section className={`pd-sidebar-group${options.group ? ' is-custom' : ''}${options.workspace === cwd ? ' is-current' : ''}`} key={key} data-section-key={key} style={{ '--pd-group-color': color } as CSSProperties}>
			<HoverTooltip title={name} description={options.workspace} side="right" align="start"><div className="pd-sidebar-group-heading" data-drag-heading={droppable ? key : undefined} data-drag-container={droppable ? key : undefined} onContextMenu={options.workspace ? (event) => { event.preventDefault(); setPopup({ kind: 'project', anchor: event.currentTarget, workspace: options.workspace! }); } : undefined}>
				<button type="button" className="pd-sidebar-group-toggle" aria-expanded={expanded} onPointerDown={options.group && dragMode && !draggingGroup ? (event) => beginDrag({ kind: 'group', id: options.group!.id }, event) : undefined} onClick={() => toggleSection(key)}>
					<Icon name={options.icon ?? 'hash'} width="14" height="14" /><span>{name}</span><Icon name="chevronRight" width="12" height="12" className={expanded ? 'is-expanded' : ''} /><small>{count}</small>
				</button>
				{options.group && <HoverTooltip title={t('sidebar.groupActions')} side="right"><button type="button" className="pd-icon-button pd-group-more" aria-label={t('sidebar.groupMenuLabel', { name })} aria-haspopup="menu" onClick={(event) => setPopup({ kind: 'group', anchor: event.currentTarget, group: options.group! })}><Icon name="more" width="15" height="15" /></button></HoverTooltip>}
				{options.workspace && <HoverTooltip title={t('sidebar.projectNewChat')} side="right"><button type="button" className="pd-icon-button pd-group-more" aria-label={t('sidebar.projectNewChat')} disabled={status === 'starting' || navigating} onClick={() => {
					if (navigationPending.current) return;
					navigationPending.current = true; setNavigating(true);
					void perform(async () => { try { await switchWorkspace(options.workspace!); await newSession(); } finally { navigationPending.current = false; setNavigating(false); } }, true);
				}}><Icon name="plus" width="14" height="14" /></button></HoverTooltip>}
				{options.workspace && <HoverTooltip title={t('sidebar.projectActions')} side="right"><button type="button" className="pd-icon-button pd-group-more" aria-label={t('sidebar.projectMenuLabel', { name })} aria-haspopup="menu" aria-expanded={popup?.kind === 'project' && popup.workspace === options.workspace} onClick={(event) => setPopup({ kind: 'project', anchor: event.currentTarget, workspace: options.workspace! })}><Icon name="more" width="15" height="15" /></button></HoverTooltip>}
			</div></HoverTooltip>
			{expanded && <div className="pd-sidebar-group-content" data-drag-container={droppable ? key : undefined}>{content}{droppable && drag && <div className="pd-session-drop-zone" data-drag-footer />}</div>}
		</section>;
	}
	const iconButton = (label: string, icon: Parameters<typeof Icon>[0]['name'], onClick: (element: HTMLButtonElement) => void, extra: { disabled?: boolean; active?: boolean; expanded?: boolean } = {}) => <HoverTooltip title={label}><button type="button" className={`pd-icon-button${extra.active ? ' is-active' : ''}`} aria-label={label} disabled={extra.disabled} aria-pressed={extra.active === undefined ? undefined : extra.active} aria-expanded={extra.expanded} onClick={(event) => onClick(event.currentTarget)}><Icon name={icon} width="14" height="14" /></button></HoverTooltip>;
	function radio(label: string, selected: boolean, action: () => void) {
		return <button type="button" role="menuitemradio" aria-checked={selected} onClick={action}><span>{label}</span>{selected && <Icon name="check" width="14" height="14" />}</button>;
	}
	const filtered = preferences.filter !== 'all';
	const orderedGroupIds = drag?.groupOrder ?? groups.map((group) => group.id);
	const dragItem = drag?.item;
	const ghostSession = dragItem?.kind === 'session' ? sessionByPath.get(dragItem.path) : null;
	const ghostGroup = dragItem?.kind === 'group' ? groups.find((group) => group.id === dragItem.id) : null;
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
		<div className="pd-project-list pd-organized-list" ref={scrollRef} onScroll={() => setPopup(null)}>
			{!archived && grouped.pinned.length > 0 && section('pinned', t('sidebar.pinned'), grouped.pinned.length, grouped.pinned.map((s) => renderSession(s, null)), { icon: 'pin' })}
			{archived || (preferences.mode === 'project' && preferences.projectView === 'timeline') ? <>
				{showUnsaved && unsaved()}
				{dates.map((date) => section(`${archived ? 'archive' : 'date'}:${date.id}`, t(`sidebar.${date.id}`), date.sessions.length, date.sessions.map((s) => renderSession(s, null)), { icon: 'clock' }))}
				{!sessions.length && !showUnsaved && <div className="pd-session-empty">{t(loadingSessions ? 'sidebar.loading' : filtered ? 'sidebar.noMatches' : archived ? 'sidebar.noArchived' : 'sidebar.noSessions')}</div>}
			</> : preferences.mode === 'grouped' ? groupsLoading ? <div className="pd-session-empty">{t('sidebar.loading')}</div> : groupsError ? <button type="button" className="pd-sidebar-retry" onClick={() => void perform(refresh)}>{t('sidebar.retryGroups')}</button> : <>
				{orderedGroupIds.map((id) => {
					const group = grouped.groups.find((entry) => entry.id === id);
					if (!group) return null;
					return section(groupKey(group.id), group.name, group.sessions.length, <>
						{renderOrdered(groupKey(group.id))}
						{!group.sessions.length && <div className="pd-session-empty pd-group-empty">{t(filtered ? 'sidebar.noMatches' : 'sidebar.emptyGroup')}</div>}
					</>, { group: groups.find((g) => g.id === group.id) });
				})}
				{groups.length > 0 && (grouped.ungrouped.length > 0 || showUnsaved) && <div className="pd-sidebar-ungrouped-label">{t('sidebar.ungrouped')}</div>}
				{showUnsaved && unsaved()}
				<div className="pd-sidebar-ungrouped-list" data-drag-container={dragMode ? UNGROUPED_KEY : undefined}>
					{renderOrdered(UNGROUPED_KEY)}
					{!grouped.ungrouped.length && !showUnsaved && <div className="pd-session-empty">{t(filtered ? 'sidebar.noMatches' : 'sidebar.noSessions')}</div>}
				</div>
				{!sessions.length && !showUnsaved && !groups.length && <div className="pd-session-empty">{t(loadingSessions ? 'sidebar.loading' : filtered ? 'sidebar.noMatches' : 'sidebar.noSessions')}</div>}
			</> : <>
				{orderedWorkspaces.map((workspace) => {
					const items = sessions.filter((s) => s.workspace === workspace && !s.pinned);
					return section(projectKey(workspace), workspaceName(workspace), items.length, <>
						{showUnsaved && workspace === cwd && unsaved(false)}
						{renderOrdered(projectKey(workspace), false)}
						{!items.length && !(showUnsaved && workspace === cwd) && <div className="pd-session-empty">{t(!Object.hasOwn(sessionsByWorkspace, workspace) ? 'sidebar.loading' : filtered ? 'sidebar.noMatches' : 'sidebar.noSessions')}</div>}
					</>, { icon: pinnedWorkspaceSet.has(workspace) ? 'pin' : 'folder', workspace });
				})}
			</>}
			{!workspacePaths.length && !archived && <div className="pd-project-empty"><p>{t('sidebar.noProjects')}</p><button type="button" onClick={() => void perform(pickWorkspace)}>{t('sidebar.openFolder')}</button></div>}
		</div>
		{drag && (ghostSession || ghostGroup) && <div className="pd-sidebar-drag-ghost" style={{ left: drag.ghost.x, top: drag.ghost.y, width: drag.ghost.width }} aria-hidden>
			{ghostGroup ? <><Icon name="hash" width="14" height="14" /><span>{ghostGroup.name}</span></> : <span>{titleOf(ghostSession!)}</span>}
		</div>}
		{popup && <SidebarPopover key={popup.kind} anchor={popup.anchor} label={t(popup.kind === 'filter' ? 'sidebar.filter' : popup.kind === 'edit-group' ? popup.group ? 'sidebar.renameGroup' : 'sidebar.newGroup' : popup.kind === 'move' ? 'sidebar.moveToGroup' : popup.kind === 'group' ? 'sidebar.groupActions' : popup.kind === 'project' ? 'sidebar.projectActions' : 'sidebar.menuTitle')} dialog={popup.kind === 'edit-group'} onClose={() => setPopup(null)}>
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
			{popup.kind === 'project' && <>
				<button type="button" role="menuitem" disabled={status === 'starting' || navigating} onClick={() => {
					const workspace = popup.workspace;
					if (navigationPending.current) return;
					navigationPending.current = true; setNavigating(true); setPopup(null);
					void perform(async () => { try { await switchWorkspace(workspace); } finally { navigationPending.current = false; setNavigating(false); } }, true);
				}}>{t('sidebar.openProject')}</button>
				<button type="button" role="menuitem" disabled={!bridge} onClick={() => {
					const workspace = popup.workspace;
					const next = pinnedWorkspaceSet.has(workspace) ? pinnedProjects.filter((path) => path !== workspace) : [...pinnedProjects, workspace];
					setPopup(null);
					void perform(async () => {
						if (!bridge) return;
						setPinnedProjects(await bridge.setPinnedWorkspaces(next));
						clearPinnedProjects();
					});
				}}>{t(pinnedWorkspaceSet.has(popup.workspace) ? 'sidebar.projectUnpin' : 'sidebar.projectPin')}</button>
				<button type="button" role="menuitem" onClick={() => { const workspace = popup.workspace; setPopup(null); void perform(() => bridge ? bridge.openWorkspaceFolder(workspace) : Promise.resolve()); }}>{t('sidebar.projectReveal')}</button>
				<hr /><button type="button" role="menuitem" onClick={() => { const workspace = popup.workspace; setPopup(null); void perform(async () => { await removeWorkspace(workspace); setPinnedProjects((current) => current.filter((path) => path !== workspace)); }); }}>{t('sidebar.projectRemove')}</button>
				<p className="pd-sidebar-menu-note">{t('sidebar.projectRemoveHint')}</p>
			</>}
			{popup.kind === 'group' && <><button type="button" role="menuitem" onClick={() => editGroup(popup.anchor, popup.group)}>{t('sidebar.renameGroup')}</button><button type="button" role="menuitem" disabled={pending} onClick={() => { const group = popup.group; setPopup(null); void perform(async () => { await changeGroups({ type: 'delete', id: group.id }); }); }}>{t('sidebar.dissolveGroup')}</button><p className="pd-sidebar-menu-note">{t('sidebar.dissolveGroupHint')}</p></>}
			{popup.kind === 'session' && <>
				<button type="button" role="menuitem" onClick={() => { renameCancelled.current = false; setRenaming(popup.session.path); setRenameDraft(titleOf(popup.session)); setPopup(null); }}>{t('sidebar.rename')}</button>
				<button type="button" role="menuitem" onClick={() => { const s = popup.session; sessionAction(s, popup.anchor, () => updateSessionMeta(s.path, { pinned: !s.pinned })); }}>{t(popup.session.pinned ? 'sidebar.unpin' : 'sidebar.pin')}</button>
				<button type="button" role="menuitem" disabled={groupsLoading || groupsError || pending} onClick={() => setPopup({ ...popup, kind: 'move' })}>{t('sidebar.moveToGroup')}<Icon name="chevronRight" width="13" height="13" /></button>
				<button type="button" role="menuitem" onClick={() => { const s = popup.session; sessionAction(s, popup.anchor, () => updateSessionMeta(s.path, { unread: !s.unread })); }}>{t(popup.session.unread ? 'sidebar.markRead' : 'sidebar.markUnread')}</button>
				<hr /><button type="button" role="menuitem" onClick={() => { const s = popup.session; sessionAction(s, popup.anchor, () => updateSessionMeta(s.path, { archived: !s.archived })); }}>{t(popup.session.archived ? 'sidebar.unarchive' : 'sidebar.archive')}</button>
				<button type="button" role="menuitem" className="pd-sidebar-menu-danger" onClick={() => {
					const s = popup.session;
					sessionAction(s, popup.anchor, async () => {
						if (!window.confirm(t('sidebar.deleteConfirm'))) return;
						await useChatStore.getState().deleteSession(s.path);
					});
				}}>{t('sidebar.deleteSession')}</button>
			</>}
			{popup.kind === 'move' && <>
				<button type="button" role="menuitem" onClick={() => setPopup({ ...popup, kind: 'session' })}>{t('sidebar.back')}</button><hr />
				{[null, ...groups].map((group) => <div key={group?.id ?? 'ungrouped'}>{radio(group?.name ?? t('sidebar.ungrouped'), group ? group.sessionPaths.includes(popup.session.path) : !groups.some((g) => g.sessionPaths.includes(popup.session.path)), () => {
					const session = popup.session; sessionAction(session, popup.anchor, async () => {
						await changeGroups({ type: 'move-session', sessionPath: session.path, groupId: group?.id ?? null });
						await updateSessionOrders([{ path: session.path, order: null }]);
					});
				})}</div>)}
				{groups.length === 0 && <p className="pd-sidebar-menu-note">{t('sidebar.createGroupFirst')}</p>}
			</>}
		</SidebarPopover>}
	</div>;
}

function ordersSignature(orders: Map<string, string[]>): string {
	return [...orders.entries()].map(([key, paths]) => `${key}:${paths.join('\u0001')}`).join('\u0002');
}
