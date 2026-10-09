import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { UiSessionGroup, UiSidebarGroupChange } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { managementCopy } from '../managementCopy';
import { sessionRuntimeKey, summarizeSessionStates } from '../managementState';
import { operationFeedback } from '../operationFeedback';
import type { ContextMenuPoint } from '../contextMenuPosition';
import { changedSidebarOrders, moveSidebarProject, moveSidebarSession } from '../sidebarDrag';
import { isConversationWorkspace } from '../sidebarOrganization';
import { SessionTrashDialog } from './SessionTrashDialog';
import { SessionBulkTrashDialog, type SessionTrashTarget } from './SessionBulkTrashDialog';
import { ProjectCreationDialog } from './ProjectCreationDialog';
import { ProjectRemovalDialog, type ProjectRemovalSummary } from './ProjectRemovalDialog';
import { buildSidebarGroups, buildSidebarProjectGroups, clearPinnedProjects, collectSidebarSessions, groupSessionsByDate, mergeSidebarProjectOrder, orderSidebarProjects, readPinnedProjects, readSidebarPreferences, reorderSidebarProjectPositions, saveSidebarPreferences, selectSidebarSessions, sidebarProjectPaths, sidebarWorkspaceKey, splitSidebarProjects, type SidebarPreferences, type SidebarSession } from '../sidebarOrganization';
import { HoverTooltip } from './HoverTooltip';
import { Icon } from './Icons';
import { SidebarPopover } from './SidebarPopover';
import { SidebarSessionTitle } from './SidebarSessionTitle';
import './sidebarOrganization.css';

type Popup = { anchor: HTMLElement; trigger?: HTMLElement; point?: ContextMenuPoint } & (
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
	| { kind: 'group'; id: string }
	| { kind: 'project'; workspace: string };

/**
 * Live drag arrangement following zcode's sidebar logic: rows reorder in
 * place while hovering (the insertion side follows the vertical drag
 * direction), collapsed groups receive drops, dragged groups auto-collapse,
 * and the final arrangement is persisted optimistically on drop.
 */
type DragState = {
	item: DragItem;
	pointerId: number;
	direction: 'before' | 'after';
	/** Complete arrangement: a dragged session belongs to exactly one container. */
	orders: Map<string, string[]>;
	/** Preview group order while dragging a group heading. */
	groupOrder: string[] | null;
	/** Project rows stay in place until drop, with a precise insertion indicator. */
	projectOrder: string[] | null;
	projectDrop: { workspace: string; edge: 'before' | 'after' } | null;
	ghost: { x: number; y: number; width: number };
};

const workspaceName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const groupKey = (id: string) => `group:${id}`;
const projectKey = (path: string) => `project:${path}`;
const UNGROUPED_KEY = 'ungrouped';
const UNASSIGNED_KEY = 'unassigned';
// zcode workspaceTaskPagination: each section shows a small first page and grows
// on demand; a stored larger limit is never reset by the default page, and
// collapsing a section clears its memory so the map cannot grow unbounded.
const SECTION_PAGE_SIZE = 5;
const DRAG_THRESHOLD = 5;
const PROJECT_DRAG_THRESHOLD = 6;
const EDGE_SCROLL_MARGIN = 28;
const EDGE_SCROLL_STEP = 9;

export function SidebarSessionPanel({ visible, projectRevealRequest = 0, onNavigate, onError }: { visible: boolean; projectRevealRequest?: number; onNavigate(): void; onError(value: string | null): void }) {
	const { t, locale } = useT();
	const copy = managementCopy(locale);
	const bridge = useChatStore((s) => s.bridge);
	const cwd = useChatStore((s) => s.cwd);
	const status = useChatStore((s) => s.status);
	const workspaceNavigationPending = useChatStore((s) => s.navigationPending);
	const sessionId = useChatStore((s) => s.sessionId);
	const sessionPath = useChatStore((s) => s.sessionPath);
	const workspaces = useChatStore((s) => s.workspaces);
	const conversationWorkspaces = useChatStore((s) => s.conversationWorkspaces);
	const defaultWorkspace = useChatStore((s) => s.defaultWorkspace);
	const sessionsByWorkspace = useChatStore((s) => s.sessionsByWorkspace);
	const workspaceRequests = useChatStore((s) => s.workspaceSessionRequests);
	const sessionRuntimes = useChatStore((s) => s.sessionRuntimes);
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
	// zcode pendingArchiveTaskId: a single row waits for a second click before
	// its archive action commits (unarchive stays immediate — it is reversible).
	const [archiveConfirm, setArchiveConfirm] = useState<string | null>(null);
	const archiveConfirmRef = useRef<string | null>(null);
	archiveConfirmRef.current = archiveConfirm;
	const [archiveSelection, setArchiveSelection] = useState(() => new Set<string>());
	const [bulkTrashTarget, setBulkTrashTarget] = useState<SessionTrashTarget[] | null>(null);
	const archiveSelectAllRef = useRef<HTMLInputElement>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [sectionLimits, setSectionLimits] = useState<Record<string, number>>({});
	const [popup, setPopup] = useState<Popup | null>(null);
	const [creatingProject, setCreatingProject] = useState(false);
	const [trashTarget, setTrashTarget] = useState<{ session: SidebarSession; anchor: HTMLElement; nextPath?: string } | null>(null);
	const [projectRemovalTarget, setProjectRemovalTarget] = useState<{ summary: ProjectRemovalSummary; anchor: HTMLElement } | null>(null);
	const trashFocus = useRef<{ path?: string; anchor?: HTMLElement } | null>(null);
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
	const [pinsLoading, setPinsLoading] = useState(true);
	const [pinsReady, setPinsReady] = useState(false);
	const [pinSaving, setPinSaving] = useState(false);
	const pinWritePending = useRef(false);
	const pinRequest = useRef(0);
	const workspacePaths = useMemo(() => {
		const paths = cwd && !workspaces.includes(cwd) ? [cwd, ...workspaces] : workspaces;
		return defaultWorkspace && !paths.some(path => sidebarWorkspaceKey(path) === sidebarWorkspaceKey(defaultWorkspace)) ? [...paths, defaultWorkspace] : paths;
	}, [cwd, workspaces, defaultWorkspace]);
	const projectPaths = useMemo(() => sidebarProjectPaths(workspaces, null, conversationWorkspaces), [workspaces, conversationWorkspaces]);
	const pinnedWorkspaceSet = useMemo(() => new Set(splitSidebarProjects(projectPaths, new Set(pinnedProjects)).pinned), [projectPaths, pinnedProjects]);
	const pinnedWorkspaceKeys = useMemo(() => new Set([...pinnedWorkspaceSet].map(sidebarWorkspaceKey)), [pinnedWorkspaceSet]);
	const orderedWorkspaces = useMemo(() => orderSidebarProjects(projectPaths, preferences.projectOrder, pinnedWorkspaceSet), [projectPaths, preferences.projectOrder, pinnedWorkspaceSet]);
	const projectPartitions = useMemo(() => splitSidebarProjects(orderedWorkspaces, pinnedWorkspaceSet), [orderedWorkspaces, pinnedWorkspaceSet]);
	const allSessions = useMemo(() => collectSidebarSessions(workspacePaths, sessionsByWorkspace), [workspacePaths, sessionsByWorkspace]);
	const sessions = useMemo(() => selectSidebarSessions(allSessions, { archived, filter: preferences.filter, sort: preferences.sort }), [allSessions, archived, preferences.filter, preferences.sort]);
	const selectedArchiveSessions = archived ? sessions.filter(session => archiveSelection.has(session.path)) : [];
	const allArchiveSelected = sessions.length > 0 && selectedArchiveSessions.length === sessions.length;
	useEffect(() => {
		setArchiveSelection(current => {
			const next = new Set(archived ? sessions.filter(session => current.has(session.path)).map(session => session.path) : []);
			return next.size === current.size ? current : next;
		});
	}, [archived, sessions]);
	useLayoutEffect(() => {
		if (archiveSelectAllRef.current) archiveSelectAllRef.current.indeterminate = selectedArchiveSessions.length > 0 && !allArchiveSelected;
	}, [archived, selectedArchiveSessions.length, allArchiveSelected]);
	const bodySessions = useMemo(() => archived ? sessions : sessions.filter(session => session.pinned || !pinnedWorkspaceKeys.has(sidebarWorkspaceKey(session.workspace))), [sessions, archived, pinnedWorkspaceKeys]);
	const grouped = useMemo(() => buildSidebarGroups(bodySessions, groups), [bodySessions, groups]);
	const projectGroups = useMemo(() => buildSidebarProjectGroups(sessions, orderedWorkspaces), [sessions, orderedWorkspaces]);
	const projectByWorkspace = useMemo(() => new Map(projectGroups.projects.map(project => [project.workspace, project])), [projectGroups]);
	const sessionByPath = useMemo(() => new Map(sessions.map((session) => [session.path, session])), [sessions]);
	const dragMode = !archived && preferences.mode === 'grouped';
	const projectDragMode = !archived && ((preferences.mode === 'project' && preferences.projectView === 'project') || projectPartitions.pinned.length > 0);
	const dragSections = useMemo<DragSection[]>(() => {
		if (!dragMode) return [];
		return [...grouped.groups.map((group) => ({ key: groupKey(group.id), sessions: group.sessions })),
			{ key: UNGROUPED_KEY, sessions: grouped.ungrouped }];
	}, [dragMode, grouped]);
	const dates = useMemo(() => {
		const result = groupSessionsByDate(archived ? bodySessions : bodySessions.filter((session) => !session.pinned));
		return preferences.sort === 'oldest' ? result.reverse() : result;
	}, [bodySessions, preferences.sort, archived]);
	const collapsed = useMemo(() => new Set(preferences.collapsed), [preferences.collapsed]);
	const loadingSessions = workspacePaths.some((path) => !workspaceRequests[path] || workspaceRequests[path]?.phase === 'loading');
	const showUnsaved = !archived && preferences.filter === 'all' && Boolean(cwd && sessionId && !allSessions.some((s) => s.path === sessionPath));
	const unsavedProject = projectPaths.find(path => sidebarWorkspaceKey(path) === sidebarWorkspaceKey(cwd));
	const showBodyUnsaved = showUnsaved && !pinnedWorkspaceKeys.has(sidebarWorkspaceKey(cwd));
	const hasPinned = !archived && (grouped.pinned.length > 0 || projectPartitions.pinned.length > 0);
	const bodySectionKeys = archived || (preferences.mode === 'project' && preferences.projectView === 'timeline')
		? dates.map((date) => `${archived ? 'archive' : 'date'}:${date.id}`)
		: preferences.mode === 'project' ? [...projectPartitions.unpinned.map(projectKey), UNASSIGNED_KEY]
			: [...groups.map((group) => groupKey(group.id)), UNGROUPED_KEY];
	const sectionKeys = hasPinned ? ['pinned', ...projectPartitions.pinned.map(projectKey), ...bodySectionKeys] : bodySectionKeys;
	const allExpanded = sectionKeys.length > 0 && sectionKeys.every((key) => !collapsed.has(key));

	// --- Drag state (zcode-style live reordering) -------------------------------
	const [drag, setDrag] = useState<DragState | null>(null);
	const [savingDrag, setSavingDrag] = useState<Pick<DragState, 'orders' | 'groupOrder'> | null>(null);
	const savingDragRef = useRef(false);
	const suppressDragClick = useRef(false);
	const dragRef = useRef<DragState | null>(null);
	dragRef.current = drag;
	/** Container orders frozen at drag start, like zcode's origin view snapshot. */
	const dragSnapshot = useRef<Map<string, string[]> | null>(null);
	const pressRef = useRef<{ item: DragItem; pointerId: number; startX: number; startY: number; width: number; element: HTMLElement } | null>(null);
	const projectDragOrder = useRef<string[] | null>(null);
	const dragCapture = useRef<{ element: HTMLElement; pointerId: number } | null>(null);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const scrollFrameRef = useRef<number | null>(null);
	// --- Scroll edge fade (zcode WorkspaceSidebar) --------------------------------
	// 对滚动容器直接应用 CSS mask(而非 overlay):上/下 32px 渐隐,滚到边界立即消失。
	const [showScrollTopMask, setShowScrollTopMask] = useState(false);
	const [showScrollBottomMask, setShowScrollBottomMask] = useState(false);
	const scrollMaskStyle = useMemo<CSSProperties | undefined>(() => {
		if (!showScrollTopMask && !showScrollBottomMask) return undefined;
		const topStop = showScrollTopMask ? 'transparent 0px, black 32px' : 'black 0px, black 32px';
		const bottomStop = showScrollBottomMask ? 'black calc(100% - 32px), transparent 100%' : 'black calc(100% - 32px), black 100%';
		const image = `linear-gradient(to bottom, ${topStop}, ${bottomStop})`;
		return { WebkitMaskImage: image, maskImage: image, WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat', WebkitMaskSize: '100% 100%', maskSize: '100% 100%' };
	}, [showScrollBottomMask, showScrollTopMask]);
	const updateScrollFade = useCallback(() => {
		const node = scrollRef.current;
		if (!node) return;
		const hasOverflow = node.scrollHeight > node.clientHeight + 1;
		const isAtTop = node.scrollTop <= 1;
		const isAtBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
		setShowScrollTopMask(hasOverflow && !isAtTop);
		setShowScrollBottomMask(hasOverflow && !isAtBottom);
	}, []);
	// 列表内容增减都会重渲染,逐次重测即可覆盖 zcode 用 ResizeObserver 处理的场景。
	useLayoutEffect(updateScrollFade);
	useEffect(() => {
		const node = scrollRef.current;
		if (!node) return;
		node.addEventListener('scroll', updateScrollFade, { passive: true });
		window.addEventListener('resize', updateScrollFade);
		return () => { node.removeEventListener('scroll', updateScrollFade); window.removeEventListener('resize', updateScrollFade); };
	}, [updateScrollFade]);
	const pointerRef = useRef({ x: 0, y: 0 });
	useLayoutEffect(() => {
		if (trashTarget || bulkTrashTarget || !trashFocus.current) return;
		const target = trashFocus.current; trashFocus.current = null;
		const row = [...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-session-path]') ?? [])].find((item) => item.dataset.sessionPath === target.path);
		const available = (element: HTMLElement | null | undefined): element is HTMLElement => Boolean(element?.isConnected && !element.closest('[inert]') && !element.matches(':disabled') && element.getClientRects().length);
		const focus = [target.anchor, row?.querySelector<HTMLButtonElement>('.pd-session-row'), scrollRef.current, document.querySelector<HTMLButtonElement>('.pd-header-sidebar-toggle')].find(available);
		focus?.focus();
	}, [trashTarget, bulkTrashTarget]);

	useEffect(() => { saveSidebarPreferences(preferences); }, [preferences]);
	useEffect(() => {
		if (!projectRevealRequest) return;
		setPreferences(current => ({ ...current, mode: 'project', projectView: 'project' }));
		setArchived(false);
		setPopup(null);
	}, [projectRevealRequest]);
	useEffect(() => {
		setPreferences(current => {
			const projectOrder = mergeSidebarProjectOrder(current.projectOrder, projectPaths);
			return projectOrder.length === current.projectOrder.length ? current : { ...current, projectOrder };
		});
	}, [projectPaths]);
	useEffect(() => { if (!visible) { setPopup(null); setArchiveConfirm(null); } }, [visible]);
	// zcode: the pending confirm dies with its row — filtering, view switches or
	// deletion that removes the session from the visible list clear the state.
	useEffect(() => {
		if (archiveConfirm && !sessions.some((session) => session.path === archiveConfirm)) setArchiveConfirm(null);
	}, [sessions, archiveConfirm]);
	// zcode inline-confirm dismissal: Escape anywhere or a press outside the
	// confirming row cancels; presses inside the row (including the confirm
	// button itself) keep waiting. Compare data-session-path instead of building
	// a CSS selector — Windows paths contain characters selectors would escape.
	useEffect(() => {
		if (!archiveConfirm) return;
		const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setArchiveConfirm(null); };
		const onPointerDown = (event: PointerEvent) => {
			const row = event.target instanceof Element ? event.target.closest('.pd-session-item') : null;
			if (row?.getAttribute('data-session-path') !== archiveConfirm) setArchiveConfirm(null);
		};
		window.addEventListener('keydown', onKeyDown, true);
		window.addEventListener('pointerdown', onPointerDown, true);
		return () => {
			window.removeEventListener('keydown', onKeyDown, true);
			window.removeEventListener('pointerdown', onPointerDown, true);
		};
	}, [archiveConfirm]);
	useEffect(() => {
		if (!bridge || workspacePaths.length === 0 || pinSaving || pinWritePending.current) return;
		let cancelled = false;
		const request = ++pinRequest.current;
		setPinsLoading(true);
		setPinsReady(false);
		const legacy = readPinnedProjects();
		void (async () => {
			const persisted = await bridge.listPinnedWorkspaces();
			if (cancelled || request !== pinRequest.current) return;
			const migration = splitSidebarProjects(projectPaths, new Set(legacy)).pinned;
			const next = persisted.length === 0 && migration.length > 0 ? await bridge.setPinnedWorkspaces(migration) : persisted;
			if (cancelled || request !== pinRequest.current) return;
			setPinnedProjects(next);
			setPinsReady(true);
			clearPinnedProjects();
		})().catch((error: unknown) => {
			if (!cancelled && request === pinRequest.current) onError(error instanceof Error ? error.message : String(error));
		}).finally(() => { if (!cancelled && request === pinRequest.current) setPinsLoading(false); });
		return () => { cancelled = true; };
	}, [bridge, workspacePaths, projectPaths, onError, pinSaving]);
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
		for (const path of workspacePaths) {
			if (workspaceRequests[path]) continue;
			void refreshWorkspaceSessions(path);
		}
	}, [bridge, workspacePaths, workspaceRequests, refreshWorkspaceSessions]);
	useEffect(() => { if (renaming) { renameRef.current?.focus(); renameRef.current?.select(); } }, [renaming]);
	useEffect(() => () => {
		pressRef.current = null;
		dragRef.current = null;
		const capture = dragCapture.current;
		if (capture?.element.hasPointerCapture(capture.pointerId)) capture.element.releasePointerCapture(capture.pointerId);
		if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
		document.body.classList.remove('pd-sidebar-dragging');
	}, []);

	function snapshotOrder(key: string): string[] {
		return dragSnapshot.current?.get(key) ?? dragSections.find((section) => section.key === key)?.sessions.map((session) => session.path) ?? [];
	}

	/** Preview orders for a container: drag overrides, else the frozen snapshot. */
	function previewOrder(key: string): string[] {
		const paths = dragRef.current?.orders.get(key) ?? savingDrag?.orders.get(key) ?? snapshotOrder(key);
		return paths.filter((path) => { const session = sessionByPath.get(path); return session && !session.pinned; });
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
		if (!containerElement || !scrollRef.current?.contains(containerElement)) return null;
		const container = containerElement.dataset.dragContainer!;
		if (!state.orders.has(container)) return null;
		const current = state.orders.get(container) ?? snapshotOrder(container);
		const row = element?.closest<HTMLElement>('[data-drag-path]');
		const rowPath = row?.dataset.dragPath;
		if (rowPath && current.includes(rowPath)) {
			if (rowPath === (state.item.kind === 'session' ? state.item.path : '')) return null;
			const rowIndex = current.indexOf(rowPath);
			const removeIndex = state.item.kind === 'session' ? current.indexOf(state.item.path) : -1;
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
		if (item.kind === 'project') {
			const element = document.elementFromPoint(pointerRef.current.x, pointerRef.current.y);
			const target = element?.closest<HTMLElement>('[data-project-path]');
			const workspace = target?.dataset.projectPath;
			const initial = projectDragOrder.current;
			if (!target || !workspace || !initial || !scrollRef.current?.contains(target) || workspace === item.workspace
				|| pinnedWorkspaceSet.has(workspace) !== pinnedWorkspaceSet.has(item.workspace)) {
				return { ...state, projectOrder: null, projectDrop: null };
			}
			const rect = (target.querySelector<HTMLElement>('.pd-sidebar-group-heading') ?? target).getBoundingClientRect();
			const edge = pointerRef.current.y < rect.top + rect.height / 2 ? 'before' : 'after';
			return { ...state, projectOrder: moveSidebarProject(initial, item.workspace, workspace, edge, pinnedWorkspaceSet), projectDrop: { workspace, edge } };
		}
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
		const orders = moveSidebarSession(state.orders, item.path, drop.container, drop.index);
		return { ...state, orders };
	}

	function edgeScroll(): void {
		const container = scrollRef.current;
		if (!dragRef.current || !container) { scrollFrameRef.current = null; return; }
		const rect = container.getBoundingClientRect();
		const y = pointerRef.current.y;
		const previous = container.scrollTop;
		if (pointerRef.current.x >= rect.left && pointerRef.current.x <= rect.right) {
			if (y < rect.top + EDGE_SCROLL_MARGIN) container.scrollTop -= EDGE_SCROLL_STEP;
			else if (y > rect.bottom - EDGE_SCROLL_MARGIN) container.scrollTop += EDGE_SCROLL_STEP;
		}
		if (container.scrollTop !== previous && dragRef.current) {
			const next = applyDropPreview(dragRef.current);
			dragRef.current = next; setDrag(next);
		}
		scrollFrameRef.current = requestAnimationFrame(edgeScroll);
	}

	function beginDrag(item: DragItem, event: ReactPointerEvent): void {
		if (event.button !== 0 || !event.isPrimary || !(item.kind === 'project' ? projectDragMode : dragMode)) return;
		if (pressRef.current && pressRef.current.pointerId !== event.pointerId) return;
		if (status === 'starting' || navigating || dragRef.current || savingDragRef.current || pendingRef.current || (item.kind !== 'project' && (groupsLoading || groupsError))) return;
		if (item.kind === 'session' && renaming === item.path) return;
		if ((event.target as Element).closest('.pd-session-actions, .pd-session-pin, input, textarea')) return;
		const row = event.currentTarget as HTMLElement;
		pressRef.current = { item, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, width: row.getBoundingClientRect().width || 240, element: row };
	}

	function onPointerMove(event: PointerEvent): void {
		const press = pressRef.current;
		const activePointer = dragRef.current?.pointerId ?? press?.pointerId;
		if (activePointer === undefined || activePointer !== event.pointerId) return;
		if ((event.buttons & 1) === 0) { finishDrag(false, event.pointerId); return; }
		pointerRef.current = { x: event.clientX, y: event.clientY };
		if (press) {
			const threshold = press.item.kind === 'project' ? PROJECT_DRAG_THRESHOLD : DRAG_THRESHOLD;
			if (Math.abs(event.clientX - press.startX) < threshold && Math.abs(event.clientY - press.startY) < threshold) return;
			pressRef.current = null;
			suppressDragClick.current = true;
			setPopup(null);
			setArchiveConfirm(null);
			dragSnapshot.current = new Map(dragSections.map((section) => [section.key, section.sessions.map((session) => session.path)]));
			projectDragOrder.current = press.item.kind === 'project' ? [...orderedWorkspaces] : null;
			if (press.item.kind === 'project') {
				press.element.setPointerCapture(event.pointerId);
				dragCapture.current = { element: press.element, pointerId: event.pointerId };
			}
			let next: DragState = {
				item: press.item,
				pointerId: press.pointerId,
				direction: event.clientY >= press.startY ? 'after' : 'before',
				orders: new Map(dragSnapshot.current),
				groupOrder: null,
				projectOrder: null,
				projectDrop: null,
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
		setDrag(next);
	}

	function finishDrag(commit: boolean, pointerId?: number): void {
		const state = dragRef.current;
		if (pointerId !== undefined && pointerId !== (state?.pointerId ?? pressRef.current?.pointerId)) return;
		const snapshot = dragSnapshot.current;
		pressRef.current = null;
		if (scrollFrameRef.current !== null) { cancelAnimationFrame(scrollFrameRef.current); scrollFrameRef.current = null; }
		document.body.classList.remove('pd-sidebar-dragging');
		dragRef.current = null;
		dragSnapshot.current = null;
		projectDragOrder.current = null;
		const capture = dragCapture.current; dragCapture.current = null;
		if (capture?.element.hasPointerCapture(capture.pointerId)) capture.element.releasePointerCapture(capture.pointerId);
		setDrag(null);
		if (!state || !commit || !snapshot) return;
		const item = state.item;
		if (item.kind === 'project') {
			if (state.projectDrop && state.projectOrder) {
				const reordered = state.projectOrder.filter(path => pinnedWorkspaceSet.has(path) === pinnedWorkspaceSet.has(item.workspace));
				setPreferences(current => ({ ...current, projectOrder: reorderSidebarProjectPositions(current.projectOrder, reordered) }));
			}
			return;
		}
		if (item.kind === 'group') {
			if (!state.groupOrder || state.groupOrder.join(',') === groups.map((group) => group.id).join(',')) return;
			saveDragPreview(state, async () => { await changeGroups({ type: 'reorder-groups', ids: state.groupOrder! }); });
			return;
		}
		const changes = changedSidebarOrders(snapshot, state.orders);
		if (!changes.size) return;
		// Pagination interplay: a drop past a section's visible page must not land
		// the row out of sight — expand that section's limit to cover the landing
		// index (zcode paginates per workspace and expands the same way).
		const landedKey = [...state.orders.keys()].find((key) => state.orders.get(key)!.includes(item.path));
		const landedIndex = landedKey !== undefined ? state.orders.get(landedKey)!.indexOf(item.path) : -1;
		if (landedKey !== undefined && landedIndex >= SECTION_PAGE_SIZE) {
			setSectionLimits(current => {
				const limit = current[landedKey] ?? SECTION_PAGE_SIZE;
				return landedIndex >= limit ? { ...current, [landedKey]: landedIndex + 1 } : current;
			});
		}
		const targetKey = landedKey;
		const entries: { path: string; order: number }[] = [];
		for (const paths of changes.values()) paths.forEach((path, index) => entries.push({ path, order: index }));
		if (targetKey !== undefined && targetKey !== item.from) {
			const groupId = targetKey === UNGROUPED_KEY ? null : targetKey.slice(groupKey('').length);
			const index = Math.max(0, (state.orders.get(targetKey) ?? []).indexOf(item.path));
			saveDragPreview(state, async () => {
				if (!await changeGroups({ type: 'move-session', sessionPath: item.path, groupId, index })) return;
				if (entries.length) await updateSessionOrders(entries);
			});
			return;
		}
		if (entries.length) saveDragPreview(state, () => updateSessionOrders(entries));
	}

	function saveDragPreview(state: DragState, action: () => Promise<void>): void {
		// Keep the final position visible until persistence completes; failures
		// reveal the last confirmed arrangement and are reported by perform().
		savingDragRef.current = true;
		setSavingDrag(state);
		void perform(async () => {
			try { await action(); }
			finally { savingDragRef.current = false; setSavingDrag(null); }
		});
	}

	// Window-level drag phase listeners stay bound for the panel's lifetime:
	// the press→drag transition itself must be observed (the first move fires
	// outside the pressed row), and closures are refreshed through a ref.
	const dragHandlers = useRef({ move: (_: PointerEvent) => {}, up: (_: PointerEvent) => {}, cancel: (_?: number) => {}, key: (_: KeyboardEvent) => {} });
	dragHandlers.current = {
		move: (event) => onPointerMove(event),
		up: (event) => {
			const state = dragRef.current;
			if (state?.pointerId === event.pointerId && state.item.kind === 'project') {
				pointerRef.current = { x: event.clientX, y: event.clientY };
				dragRef.current = applyDropPreview(state);
			}
			finishDrag(true, event.pointerId);
		},
		cancel: (pointerId) => finishDrag(false, pointerId),
		key: (event) => {
			if (event.key === 'Escape' && (dragRef.current || pressRef.current)) {
				event.preventDefault(); event.stopImmediatePropagation(); finishDrag(false);
			}
		},
	};
	useEffect(() => {
		const move = (event: PointerEvent) => dragHandlers.current.move(event);
		const up = (event: PointerEvent) => dragHandlers.current.up(event);
		const cancel = (event: PointerEvent) => dragHandlers.current.cancel(event.pointerId);
		const blur = () => dragHandlers.current.cancel();
		const key = (event: KeyboardEvent) => dragHandlers.current.key(event);
		const down = () => { if (!pressRef.current && !dragRef.current) suppressDragClick.current = false; };
		const click = (event: MouseEvent) => {
			if (!suppressDragClick.current || event.detail === 0) return;
			suppressDragClick.current = false;
			event.preventDefault(); event.stopImmediatePropagation();
		};
		window.addEventListener('pointerdown', down, true);
		window.addEventListener('click', click, true);
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', cancel);
		window.addEventListener('lostpointercapture', cancel);
		window.addEventListener('keydown', key, true);
		window.addEventListener('blur', blur);
		return () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', cancel);
			window.removeEventListener('lostpointercapture', cancel);
			window.removeEventListener('keydown', key, true);
			window.removeEventListener('blur', blur);
			window.removeEventListener('pointerdown', down, true);
			window.removeEventListener('click', click, true);
		};
	}, []);
	const projectMembership = JSON.stringify([...projectPaths].sort());
	const projectPins = JSON.stringify([...pinnedProjects].sort());
	useEffect(() => {
		finishDrag(false);
		setSavingDrag(null);
		setArchiveConfirm(null);
	}, [visible, preferences.mode, preferences.projectView, preferences.filter, preferences.sort, archived, projectMembership, projectPins]);

	function preference(patch: Partial<SidebarPreferences>) { setPreferences((current) => ({ ...current, ...patch })); }
	function toggleSection(key: string) {
		// zcode retainWorkspaceTaskVisibleLimits: collapsing a section clears its
		// remembered "show more" extent; a stored limit never shrinks on its own.
		if (!collapsed.has(key)) setSectionLimits((limits) => { if (!(key in limits)) return limits; const next = { ...limits }; delete next[key]; return next; });
		setPreferences((current) => ({ ...current, collapsed: current.collapsed.includes(key) ? current.collapsed.filter((id) => id !== key) : [...current.collapsed, key] }));
	}
	const limitOf = (key: string) => sectionLimits[key] ?? SECTION_PAGE_SIZE;
	function showMoreSessions(key: string) {
		setSectionLimits((current) => ({ ...current, [key]: (current[key] ?? SECTION_PAGE_SIZE) + SECTION_PAGE_SIZE }));
	}
	function moreButton(key: string, total: number) {
		const limit = limitOf(key);
		if (total <= limit) return null;
		return <button type="button" className="pd-session-more" onClick={() => showMoreSessions(key)}>{t('sidebar.showMore', { count: String(total - limit) })}</button>;
	}
	function toggleAll() {
		setPreferences((current) => ({ ...current, collapsed: allExpanded ? [...new Set([...current.collapsed, ...sectionKeys])] : current.collapsed.filter((key) => !sectionKeys.includes(key)) }));
	}
	async function perform(action: () => Promise<void>, navigate = false) {
		onError(null);
		try { await action(); if (navigate) onNavigate(); }
		catch (error) { onError(error instanceof Error ? error.message : String(error)); }
	}
	function toggleProjectPin(workspace: string, anchor: HTMLElement) {
		if (!bridge || !pinsReady || pinsLoading || pinWritePending.current) return;
		const wasPinned = pinnedWorkspaceSet.has(workspace);
		const next = wasPinned ? pinnedProjects.filter(path => sidebarWorkspaceKey(path) !== sidebarWorkspaceKey(workspace)) : [...pinnedProjects, workspace];
		pinWritePending.current = true;
		setPinSaving(true);
		const request = ++pinRequest.current;
		setPopup(null);
		void perform(async () => {
			try {
				const saved = await bridge.setPinnedWorkspaces(next);
				if (useChatStore.getState().bridge !== bridge || request !== pinRequest.current) return;
				setPinnedProjects(saved);
				clearPinnedProjects();
				if (!wasPinned) setPreferences(current => ({ ...current, collapsed: current.collapsed.filter(key => key !== 'pinned') }));
				requestAnimationFrame(() => {
					if (document.activeElement !== document.body && document.activeElement !== anchor) return;
					const row = [...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-project-path]') ?? [])].find(element => element.dataset.projectPath === workspace);
					const focus = row?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')
						?? scrollRef.current?.querySelector<HTMLButtonElement>('[data-section-key="pinned"] > .pd-sidebar-group-heading .pd-sidebar-group-toggle')
						?? document.querySelector<HTMLButtonElement>('.pd-sidebar-mode [aria-selected="true"]');
					if (focus?.getClientRects().length) focus.focus();
				});
			} finally { pinWritePending.current = false; setPinSaving(false); }
		});
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
		setPopup(null);
		if (navigationPending.current) return;
		navigationPending.current = true;
		setNavigating(true);
		void perform(async () => {
			try {
				if (!await selectSession(session.workspace, session.path)) return;
				onNavigate();
				// CAS clear: pass the watermark this row last saw so a fresher background
				// unread that landed after the snapshot keeps its dot (zcode mark-read).
				if (session.unread) await updateSessionMeta(session.path, { unread: false, expectedUnreadAt: session.unreadAt });
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
				const actionButton = anchor.dataset.sessionAction ? row?.querySelector<HTMLButtonElement>(`[data-session-action="${anchor.dataset.sessionAction}"]`) : null;
				const target = actionButton ?? row?.querySelector<HTMLButtonElement>('.pd-session-row') ?? document.querySelector<HTMLButtonElement>('.pd-sidebar-mode [aria-selected="true"]');
				if (target && !target.closest('[inert]') && target.getClientRects().length) target.focus();
			});
		});
	}
	const titleOf = (session: SidebarSession) => session.name?.trim() || session.firstMessage.trim().split(/\r?\n/)[0] || t('sidebar.unnamed');
	function renderSession(session: SidebarSession, container: string | null) {
		const active = session.workspace === cwd && session.path === sessionPath;
		const title = titleOf(session);
		const pinLabel = t(session.pinned ? 'sidebar.unpinSession' : 'sidebar.pinSession');
		const confirmingArchive = !session.archived && archiveConfirm === session.path;
		const archiveLabel = t(confirmingArchive ? 'sidebar.confirmArchive' : session.archived ? 'sidebar.unarchiveSession' : 'sidebar.archiveSession');
		const menuOpen = (popup?.kind === 'session' || popup?.kind === 'move') && popup.session.path === session.path;
		const dragItem = drag?.item;
		const isDragSource = dragItem?.kind === 'session' && dragItem.path === session.path;
		// zcode leading-indicator priority: error > unread > loading; waiting follows last.
		const phase = session.runtime?.phase ?? 'idle';
		const indicator = phase === 'failed'
			? { kind: 'failed' as const, label: session.runtime?.message ? `${copy.failed} · ${session.runtime.message}` : copy.failed }
			: session.unread ? { kind: 'unread' as const, label: copy.unread }
			: phase === 'running' ? { kind: 'running' as const, label: copy.running }
			: phase === 'waiting-input' || phase === 'waiting-approval'
				? { kind: 'waiting' as const, label: session.runtime?.message ? `${copy[phase]} · ${session.runtime.message}` : copy[phase] }
			: null;
		const togglePin = (event: ReactMouseEvent<HTMLButtonElement>) => sessionAction(session, event.currentTarget, () => updateSessionMeta(session.path, { pinned: !session.pinned }));
		const toggleArchive = (event: ReactMouseEvent<HTMLButtonElement>) => {
			// zcode inline confirm: unarchive is reversible and stays immediate;
			// the destructive direction commits only on a second click of the same row.
			if (session.archived) {
				sessionAction(session, event.currentTarget, () => updateSessionMeta(session.path, { archived: false }));
				return;
			}
			if (archiveConfirmRef.current !== session.path) {
				setArchiveConfirm(session.path);
				return;
			}
			setArchiveConfirm(null);
			sessionAction(session, event.currentTarget, () => updateSessionMeta(session.path, { archived: true }));
		};
		const pinButton = (className: string) => <HoverTooltip title={pinLabel} side="right"><button type="button" className={className} data-session-action="pin" aria-label={`${pinLabel}: ${title}`} aria-pressed={Boolean(session.pinned)} onClick={togglePin}><Icon name="pin" width="14" height="14" /></button></HoverTooltip>;
		return <div className={`pd-session-item${active ? ' is-active' : ''}${isDragSource ? ' is-drag-source' : ''}${session.pinned ? ' is-pinned' : ''}${indicator ? ' has-indicator' : ''}${confirmingArchive ? ' is-archive-confirming' : ''}${archived ? ' has-archive-selection' : ''}${archived && archiveSelection.has(session.path) ? ' is-selected-for-trash' : ''}`} key={session.path} data-session-path={session.path}
			data-drag-path={container && dragMode ? session.path : undefined} onPointerDown={container && dragMode ? (event) => beginDrag({ kind: 'session', path: session.path, from: container }, event) : undefined}
			onContextMenu={(event) => {
				if (renaming === session.path) return;
				event.preventDefault();
				event.stopPropagation();
				// zcode: opening the row menu cancels a pending inline archive confirm.
				setArchiveConfirm(null);
				const anchor = event.currentTarget.querySelector<HTMLButtonElement>('.pd-session-row');
				if (anchor) setPopup({ kind: 'session', anchor, point: { x: event.clientX, y: event.clientY }, session });
			}}>
			{archived && <input type="checkbox" className="pd-archive-session-checkbox" aria-label={t('sidebar.selectArchivedSession', { title })} checked={archiveSelection.has(session.path)} onChange={event => {
				const checked = event.currentTarget.checked;
				setArchiveSelection(current => { const next = new Set(current); if (checked) next.add(session.path); else next.delete(session.path); return next; });
			}} />}
			{renaming === session.path ? <input ref={renameRef} className="pd-session-rename" value={renameDraft} aria-label={t('sidebar.renameLabel')} onChange={(event) => setRenameDraft(event.target.value)} onKeyDown={(event) => {
				if (event.nativeEvent.isComposing) return;
				if (event.key === 'Enter') event.currentTarget.blur();
				if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); renameCancelled.current = true; setRenaming(null); }
			}} onBlur={() => { if (renameCancelled.current) return; setRenaming(null); void perform(() => updateSessionMeta(session.path, { name: renameDraft.trim() })); }} /> : <>
				<button type="button" className="pd-session-row" onClick={() => openSession(session)} disabled={status === 'starting' || navigating} aria-current={active ? 'page' : undefined} aria-haspopup="menu" aria-expanded={menuOpen} onKeyDown={(event) => {
						if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
							event.preventDefault();
							event.stopPropagation();
							setArchiveConfirm(null);
							setPopup({ kind: 'session', anchor: event.currentTarget, session });
						}
					}}>
					{!archived && <span className="pd-session-leading" role="img" aria-label={indicator?.label}>
						{indicator?.kind === 'running' && <Icon name="loader" className="pd-session-spinner" width="14" height="14" />}
						{indicator && indicator.kind !== 'running' && <span className={`pd-session-indicator is-${indicator.kind}`} />}
					</span>}
					<span className="pd-session-copy"><SidebarSessionTitle title={title} /></span>
				</button>
				{!archived && pinButton('pd-session-pin')}
				<div className="pd-session-actions">
					{archived && pinButton('pd-session-action pd-icon-button')}
					<HoverTooltip title={archiveLabel} side="right"><button type="button" className={`pd-session-action pd-icon-button${confirmingArchive ? ' is-confirming' : ''}`} data-session-action="archive" aria-label={`${archiveLabel}: ${title}`} onClick={toggleArchive}><Icon name={confirmingArchive ? 'check' : session.archived ? 'rotateCcw' : 'archive'} width="15" height="15" /></button></HoverTooltip>
				</div>
			</>}
		</div>;
	}
	function renderOrdered(key: string) {
		const ordered = previewOrder(key).map((path) => sessionByPath.get(path)).filter((session): session is SidebarSession => Boolean(session));
		return <>{ordered.slice(0, limitOf(key)).map((session) => renderSession(session, key))}{moreButton(key, ordered.length)}</>;
	}
	function unsaved() {
		return <div className="pd-session-item is-active is-unsaved"><div className="pd-session-row" aria-current="page"><span className="pd-session-leading" aria-hidden="true" /><span className="pd-session-copy"><strong>{t('sidebar.newSession')}</strong></span><span className="pd-session-unsaved">{t('sidebar.current')}</span></div></div>;
	}
	function renderProject(workspace: string) {
		const items = projectByWorkspace.get(workspace)?.sessions ?? [];
		return section(projectKey(workspace), workspaceName(workspace), <>
			{showUnsaved && workspace === unsavedProject && unsaved()}
			{items.slice(0, limitOf(projectKey(workspace))).map(session => renderSession(session, null))}
			{moreButton(projectKey(workspace), items.length)}
			{!items.length && !(showUnsaved && workspace === unsavedProject) && workspaceRequests[workspace]?.phase !== 'error' && <div className="pd-session-empty">{t(!workspaceRequests[workspace] || workspaceRequests[workspace]?.phase === 'loading' ? 'sidebar.loading' : filtered ? 'sidebar.noMatches' : 'sidebar.noSessions')}</div>}
		</>, { icon: 'folder', workspace });
	}
	function section(key: string, name: string, content: ReactNode, options: { icon?: 'hash' | 'folder' | 'pin' | 'clock'; group?: UiSessionGroup; workspace?: string } = {}) {
		const aggregate = summarizeSessionStates(options.workspace ? allSessions.filter((session) => session.workspace === options.workspace && !session.archived) : options.group ? allSessions.filter((session) => options.group!.sessionPaths.includes(session.path) && !session.archived) : []);
		const aggregateLabel = (Object.entries(aggregate) as [keyof typeof aggregate, number][]).filter(([, value]) => value > 0).map(([kind, value]) => `${copy[kind]} ${value}`).join(' · ');
		const dragItem = drag?.item;
		const draggingGroup = dragItem?.kind === 'group';
		const isDraggedGroup = dragItem?.kind === 'group' && dragItem.id === options.group?.id;
		const isDraggedProject = dragItem?.kind === 'project' && dragItem.workspace === options.workspace;
		const projectDrop = options.workspace && drag?.projectDrop?.workspace === options.workspace ? drag.projectDrop.edge : undefined;
		const expanded = !collapsed.has(key) && !isDraggedGroup;
		const color = options.group ? ['#9290d2', '#72a699', '#bc9683', '#749cbe'][[...options.group.id].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0, 0) % 4] : undefined;
		const droppable = (options.group !== undefined || key === UNGROUPED_KEY) && dragMode;
		const menuTarget = options.workspace ? { kind: 'project' as const, workspace: options.workspace } : options.group ? { kind: 'group' as const, group: options.group } : undefined;
		function openSectionMenu(anchor: HTMLElement, point?: ContextMenuPoint) {
			if (!menuTarget) return;
			const trigger = anchor.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]') ?? anchor;
			setPopup({ ...menuTarget, anchor, trigger, point });
		}
		return <section className={`pd-sidebar-group${key === 'pinned' ? ' is-pinned' : ''}${options.group ? ' is-custom' : ''}${options.workspace === cwd ? ' is-current' : ''}${isDraggedProject ? ' is-project-drag-source' : ''}`} key={key} data-section-key={key} data-project-path={options.workspace} data-project-drop={projectDrop} style={{ '--pd-group-color': color } as CSSProperties}>
			<HoverTooltip title={name} description={options.workspace} side="right" align="start"><div className="pd-sidebar-group-heading" data-drag-heading={droppable ? key : undefined} data-drag-container={droppable ? key : undefined} onContextMenu={menuTarget ? (event) => {
				event.preventDefault(); event.stopPropagation();
				openSectionMenu(event.currentTarget, { x: event.clientX, y: event.clientY });
			} : undefined} onKeyDown={menuTarget ? (event) => {
				if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
				event.preventDefault(); event.stopPropagation();
				openSectionMenu(event.currentTarget);
			} : undefined}>
				<button type="button" className={`pd-sidebar-group-toggle${options.workspace && projectDragMode ? ' is-project-draggable' : ''}`} aria-expanded={expanded} onPointerDown={options.workspace && projectDragMode ? (event) => beginDrag({ kind: 'project', workspace: options.workspace! }, event) : options.group && dragMode && !draggingGroup ? (event) => beginDrag({ kind: 'group', id: options.group!.id }, event) : undefined} onClick={() => toggleSection(key)}>
					<Icon name={options.icon ?? 'hash'} width="14" height="14" /><span>{name}</span><Icon name="chevronRight" width="12" height="12" className={expanded ? 'is-expanded' : ''} />{aggregateLabel && <span className="pd-session-state-counts" title={aggregateLabel} aria-label={aggregateLabel}>{aggregate.waiting > 0 && <b className="is-waiting" />}{aggregate.running > 0 && <b className="is-running" />}{aggregate.failed > 0 && <b className="is-failed" />}{aggregate.unread > 0 && <b className="is-unread" />}</span>}
				</button>
				{options.group && <HoverTooltip title={t('sidebar.groupActions')} side="right"><button type="button" className="pd-icon-button pd-group-more" aria-label={t('sidebar.groupMenuLabel', { name })} aria-haspopup="menu" aria-expanded={popup?.kind === 'group' && popup.group.id === options.group.id} onClick={(event) => { const current = popupRef.current; setPopup(current?.kind === 'group' && current.group.id === options.group!.id ? null : { kind: 'group', anchor: event.currentTarget, trigger: event.currentTarget, group: options.group! }); }}><Icon name="more" width="15" height="15" /></button></HoverTooltip>}
				{options.workspace && <HoverTooltip title={t('sidebar.projectNewChat')} side="right"><button type="button" className="pd-icon-button pd-group-more" aria-label={t('sidebar.projectNewChat')} disabled={status === 'starting' || navigating} onClick={() => {
					if (navigationPending.current) return;
					navigationPending.current = true; setNavigating(true);
					void perform(async () => { try { const preparation = newSession({ cwd: options.workspace! }); onNavigate(); await preparation; } finally { navigationPending.current = false; setNavigating(false); } });
				}}><Icon name="plus" width="14" height="14" /></button></HoverTooltip>}
				{options.workspace && <HoverTooltip title={t('sidebar.projectActions')} side="right"><button type="button" className="pd-icon-button pd-group-more" aria-label={t('sidebar.projectMenuLabel', { name })} aria-haspopup="menu" aria-expanded={popup?.kind === 'project' && popup.workspace === options.workspace} onClick={(event) => { const current = popupRef.current; setPopup(current?.kind === 'project' && current.workspace === options.workspace ? null : { kind: 'project', anchor: event.currentTarget, trigger: event.currentTarget, workspace: options.workspace! }); }}><Icon name="more" width="15" height="15" /></button></HoverTooltip>}
			</div></HoverTooltip>
			{expanded && <div className="pd-sidebar-group-content" data-drag-container={droppable ? key : undefined}>{content}{droppable && drag && <div className="pd-session-drop-zone" data-drag-footer />}</div>}
		</section>;
	}
	const iconButton = (label: string, icon: Parameters<typeof Icon>[0]['name'], onClick: (element: HTMLButtonElement) => void, extra: { disabled?: boolean; active?: boolean; expanded?: boolean } = {}) => <HoverTooltip title={label}><button type="button" className={`pd-icon-button${extra.active ? ' is-active' : ''}`} aria-label={label} disabled={extra.disabled} aria-pressed={extra.active === undefined ? undefined : extra.active} aria-expanded={extra.expanded} onClick={(event) => onClick(event.currentTarget)}><Icon name={icon} width="14" height="14" /></button></HoverTooltip>;
	function radio(label: string, selected: boolean, action: () => void) {
		return <button type="button" role="menuitemradio" aria-checked={selected} onClick={action}><span>{label}</span>{selected && <Icon name="check" width="14" height="14" />}</button>;
	}
	const filtered = preferences.filter !== 'all';
	const orderedGroupIds = drag?.groupOrder ?? savingDrag?.groupOrder ?? groups.map((group) => group.id);
	const dragItem = drag?.item;
	const ghostSession = dragItem?.kind === 'session' ? sessionByPath.get(dragItem.path) : null;
	const ghostGroup = dragItem?.kind === 'group' ? groups.find((group) => group.id === dragItem.id) : null;
	const ghostProject = dragItem?.kind === 'project' ? dragItem.workspace : null;
	return <div className="pd-sidebar-detail pd-project-section pd-organized-sessions" onDragStart={(event) => event.preventDefault()}>
		<div className="pd-sidebar-organize-toolbar">
			<div className="pd-sidebar-mode" role="tablist" aria-label={t('sidebar.organize')}>
				{(['grouped', 'project'] as const).map((mode) => <button key={mode} type="button" role="tab" aria-selected={preferences.mode === mode} onClick={() => { preference({ mode }); setArchived(false); setPopup(null); }} onKeyDown={(event) => {
					if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'grouped' : event.key === 'End' ? 'project' : mode === 'grouped' ? 'project' : 'grouped'; preference({ mode: next }); setArchived(false); event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)?.focus(); }
				}} tabIndex={preferences.mode === mode ? 0 : -1} data-mode={mode}><Icon name={mode === 'grouped' ? 'hash' : 'folder'} width="12" height="12" />{t(mode === 'grouped' ? 'sidebar.groups' : 'sidebar.projects')}</button>)}
			</div>
			{iconButton(t(allExpanded ? 'sidebar.collapseAll' : 'sidebar.expandAll'), allExpanded ? 'collapseAll' : 'expandAll', toggleAll, { disabled: sectionKeys.length === 0 })}
			<div className="pd-sidebar-organize-actions">
				{!archived && (preferences.mode === 'grouped'
					? iconButton(t('sidebar.newGroup'), 'hash', (anchor) => editGroup(anchor), { disabled: !bridge || groupsLoading || pending })
					: iconButton(t('sidebar.newProject'), 'plus', () => { setPopup(null); setCreatingProject(true); }, { disabled: !bridge || status === 'starting' || workspaceNavigationPending || navigating }))}
				{iconButton(t('sidebar.filter'), 'filter', (anchor) => setPopup(popup?.kind === 'filter' ? null : { kind: 'filter', anchor }), { active: filtered, expanded: popup?.kind === 'filter' })}
				{iconButton(t(archived ? 'sidebar.closeArchive' : 'sidebar.showArchive'), archived ? 'close' : 'archive', () => { setArchived((value) => !value); setPopup(null); }, { active: archived })}
			</div>
		</div>
		{filtered && <button type="button" className="pd-sidebar-filter-chip" aria-label={`${t(preferences.filter === 'unread' ? 'sidebar.onlyUnread' : 'sidebar.onlyPinned')} · ${t('sidebar.clearFilter')}`} onClick={() => preference({ filter: 'all' })}>{t(preferences.filter === 'unread' ? 'sidebar.onlyUnread' : 'sidebar.onlyPinned')}<Icon name="close" width="11" height="11" /></button>}
		{archived && <div className="pd-archive-selection-toolbar">
			<label><input ref={archiveSelectAllRef} type="checkbox" aria-label={t('sidebar.selectAllArchived')} checked={allArchiveSelected} disabled={!sessions.length} onChange={event => setArchiveSelection(new Set(event.currentTarget.checked ? sessions.map(session => session.path) : []))} />{t('sidebar.selectAll')}</label>
			<span role="status">{t('sidebar.archiveSelectionCount', { count: selectedArchiveSessions.length })}</span>
			<button type="button" data-action="delete-selected-archived" disabled={!selectedArchiveSessions.length || !bridge || navigating || workspaceNavigationPending} onClick={() => { setPopup(null); setBulkTrashTarget(selectedArchiveSessions.map(session => ({ path: session.path, title: titleOf(session) }))); }}>{t('sidebar.deleteSelected')}</button>
		</div>}
		<div className="pd-project-list pd-organized-list" ref={scrollRef} tabIndex={-1} aria-label={t('sidebar.sessions')} style={scrollMaskStyle} onScroll={() => { setPopup(null); updateScrollFade(); }}>
			{(refreshing || loadingSessions) && sessions.length > 0 && <div className="pd-session-loading-hint" role="status"><Icon name="loader" className="pd-session-spinner" width="14" height="14" />{t('sidebar.refreshing')}</div>}
			{hasPinned && section('pinned', t('sidebar.pinned'), <>
				{grouped.pinned.map(session => renderSession(session, null))}
				{projectPartitions.pinned.map(renderProject)}
			</>, { icon: 'pin' })}
			{archived || (preferences.mode === 'project' && preferences.projectView === 'timeline') ? <>
				{showBodyUnsaved && unsaved()}
				{dates.map((date) => { const key = `${archived ? 'archive' : 'date'}:${date.id}`; return section(key, t(`sidebar.${date.id}`), <>{date.sessions.slice(0, limitOf(key)).map((s) => renderSession(s, null))}{moreButton(key, date.sessions.length)}</>, { icon: 'clock' }); })}
				{!dates.length && !showBodyUnsaved && !hasPinned && <div className="pd-session-empty">{t(loadingSessions ? 'sidebar.loading' : filtered ? 'sidebar.noMatches' : archived ? 'sidebar.noArchived' : 'sidebar.noSessions')}</div>}
			</> : preferences.mode === 'grouped' ? groupsLoading ? <div className="pd-session-empty">{t('sidebar.loading')}</div> : groupsError ? <button type="button" className="pd-sidebar-retry" disabled={refreshing} onClick={() => void perform(refresh)}>{t('sidebar.retryGroups')}</button> : <>
				{orderedGroupIds.map((id) => {
					const group = grouped.groups.find((entry) => entry.id === id);
					if (!group) return null;
					const count = previewOrder(groupKey(group.id)).length;
					return section(groupKey(group.id), group.name, <>
						{renderOrdered(groupKey(group.id))}
						{!count && <div className="pd-session-empty pd-group-empty">{t(filtered ? 'sidebar.noMatches' : 'sidebar.emptyGroup')}</div>}
					</>, { group: groups.find((g) => g.id === group.id) });
				})}
				{section(UNGROUPED_KEY, t('sidebar.ungrouped'), <>
					{showBodyUnsaved && unsaved()}
					{renderOrdered(UNGROUPED_KEY)}
					{!previewOrder(UNGROUPED_KEY).length && !showBodyUnsaved && <div className="pd-session-empty pd-group-empty">{t(loadingSessions ? 'sidebar.loading' : filtered ? 'sidebar.noMatches' : 'sidebar.noSessions')}</div>}
				</>)}
			</> : <>
				{projectPartitions.unpinned.map(renderProject)}
				{section(UNASSIGNED_KEY, t('sidebar.unassigned'), <>
					{showUnsaved && !unsavedProject && unsaved()}
					{projectGroups.unassigned.slice(0, limitOf(UNASSIGNED_KEY)).map(session => renderSession(session, null))}
					{moreButton(UNASSIGNED_KEY, projectGroups.unassigned.length)}
					{!projectGroups.unassigned.length && !(showUnsaved && !unsavedProject) && <div className="pd-session-empty">{t(loadingSessions ? 'sidebar.loading' : filtered ? 'sidebar.noMatches' : 'sidebar.noSessions')}</div>}
				</>)}
			</>}
			{!projectPaths.length && !archived && <div className="pd-project-empty"><p>{t('sidebar.noProjects')}</p><button type="button" disabled={!bridge || status === 'starting' || workspaceNavigationPending || navigating} onClick={() => { setPopup(null); setCreatingProject(true); }}>{t('sidebar.newProject')}</button></div>}
			{workspacePaths.map((workspace) => workspaceRequests[workspace]?.phase === 'error' ? <div key={workspace} className="pd-workspace-list-error" role="alert"><strong>{!isConversationWorkspace(workspace, conversationWorkspaces) && `${workspaceName(workspace)} · `}{copy.loadFailed}</strong><p>{workspaceRequests[workspace]?.error}</p><button type="button" onClick={() => void refreshWorkspaceSessions(workspace)}>{copy.retry}</button></div> : null)}
		</div>
		{creatingProject && <ProjectCreationDialog onClose={(opened) => {
			setCreatingProject(false);
			if (opened) { preference({ mode: 'project', projectView: 'project' }); setArchived(false); onNavigate(); }
		}} />}
		{projectRemovalTarget && <ProjectRemovalDialog summary={projectRemovalTarget.summary} onRemove={async () => {
			await removeWorkspace(projectRemovalTarget.summary.workspace);
			setPinnedProjects((current) => current.filter((path) => sidebarWorkspaceKey(path) !== sidebarWorkspaceKey(projectRemovalTarget.summary.workspace)));
		}} onClose={(removed) => {
			const target = projectRemovalTarget;
			setProjectRemovalTarget(null);
			if (!removed) requestAnimationFrame(() => target.anchor.isConnected && target.anchor.focus());
			else operationFeedback.show({ id: `project-remove:${target.summary.workspace}`, kind: 'success', title: t('sidebar.projectRemoved'), detail: target.summary.name });
		}} />}
		{trashTarget && <SessionTrashDialog title={titleOf(trashTarget.session)} workspace={trashTarget.session.workspace} onDelete={() => useChatStore.getState().deleteSession(trashTarget.session.path)} onClose={(deleted) => {
			const target = trashTarget;
			trashFocus.current = deleted ? { path: target.nextPath } : { path: target.session.path, anchor: target.anchor };
			setTrashTarget(null);
			if (deleted) operationFeedback.show({ id: `session-trash:${target.session.path}`, kind: 'success', title: copy.deleted, detail: titleOf(target.session) });
		}} />}
		{bulkTrashTarget && <SessionBulkTrashDialog sessions={bulkTrashTarget} onDelete={paths => useChatStore.getState().deleteSessions(paths, { expectArchived: true })} onClose={() => {
			trashFocus.current = { anchor: archiveSelectAllRef.current ?? undefined };
			setBulkTrashTarget(null);
		}} />}
		{drag && (ghostSession || ghostGroup || ghostProject) && <div className="pd-sidebar-drag-ghost" style={{ left: drag.ghost.x, top: drag.ghost.y, width: drag.ghost.width }} aria-hidden>
			{ghostProject ? <><Icon name={pinnedWorkspaceSet.has(ghostProject) ? 'pin' : 'folder'} width="14" height="14" /><span>{workspaceName(ghostProject)}</span></> : ghostGroup ? <><Icon name="hash" width="14" height="14" /><span>{ghostGroup.name}</span></> : <span>{titleOf(ghostSession!)}</span>}
		</div>}
		{popup && <SidebarPopover key={popup.kind} anchor={popup.anchor} trigger={popup.trigger} point={popup.point} label={t(popup.kind === 'filter' ? 'sidebar.filter' : popup.kind === 'edit-group' ? popup.group ? 'sidebar.renameGroup' : 'sidebar.newGroup' : popup.kind === 'move' ? 'sidebar.moveToGroup' : popup.kind === 'group' ? 'sidebar.groupActions' : popup.kind === 'project' ? 'sidebar.projectActions' : 'sidebar.menuTitle')} dialog={popup.kind === 'edit-group'} onClose={() => setPopup(null)}>
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
				<button type="button" role="menuitem" data-action={pinnedWorkspaceSet.has(popup.workspace) ? 'unpin-project' : 'pin-project'} disabled={!bridge || !pinsReady || pinsLoading || pinSaving} onClick={() => toggleProjectPin(popup.workspace, popup.trigger ?? popup.anchor)}>{t(pinnedWorkspaceSet.has(popup.workspace) ? 'sidebar.projectUnpin' : 'sidebar.projectPin')}</button>
				<button type="button" role="menuitem" disabled={status === 'starting' || navigating} onClick={() => {
					const workspace = popup.workspace;
					if (navigationPending.current) return;
					navigationPending.current = true; setNavigating(true); setPopup(null);
					void perform(async () => { try { await switchWorkspace(workspace); } finally { navigationPending.current = false; setNavigating(false); } }, true);
				}}>{t('sidebar.openProject')}</button>
				<button type="button" role="menuitem" onClick={() => { const workspace = popup.workspace; setPopup(null); void perform(() => bridge ? bridge.openWorkspaceFolder(workspace) : Promise.resolve()); }}>{t('sidebar.projectReveal')}</button>
				<hr /><button type="button" role="menuitem" className="pd-sidebar-menu-danger" disabled={pinSaving} onClick={() => {
					const workspace = popup.workspace;
					const anchor = popup.trigger ?? popup.anchor;
					const projectSessions = sessionsByWorkspace[workspace] ?? [];
					const activeCount = projectSessions.filter((session) => {
						const phase = sessionRuntimes[sessionRuntimeKey(workspace, session.path)]?.phase;
						return phase === 'running' || phase === 'waiting-input' || phase === 'waiting-approval';
					}).length + (workspace === cwd && !sessionPath && (status === 'busy' || status === 'starting') ? 1 : 0);
					setProjectRemovalTarget({ summary: { workspace, name: workspaceName(workspace), sessionCount: projectSessions.length, activeCount }, anchor });
					setPopup(null);
				}}>{t('sidebar.projectRemove')}</button>
			</>}
			{popup.kind === 'group' && <><button type="button" role="menuitem" onClick={() => editGroup(popup.trigger ?? popup.anchor, popup.group)}>{t('sidebar.renameGroup')}</button><button type="button" role="menuitem" disabled={pending} onClick={() => { const group = popup.group; setPopup(null); void perform(async () => { await changeGroups({ type: 'delete', id: group.id }); }); }}>{t('sidebar.dissolveGroup')}</button><p className="pd-sidebar-menu-note">{t('sidebar.dissolveGroupHint')}</p></>}
			{popup.kind === 'session' && <>
				<button type="button" role="menuitem" onClick={() => { renameCancelled.current = false; setRenaming(popup.session.path); setRenameDraft(titleOf(popup.session)); setPopup(null); }}>{t('sidebar.rename')}</button>
				<button type="button" role="menuitem" onClick={() => { const s = popup.session; sessionAction(s, popup.anchor, () => updateSessionMeta(s.path, { pinned: !s.pinned })); }}>{t(popup.session.pinned ? 'sidebar.unpin' : 'sidebar.pin')}</button>
				<button type="button" role="menuitem" disabled={groupsLoading || groupsError || pending} onClick={() => setPopup({ ...popup, kind: 'move' })}>{t('sidebar.moveToGroup')}<Icon name="chevronRight" width="13" height="13" /></button>
				<button type="button" role="menuitem" onClick={() => { const s = popup.session; setPopup(null); void perform(() => navigator.clipboard.writeText(s.path)); }}>{t('sidebar.copySessionPath')}</button>
				<button type="button" role="menuitem" disabled={!bridge?.revealSessionFile} onClick={() => { const s = popup.session; setPopup(null); void perform(() => bridge!.revealSessionFile(s.path)); }}>{t('sidebar.revealSessionFile')}</button>
				<button type="button" role="menuitem" onClick={() => { const s = popup.session; sessionAction(s, popup.anchor, () => updateSessionMeta(s.path, s.unread ? { unread: false, expectedUnreadAt: s.unreadAt } : { unread: true })); }}>{t(popup.session.unread ? 'sidebar.markRead' : 'sidebar.markUnread')}</button>
				<hr /><button type="button" role="menuitem" onClick={() => { const s = popup.session; sessionAction(s, popup.anchor, () => updateSessionMeta(s.path, { archived: !s.archived })); }}>{t(popup.session.archived ? 'sidebar.unarchive' : 'sidebar.archive')}</button>
				<button type="button" role="menuitem" className="pd-sidebar-menu-danger" onClick={() => {
					const s = popup.session;
					const rows = [...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-session-path]') ?? [])];
					const index = rows.findIndex((row) => row.dataset.sessionPath === s.path);
					setTrashTarget({ session: s, anchor: popup.anchor, nextPath: (rows[index + 1] ?? rows[index - 1])?.dataset.sessionPath });
					setPopup(null);
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
