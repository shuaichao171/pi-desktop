import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { isValidProjectBarValue, normalizeProjectBarValue, projectBarLeavesMachine, type UiSessionGroup, type UiSidebarGroupChange, type WorkspaceOpener, type WorkspaceProjectNickname } from '@pidesktop/shared';
import { PROJECT_BAR_ANIMS, PROJECT_BAR_PRESETS, readUserBarPresets, saveUserBarPresets, suggestBarLight, USER_BAR_PRESET_LIMIT, projectBarStyle, type UserBarPreset } from '../sidebarAppearance';
import { projectCustomEntryDisplayName, readProjectCustomEntries, saveProjectCustomEntries, PROJECT_CUSTOM_ENTRY_LIMIT, type ProjectCustomEntry } from '../projectCustomEntries';
import type { WorkbenchFeaturesBridge } from '@pidesktop/shared/workbenchFeatures';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { managementCopy } from '../managementCopy';
import { sessionRuntimeKey, summarizeSessionStates } from '../managementState';
import { operationFeedback } from '../operationFeedback';
import type { ContextMenuPoint } from '../contextMenuPosition';
import { changedSidebarOrders, moveSidebarProject, moveSidebarSession } from '../sidebarDrag';
import { isConversationWorkspace } from '../sidebarOrganization';
import { SessionDeleteDialog } from './SessionDeleteDialog';
import { SessionBulkDeleteDialog, type SessionDeleteTarget } from './SessionBulkDeleteDialog';
import { ProjectCreationDialog } from './ProjectCreationDialog';
import { ProjectRemovalDialog, type ProjectRemovalSummary } from './ProjectRemovalDialog';
import { assignProjectToGroup, buildSidebarGroups, buildSidebarProjectGroups, clearPinnedProjects, collectSidebarSessions, groupSidebarProjects, groupSessionsByDate, mergeSidebarProjectOrder, orderSidebarProjects, readPinnedProjects, readSidebarPreferences, readSidebarProjectGroups, readSidebarSectionLayout, reorderSidebarProjectPositions, saveSidebarPreferences, saveSidebarProjectGroups, saveSidebarSectionLayout, selectSidebarSessions, sidebarProjectPaths, sidebarWorkspaceKey, splitSidebarProjects, type SidebarPreferences, type SidebarSession } from '../sidebarOrganization';
import { HoverTooltip } from './HoverTooltip';
import { Icon, type IconName } from './Icons';
import { SidebarPopover } from './SidebarPopover';
import { SidebarSubmenu } from './SidebarSubmenu';
import { ScopedErrorBoundary } from './ScopedErrorBoundary';
import { SessionTime } from './SessionTime';
import { SidebarSessionTitle } from './SidebarSessionTitle';
import './sidebarOrganization.css';

/** pi-subagents builtin child sessions follow "<agent>: <task excerpt>" (deriveChildSessionName). */
const SUBAGENT_CHILD_TITLE_PATTERN = /^(?:scout|researcher|evidence-auditor|worker|reviewer|oracle|delegate):\s/;
type Popup = { anchor: HTMLElement; trigger?: HTMLElement; point?: ContextMenuPoint } & (
	| { kind: 'filter' }
	| { kind: 'session'; session: SidebarSession }
	| { kind: 'project-group'; groupId: string; name: string }
	| { kind: 'project'; workspace: string }
	| { kind: 'edit-group'; group?: UiSessionGroup }
	| { kind: 'rename-project'; workspace: string }
	| { kind: 'add-custom-command'; workspace: string }
	| { kind: 'add-custom-open'; workspace: string }
	| { kind: 'rename-custom-entry'; workspace: string; entryId: string }
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

export function SidebarSessionPanel({ visible, projectRevealRequest = 0, alternateViewOpen = false, onNavigate, onError, onOpenTerminal }: { visible: boolean; projectRevealRequest?: number; alternateViewOpen?: boolean; onNavigate(): void; onError(value: string | null): void; onOpenTerminal?: () => void }) {
	const { t, locale } = useT();
	const copy = managementCopy(locale);
	const bridge = useChatStore((s) => s.bridge);
	const cwd = useChatStore((s) => s.cwd);
	const status = useChatStore((s) => s.status);
	const workspaceNavigationPending = useChatStore((s) => s.navigationPending);
	const sessionId = useChatStore((s) => s.sessionId);
	const sessionPath = useChatStore((s) => s.sessionPath);
	const hasUserMessage = useChatStore((s) => s.messages.some((message) => message.role === 'user'));
	// The draft row is titled like saved rows: its first message's first line.
	const unsavedTitle = useChatStore((s) => s.messages.find((message) => message.role === 'user')?.text.trim().split(/\r?\n/)[0] ?? '');
	const workspaces = useChatStore((s) => s.workspaces);
	const conversationWorkspaces = useChatStore((s) => s.conversationWorkspaces);
	const defaultWorkspace = useChatStore((s) => s.defaultWorkspace);
	const sessionsByWorkspace = useChatStore((s) => s.sessionsByWorkspace);
	const workspaceRequests = useChatStore((s) => s.workspaceSessionRequests);
	const sessionRuntimes = useChatStore((s) => s.sessionRuntimes);
	const switchWorkspace = useChatStore((s) => s.switchWorkspace);
	const removeWorkspace = useChatStore((s) => s.removeWorkspace);
	const newSession = useChatStore((s) => s.newSession);
	const refreshWorkspaceSessions = useChatStore((s) => s.refreshWorkspaceSessions);
	const selectSession = useChatStore((s) => s.selectSession);
	const updateSessionMeta = useChatStore((s) => s.updateSessionMeta);
	const updateSessionOrders = useChatStore((s) => s.updateSessionOrders);
	const [preferences, setPreferences] = useState(readSidebarPreferences);
	const [groups, setGroups] = useState<UiSessionGroup[]>([]);
	const [projectGroupItems, setProjectGroupItems] = useState(() => readSidebarProjectGroups());
	const [sectionLayout, setSectionLayout] = useState(() => readSidebarSectionLayout());
	const [groupsLoading, setGroupsLoading] = useState(true);
	const [groupsError, setGroupsError] = useState(false);
	const [archived, setArchived] = useState(false);
	// zcode pendingArchiveTaskId: a single row waits for a second click before
	// its archive action commits (unarchive stays immediate — it is reversible).
	const [archiveConfirm, setArchiveConfirm] = useState<string | null>(null);
	const archiveConfirmRef = useRef<string | null>(null);
	archiveConfirmRef.current = archiveConfirm;
	const [archiveSelection, setArchiveSelection] = useState(() => new Set<string>());
	const [bulkTrashTarget, setBulkTrashTarget] = useState<SessionDeleteTarget[] | null>(null);
	const archiveSelectAllRef = useRef<HTMLInputElement>(null);
	const [sectionLimits, setSectionLimits] = useState<Record<string, number>>({});
	const [popup, setPopup] = useState<Popup | null>(null);
	// Flyout of the open context menu ("打开方式 ›", "移动到分组 ›"); it closes with its menu.
	const [submenu, setSubmenu] = useState<{ key: 'open' | 'custom' | 'move' | 'appearance'; anchor: HTMLElement; keyboard: boolean } | null>(null);
	const [barFlyout, setBarFlyout] = useState<{ anchor: HTMLElement; keyboard: boolean } | null>(null);
	const barTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	/** The fourth-level flyout opened from a 项目背景条 row: presets swatches, custom CSS, or animation tiers. */
	const [barSubFlyout, setBarSubFlyout] = useState<{ kind: 'presets' | 'user' | 'css' | 'anim'; anchor: HTMLElement; keyboard: boolean } | null>(null);
	const [userDeleteFlyout, setUserDeleteFlyout] = useState<{ presetId: string; presetName: string; anchor: HTMLElement; keyboard: boolean } | null>(null);
	const barSubTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const submenuTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [openers, setOpeners] = useState<WorkspaceOpener[] | null>(null);
	const openersRequested = useRef(false);
	useEffect(() => { setSubmenu(null); setBarFlyout(null); setBarSubFlyout(null); setBarCssDraft(null); setAiPromptCopied(false); setBarConfirm(null); }, [popup]);
	// Closing the main menu or its flyout also dismisses the nested bar/sub flyouts;
	// their own changes must not reset them (that would self-close them).
	useEffect(() => { setBarFlyout(null); }, [popup, submenu]);
	useEffect(() => { setBarSubFlyout(null); }, [popup, submenu, barFlyout]);
	useEffect(() => () => { if (submenuTimer.current) clearTimeout(submenuTimer.current); if (barTimer.current) clearTimeout(barTimer.current); if (barSubTimer.current) clearTimeout(barSubTimer.current); }, []);
	const [creatingProject, setCreatingProject] = useState(false);
	const [newProjectGroup, setNewProjectGroup] = useState<string | null>(null);
	const [trashTarget, setTrashTarget] = useState<{ session: SidebarSession; anchor: HTMLElement; nextPath?: string } | null>(null);
	const [projectRemovalTarget, setProjectRemovalTarget] = useState<{ summary: ProjectRemovalSummary; anchor: HTMLElement } | null>(null);
	const trashFocus = useRef<{ path?: string; anchor?: HTMLElement } | null>(null);
	const popupRef = useRef(popup);
	popupRef.current = popup;
	const [navigating, setNavigating] = useState(false);
	const [groupDraft, setGroupDraft] = useState('');
	const [creatingProjectGroup, setCreatingProjectGroup] = useState(false);
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
	const [projectNicknames, setProjectNicknames] = useState<Record<string, WorkspaceProjectNickname>>({});
	const nicknameRequest = useRef(0);
	const [nicknameDraft, setNicknameDraft] = useState('');
	const workspacePaths = useMemo(() => {
		const paths = cwd && !workspaces.includes(cwd) ? [cwd, ...workspaces] : workspaces;
		return defaultWorkspace && !paths.some(path => sidebarWorkspaceKey(path) === sidebarWorkspaceKey(defaultWorkspace)) ? [...paths, defaultWorkspace] : paths;
	}, [cwd, workspaces, defaultWorkspace]);
	// Project remarks live in each root's sole .code-workspace file (wpmanager.wpnickname);
	// projects without one simply report no remark and never gain a generated file.
	useEffect(() => {
		if (!bridge || workspacePaths.length === 0) { setProjectNicknames({}); return; }
		const request = ++nicknameRequest.current;
		void Promise.all(workspacePaths.map(async (workspace) => {
			try { return [workspace, await bridge.getProjectNickname(workspace)] as const; }
			catch { return [workspace, { nickname: null, hasWorkspaceFile: false }] as const; }
		})).then((entries) => { if (nicknameRequest.current === request) setProjectNicknames(Object.fromEntries(entries)); });
	}, [bridge, workspacePaths]);
	const projectDisplayName = (workspace: string) => projectNicknames[workspace]?.nickname || workspaceName(workspace);
	const [projectBars, setProjectBars] = useState<Record<string, string | null>>({});
	const [barCssDraft, setBarCssDraft] = useState<string | null>(null);
	const [aiPromptCopied, setAiPromptCopied] = useState(false);
	const [barConfirm, setBarConfirm] = useState<string | null>(null);
	const barRequest = useRef(0);
	// Serialized per-workspace appearance writes. The batch re-read awaits the
	// queue and compares sequence numbers, so a read dispatched before an apply
	// can never overwrite the fresher local value (the "flash then vanish" race).
	const appearanceWrites = useRef(new Map<string, { seq: number; done: Promise<void> }>());
	useEffect(() => {
		if (!bridge || workspacePaths.length === 0) return;
		const request = ++barRequest.current;
		void Promise.all(workspacePaths.map(async (workspace) => {
			const pending = appearanceWrites.current.get(workspace);
			if (pending) await pending.done.catch(() => {});
			const seq = appearanceWrites.current.get(workspace)?.seq ?? 0;
			try { const appearance = await bridge.getProjectAppearance(workspace); return [workspace, appearance.bar, appearance.anim, seq] as const; }
			catch { return [workspace, null, null, seq] as const; }
		})).then((entries) => {
			if (barRequest.current !== request) return;
			setProjectBars((current) => {
				const next = { ...current };
				const anims: Record<string, string | null> = {};
				for (const [workspace, bar, anim, seq] of entries) {
					if ((appearanceWrites.current.get(workspace)?.seq ?? 0) > seq) continue; // A newer local apply owns this row.
					next[workspace] = bar;
					anims[workspace] = anim;
				}
				setProjectAnims((current) => ({ ...current, ...anims }));
				return next;
			});
		});
	}, [bridge, workspacePaths]);
	const [projectAnims, setProjectAnims] = useState<Record<string, string | null>>({});
	const [userBarPresets, setUserBarPresets] = useState<UserBarPreset[]>(() => readUserBarPresets());
	function addUserBarPreset(workspace: string, draft: string | null) {
		const value = (draft ?? customBarCss(workspace)).trim();
		// 含远程引用的 css 不入库：应用时必须经过「渲染是否允许离开本机」确认，用户预设不能绕过它。
		if (!isValidProjectBarValue(value) || projectBarLeavesMachine(value)) return;
		setUserBarPresets((current) => current.length >= USER_BAR_PRESET_LIMIT || current.some((preset) => preset.css === value) ? current : [...current, { id: crypto.randomUUID(), name: t('sidebar.appearanceUserPresetName', { n: current.length + 1 }), css: value, light: suggestBarLight(value) }]);
	}
	function removeUserBarPreset(id: string) {
		setUserBarPresets((current) => current.filter((preset) => preset.id !== id));
	}
	function toggleUserBarPresetText(id: string) {
		setUserBarPresets((current) => current.map((preset) => preset.id === id ? { ...preset, light: !preset.light } : preset));
	}
	const [customEntries, setCustomEntries] = useState<Record<string, ProjectCustomEntry[]>>(() => readProjectCustomEntries());
	const [customEntryFlyout, setCustomEntryFlyout] = useState<{ entryId: string; anchor: HTMLElement } | null>(null);
	const [customDraft, setCustomDraft] = useState('');
	const [customPathDraft, setCustomPathDraft] = useState('');
	const [customRenameDraft, setCustomRenameDraft] = useState('');
	useEffect(() => { saveProjectCustomEntries(customEntries); }, [customEntries]);
	function addCustomEntry(workspace: string, kind: 'command' | 'open', value: string, target?: 'file' | 'folder') {
		const trimmed = value.trim();
		if (!trimmed) return;
		const key = sidebarWorkspaceKey(workspace);
		setCustomEntries((current) => {
			const list = current[key] ?? [];
			if (list.length >= PROJECT_CUSTOM_ENTRY_LIMIT || list.some((entry) => entry.kind === kind && entry.value === trimmed)) return current;
			return { ...current, [key]: [...list, { id: crypto.randomUUID(), kind, value: trimmed, target }] };
		});
	}
	function renameCustomEntry(workspace: string, entryId: string, label: string) {
		const key = sidebarWorkspaceKey(workspace);
		setCustomEntries((current) => ({ ...current, [key]: (current[key] ?? []).map((entry) => entry.id === entryId ? { ...entry, label: label.trim() || undefined } : entry) }));
	}
	function removeCustomEntry(workspace: string, entryId: string) {
		const key = sidebarWorkspaceKey(workspace);
		setCustomEntries((current) => {
			const next = { ...current, [key]: (current[key] ?? []).filter((entry) => entry.id !== entryId) };
			if (!next[key]?.length) delete next[key];
			return next;
		});
	}
	async function runCustomCommand(workspace: string, command: string) {
		if (!bridge) return;
		// 终端绑定当前工作区：右键其他项目时提示先切换，避免命令跑错目录。
		if (sidebarWorkspaceKey(workspace) !== sidebarWorkspaceKey(cwd)) throw new Error(t('sidebar.customTerminalBusy'));
		const api = bridge as typeof bridge & WorkbenchFeaturesBridge;
		const snapshot = await api.openWorkspaceTerminal({ cwd: workspace, cols: 80, rows: 24 });
		await api.writeWorkspaceTerminal({ id: snapshot.id, data: `${command}\r` });
		onOpenTerminal?.();
	}
	async function openCustomPath(workspace: string, path: string) {
		await bridge?.openPath(path, workspace);
	}
	/** Live-previews a background bar (newlines collapsed); a failed write re-reads the stored truth. */
	const applyProjectBar = (workspace: string, bar: string | null) => {
		const normalized = bar === null ? null : normalizeProjectBarValue(bar);
		if (bar !== null && normalized === null) return; // Unrenderable CSS: nothing to preview or store.
		const previous = appearanceWrites.current.get(workspace);
		const entry = { seq: (previous?.seq ?? 0) + 1, done: Promise.resolve() };
		appearanceWrites.current.set(workspace, entry);
		entry.done = (async () => {
			setProjectBars((current) => ({ ...current, [workspace]: normalized }));
			if (!bridge?.setProjectAppearance) return;
			try { await bridge.setProjectAppearance(workspace, { bar: normalized }); }
			catch {
				const truth = await bridge.getProjectAppearance(workspace).then((appearance) => appearance.bar).catch(() => null);
				setProjectBars((current) => ({ ...current, [workspace]: truth }));
			}
		})();
	};
	/** Applies an animation tier through the same per-workspace queue as the bar itself. */
	const applyProjectAnim = (workspace: string, anim: string | null) => {
		const previous = appearanceWrites.current.get(workspace);
		const entry = { seq: (previous?.seq ?? 0) + 1, done: Promise.resolve() };
		appearanceWrites.current.set(workspace, entry);
		entry.done = (async () => {
			setProjectAnims((current) => ({ ...current, [workspace]: anim }));
			if (!bridge?.setProjectAppearance) return;
			try { await bridge.setProjectAppearance(workspace, { anim }); }
			catch {
				const truth = await bridge.getProjectAppearance(workspace).then((appearance) => appearance.anim).catch(() => null);
				setProjectAnims((current) => ({ ...current, [workspace]: truth }));
			}
		})();
	};
	/** The current bar when it is user-pasted CSS (neither a preset id nor a hex color). */
	const customBarCss = (workspace: string) => {
		const bar = projectBars[workspace];
		return bar && !bar.startsWith('#') && !bar.startsWith('data:') && !bar.startsWith('user:') && !PROJECT_BAR_PRESETS.some((preset) => preset.id === bar) ? bar : '';
	};
	const projectPaths = useMemo(() => sidebarProjectPaths(workspaces, null, conversationWorkspaces), [workspaces, conversationWorkspaces]);
	const pinnedWorkspaceSet = useMemo(() => new Set(splitSidebarProjects(projectPaths, new Set(pinnedProjects)).pinned), [projectPaths, pinnedProjects]);
	const pinnedWorkspaceKeys = useMemo(() => new Set([...pinnedWorkspaceSet].map(sidebarWorkspaceKey)), [pinnedWorkspaceSet]);
	const orderedWorkspaces = useMemo(() => orderSidebarProjects(projectPaths, preferences.projectOrder, pinnedWorkspaceSet), [projectPaths, preferences.projectOrder, pinnedWorkspaceSet]);
	const projectOrganization = useMemo(() => groupSidebarProjects(orderedWorkspaces, projectGroupItems), [orderedWorkspaces, projectGroupItems]);
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
	const dragMode = false;
	const projectDragMode = !archived;
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
	// A brand-new conversation stays out of the sidebar until its first user
	// message lands; only then does the row (saved or still-saving) appear.
	const showUnsaved = !archived && preferences.filter === 'all' && hasUserMessage && Boolean(cwd && sessionId && !allSessions.some((s) => s.path === sessionPath));
	const unsavedProject = projectPaths.find(path => sidebarWorkspaceKey(path) === sidebarWorkspaceKey(cwd));
	const sectionKeys = ['project-groups', 'ungrouped-projects', 'unassigned-sessions'];
	const regionVisible = (id: string) => !sectionLayout.hidden.includes(id);
	const allExpanded = sectionKeys.every(key => !sectionLayout.collapsed.includes(key));

	// --- Drag state (zcode-style live reordering) -------------------------------
	const [drag, setDrag] = useState<DragState | null>(null);
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
		const focus = [target.anchor, row?.querySelector<HTMLButtonElement>('.pd-session-row'), scrollRef.current, document.querySelector<HTMLButtonElement>('.pd-activity-sessions')].find(available);
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
	useEffect(() => { saveSidebarProjectGroups(projectGroupItems); }, [projectGroupItems]);
	useEffect(() => { saveSidebarSectionLayout(sectionLayout); }, [sectionLayout]);
	useEffect(() => { saveUserBarPresets(userBarPresets); }, [userBarPresets]);
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
			const groupTarget = document.elementFromPoint(pointerRef.current.x, pointerRef.current.y)?.closest<HTMLElement>('[data-project-group-target]')?.dataset.projectGroupTarget;
			if (groupTarget !== undefined) setProjectGroupItems(current => assignProjectToGroup(current, item.workspace, groupTarget || null));
			if (state.projectDrop && state.projectOrder) {
				const reordered = state.projectOrder.filter(path => pinnedWorkspaceSet.has(path) === pinnedWorkspaceSet.has(item.workspace));
				setPreferences(current => ({ ...current, projectOrder: reorderSidebarProjectPositions(current.projectOrder, reordered) }));
			}
			return;
		}
		if (item.kind === 'group') {
			if (!state.groupOrder || state.groupOrder.join(',') === groups.map((group) => group.id).join(',')) return;
			saveDragPreview(async () => { await changeGroups({ type: 'reorder-groups', ids: state.groupOrder! }); });
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
			saveDragPreview(async () => {
				if (!await changeGroups({ type: 'move-session', sessionPath: item.path, groupId, index })) return;
				if (entries.length) await updateSessionOrders(entries);
			});
			return;
		}
		if (entries.length) saveDragPreview(() => updateSessionOrders(entries));
	}

	function saveDragPreview(action: () => Promise<void>): void {
		// Keep the final position visible until persistence completes; failures
		// reveal the last confirmed arrangement and are reported by perform().
		savingDragRef.current = true;
		void perform(async () => {
			try { await action(); }
			finally { savingDragRef.current = false; }
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
		setArchiveConfirm(null);
	}, [visible, preferences.mode, preferences.projectView, preferences.filter, preferences.sort, archived, projectMembership, projectPins]);

	function preference(patch: Partial<SidebarPreferences>) { setPreferences((current) => ({ ...current, ...patch })); }
	function toggleSection(key: string) {
		// zcode retainWorkspaceTaskVisibleLimits: collapsing a section clears its
		// remembered "show more" extent; a stored limit never shrinks on its own.
		if (!collapsed.has(key)) setSectionLimits((limits) => { if (!(key in limits)) return limits; const next = { ...limits }; delete next[key]; return next; });
		setPreferences((current) => ({ ...current, collapsed: current.collapsed.includes(key) ? current.collapsed.filter((id) => id !== key) : [...current.collapsed, key] }));
	}
	function toggleRegionVisibility(id: string) {
		setSectionLayout(current => ({ ...current, hidden: current.hidden.includes(id) ? current.hidden.filter(item => item !== id) : [...current.hidden, id] }));
	}
	function toggleRegion(key: string) {
		setSectionLayout(current => ({ ...current, collapsed: current.collapsed.includes(key) ? current.collapsed.filter(id => id !== key) : [...current.collapsed, key] }));
	}
	function resizeRegionPair(upper: string, lower: string, startY: number, event: ReactPointerEvent) {
		const start = { y: startY, upper: sectionLayout.heights[upper] ?? 200, lower: sectionLayout.heights[lower] ?? 200 };
		const move = (pointer: PointerEvent) => {
			const delta = pointer.clientY - start.y;
			const nextUpper = Math.max(96, Math.min(700, start.upper + delta));
			const nextLower = Math.max(96, Math.min(700, start.lower - delta));
			setSectionLayout(current => ({ ...current, heights: { ...current.heights, [upper]: nextUpper, [lower]: nextLower } }));
		};
		const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up, { once: true });
		event.currentTarget.setPointerCapture?.(event.pointerId);
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
		setSectionLayout(current => ({ ...current, collapsed: allExpanded ? [...new Set([...current.collapsed, ...sectionKeys])] : current.collapsed.filter(key => !sectionKeys.includes(key)) }));
	}
	async function perform(action: () => Promise<void>, navigate = false) {
		onError(null);
		try { await action(); if (navigate) onNavigate(); }
		catch (error) { onError(error instanceof Error ? error.message : String(error)); }
	}
	function openProjectNickname(workspace: string, anchor: HTMLElement) {
		setNicknameDraft(projectNicknames[workspace]?.nickname ?? '');
		setFormError(null);
		setPopup({ kind: 'rename-project', anchor, trigger: anchor, workspace });
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
	function openSession(session: SidebarSession) {
		setPopup(null);
		// zcode keeps selection local: a slow in-flight switch never blocks a new click.
		// Store navigation generations discard stale results; the agent queues the newest
		// navigation while an older one finishes loading, so every click stays responsive.
		if (session.workspace === cwd && session.path === sessionPath) {
			// Clicking the current session still leaves an alternate view
			// (automations/plugins) so route the click back to the conversation.
			onNavigate();
			if (session.unread) void perform(() => updateSessionMeta(session.path, { unread: false, expectedUnreadAt: session.unreadAt }));
			return;
		}
		setNavigating(true);
		void perform(async () => {
			try {
				if (!await selectSession(session.workspace, session.path)) return;
				onNavigate();
				// CAS clear: pass the watermark this row last saw so a fresher background
				// unread that landed after the snapshot keeps its dot (zcode mark-read).
				if (session.unread) await updateSessionMeta(session.path, { unread: false, expectedUnreadAt: session.unreadAt });
			} finally { setNavigating(false); }
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
		const active = !alternateViewOpen && session.workspace === cwd && session.path === sessionPath;
		const title = titleOf(session);
		const pinLabel = t(session.pinned ? 'sidebar.unpinSession' : 'sidebar.pinSession');
		const confirmingArchive = !session.archived && archiveConfirm === session.path;
		const archiveLabel = t(confirmingArchive ? 'sidebar.confirmArchive' : session.archived ? 'sidebar.unarchiveSession' : 'sidebar.archiveSession');
		const menuOpen = popup?.kind === 'session' && popup.session.path === session.path;
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
		// Row-level tint hooks: only the two states that demand a response tint the row.
		const rowTint = indicator?.kind === 'failed' ? ' is-failed-row' : indicator?.kind === 'waiting' ? ' is-waiting-row' : '';
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
		const pinButton = (className: string) => <HoverTooltip title={pinLabel} side="right" interactive={false}><button type="button" className={className} data-session-action="pin" aria-label={`${pinLabel}: ${title}`} aria-pressed={Boolean(session.pinned)} onClick={togglePin}><Icon name="pin" width="14" height="14" /></button></HoverTooltip>;
		return <div className={`pd-session-item${active ? ' is-active' : ''}${isDragSource ? ' is-drag-source' : ''}${session.pinned ? ' is-pinned' : ''}${indicator ? ` has-indicator${rowTint}` : ''}${confirmingArchive ? ' is-archive-confirming' : ''}${archived ? ' has-archive-selection' : ''}${archived && archiveSelection.has(session.path) ? ' is-selected-for-trash' : ''}`} key={session.path} data-session-path={session.path}
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
				<button type="button" className="pd-session-row" onClick={() => openSession(session)} aria-current={active ? 'page' : undefined} aria-haspopup="menu" aria-expanded={menuOpen} onKeyDown={(event) => {
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
					{/* pi-subagents child sessions derive names as "<agent>: <task excerpt>". */}
					{SUBAGENT_CHILD_TITLE_PATTERN.test(title) && <span className="pd-session-child-badge">{t('sidebar.subagentChild')}</span>}
					{!archived && <SessionTime modified={session.modified} locale={locale} />}
				</button>
				{!archived && pinButton('pd-session-pin')}
				<div className="pd-session-actions">
					{archived && pinButton('pd-session-action pd-icon-button')}
					<HoverTooltip title={archiveLabel} side="right" interactive={false}><button type="button" className={`pd-session-action pd-icon-button${confirmingArchive ? ' is-confirming' : ''}`} data-session-action="archive" aria-label={`${archiveLabel}: ${title}`} onClick={toggleArchive}><Icon name={confirmingArchive ? 'check' : session.archived ? 'rotateCcw' : 'archive'} width="15" height="15" /></button></HoverTooltip>
				</div>
			</>}
		</div>;
	}
	function unsaved() {
		return <div className={`pd-session-item${alternateViewOpen ? '' : ' is-active'} is-unsaved`}><button type="button" className="pd-session-row" onClick={onNavigate} aria-current={alternateViewOpen ? undefined : 'page'}><span className="pd-session-leading" aria-hidden="true" /><span className="pd-session-copy">{unsavedTitle ? <SidebarSessionTitle title={unsavedTitle} /> : <strong className="pd-session-unsaved-title">{t('sidebar.unnamed')}</strong>}</span></button></div>;
	}
	function renderProject(workspace: string) {
		const items = projectByWorkspace.get(workspace)?.sessions ?? [];
		return section(projectKey(workspace), projectDisplayName(workspace), <>
			{showUnsaved && workspace === unsavedProject && unsaved()}
			{items.slice(0, limitOf(projectKey(workspace))).map(session => renderSession(session, null))}
			{moreButton(projectKey(workspace), items.length)}
			{!items.length && !(showUnsaved && workspace === unsavedProject) && workspaceRequests[workspace]?.phase !== 'error' && <div className="pd-session-empty">{t(!workspaceRequests[workspace] || workspaceRequests[workspace]?.phase === 'loading' ? 'sidebar.loading' : filtered ? 'sidebar.noMatches' : 'sidebar.noSessions')}</div>}
		</>, { icon: 'box', workspace });
	}
	function section(key: string, name: string, content: ReactNode, options: { icon?: 'hash' | 'folder' | 'pin' | 'clock' | 'box' | 'layers'; group?: UiSessionGroup; workspace?: string } = {}) {
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
		const menuTarget = options.workspace ? { kind: 'project' as const, workspace: options.workspace } : undefined;
		function openSectionMenu(anchor: HTMLElement, point?: ContextMenuPoint) {
			if (!menuTarget) return;
			const trigger = anchor.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]') ?? anchor;
			setPopup({ ...menuTarget, anchor, trigger, point });
		}
		const bar = options.workspace ? projectBarStyle(projectBars[options.workspace]) : null;
		const anim = options.workspace ? PROJECT_BAR_ANIMS.find((item) => item.id === projectAnims[options.workspace!]) : undefined;
		return <section className={`pd-sidebar-group${key === 'pinned' ? ' is-pinned' : ''}${options.group ? ' is-custom' : ''}${options.workspace === cwd ? ' is-current' : ''}${isDraggedProject ? ' is-project-drag-source' : ''}${bar ? ' has-project-bar' : ''}${anim ? ' has-anim-bar' : ''}`} key={key} data-section-key={key} data-project-path={options.workspace} data-project-drop={projectDrop} style={{ '--pd-group-color': color, ...(bar ? { '--pd-project-bar': bar.background, '--pd-project-bar-text': bar.light ? '#1f2430' : '#ffffff' } : {}), ...(anim ? { '--pd-bar-anim': anim.animation, '--pd-bar-size': anim.size } : {}) } as CSSProperties}>
			<div className="pd-sidebar-group-heading" data-drag-heading={droppable ? key : undefined} data-drag-container={droppable ? key : undefined} onContextMenu={menuTarget ? (event) => {
				event.preventDefault(); event.stopPropagation();
				openSectionMenu(event.currentTarget, { x: event.clientX, y: event.clientY });
			} : undefined} onKeyDown={menuTarget ? (event) => {
				if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
				event.preventDefault(); event.stopPropagation();
				openSectionMenu(event.currentTarget);
			} : undefined}>
				<HoverTooltip title={name} description={options.workspace} side="right" align="start">
				<button type="button" className={`pd-sidebar-group-toggle${options.workspace && projectDragMode ? ' is-project-draggable' : ''}`} aria-expanded={expanded} onPointerDown={options.workspace && projectDragMode ? (event) => beginDrag({ kind: 'project', workspace: options.workspace! }, event) : options.group && dragMode && !draggingGroup ? (event) => beginDrag({ kind: 'group', id: options.group!.id }, event) : undefined} onClick={() => toggleSection(key)}>
					<Icon name={options.icon ?? 'hash'} width="14" height="14" /><span>{name}</span><Icon name="chevronRight" width="12" height="12" className={expanded ? 'is-expanded' : ''} />{aggregateLabel && <span className="pd-session-state-counts" title={aggregateLabel} aria-label={aggregateLabel}>{aggregate.waiting > 0 && <b className="is-waiting" />}{aggregate.running > 0 && <b className="is-running" />}{aggregate.failed > 0 && <b className="is-failed" />}{aggregate.unread > 0 && <b className="is-unread" />}</span>}
				</button>
				</HoverTooltip>
				{options.workspace && <HoverTooltip title={t('sidebar.projectNewChat')} side="right"><button type="button" className="pd-icon-button pd-group-more" aria-label={t('sidebar.projectNewChat')} onClick={() => {
					setNavigating(true);
					void perform(async () => { try { const preparation = newSession({ cwd: options.workspace! }); onNavigate(); await preparation; } finally { setNavigating(false); } });
				}}><Icon name="plus" width="14" height="14" /></button></HoverTooltip>}
				{options.workspace && <HoverTooltip title={t('sidebar.projectActions')} side="right"><button type="button" className="pd-icon-button pd-group-more" aria-label={t('sidebar.projectMenuLabel', { name })} aria-haspopup="menu" aria-expanded={popup?.kind === 'project' && popup.workspace === options.workspace} onClick={(event) => { const current = popupRef.current; setPopup(current?.kind === 'project' && current.workspace === options.workspace ? null : { kind: 'project', anchor: event.currentTarget, trigger: event.currentTarget, workspace: options.workspace! }); }}><Icon name="more" width="15" height="15" /></button></HoverTooltip>}
			</div>
			{expanded && <div className="pd-sidebar-group-content" data-drag-container={droppable ? key : undefined}>{content}{droppable && drag && <div className="pd-session-drop-zone" data-drag-footer />}</div>}
		</section>;
	}
	const iconButton = (label: string, icon: Parameters<typeof Icon>[0]['name'], onClick: (element: HTMLButtonElement) => void, extra: { disabled?: boolean; active?: boolean; expanded?: boolean; dot?: boolean } = {}) => <HoverTooltip title={label}><button type="button" className={`pd-icon-button${extra.active ? ' is-active' : ''}${extra.dot ? ' has-dot' : ''}`} aria-label={label} disabled={extra.disabled} aria-pressed={extra.active === undefined ? undefined : extra.active} aria-expanded={extra.expanded} onClick={(event) => onClick(event.currentTarget)}><Icon name={icon} width="15" height="15" /></button></HoverTooltip>;
	function clearSubmenuTimer() {
		if (submenuTimer.current) { clearTimeout(submenuTimer.current); submenuTimer.current = null; }
	}
	function loadOpeners() {
		if (openersRequested.current || !bridge?.listWorkspaceOpeners) { if (!bridge?.listWorkspaceOpeners) setOpeners([]); return; }
		openersRequested.current = true;
		void bridge.listWorkspaceOpeners().then(setOpeners, () => { openersRequested.current = false; setOpeners([]); });
	}
	function openSubmenu(key: 'open' | 'custom' | 'move' | 'appearance', anchor: HTMLElement, keyboard: boolean) {
		clearSubmenuTimer();
		if (key === 'open') loadOpeners();
		setSubmenu((current) => current?.key === key && current.anchor === anchor && current.keyboard === keyboard ? current : { key, anchor, keyboard });
	}
	/** Moving onto another row closes the flyout after a short grace period, so a diagonal move toward it survives. */
	function scheduleSubmenuClose() {
		clearSubmenuTimer();
		submenuTimer.current = setTimeout(() => setSubmenu(null), 220);
	}
	function clearBarTimer() {
		if (barTimer.current) { clearTimeout(barTimer.current); barTimer.current = null; }
	}
	function openBarFlyout(anchor: HTMLElement, keyboard: boolean) {
		clearBarTimer();
		setBarFlyout((current) => current?.anchor === anchor && current.keyboard === keyboard ? current : { anchor, keyboard });
	}
	/** Hovering another row of the appearance flyout closes the bar flyout after a short grace period. */
	function scheduleBarClose() {
		clearBarTimer();
		barTimer.current = setTimeout(() => setBarFlyout(null), 220);
	}
	function clearBarSubTimer() {
		if (barSubTimer.current) { clearTimeout(barSubTimer.current); barSubTimer.current = null; }
	}
	function openBarSubFlyout(kind: 'presets' | 'user' | 'css' | 'anim', anchor: HTMLElement, keyboard: boolean) {
		setUserDeleteFlyout(null);
		clearBarSubTimer();
		setBarSubFlyout((current) => current?.kind === kind && current.anchor === anchor && current.keyboard === keyboard ? current : { kind, anchor, keyboard });
	}
	/** Hovering another row of the bar flyout closes the fourth-level flyout after a short grace period. */
	function scheduleBarSubClose() {
		clearBarSubTimer();
		barSubTimer.current = setTimeout(() => setBarSubFlyout(null), 220);
	}
	/** A context-menu row: icon, label, then its single-key accelerator or a flyout chevron. */
	function menuItem(options: { icon: IconName; label: string; shortcut?: string; onSelect?(button: HTMLButtonElement): void; disabled?: boolean; danger?: boolean; submenu?: 'open' | 'custom' | 'move' | 'appearance'; action?: string }) {
		const flyout = options.submenu;
		return <button type="button" role="menuitem" className={`pd-menu-item${options.danger ? ' pd-sidebar-menu-danger' : ''}`} data-action={options.action}
			data-shortcut={options.shortcut} data-shortcut-label={flyout || !options.shortcut ? undefined : options.shortcut === 'Delete' ? 'Del' : options.shortcut}
			disabled={options.disabled} aria-haspopup={flyout ? 'menu' : undefined} aria-expanded={flyout ? submenu?.key === flyout : undefined}
			onMouseEnter={(event) => { if (flyout && !options.disabled) openSubmenu(flyout, event.currentTarget, false); else if (submenu) scheduleSubmenuClose(); }}
			onKeyDown={flyout ? (event) => { if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); openSubmenu(flyout, event.currentTarget, true); } } : undefined}
			onClick={(event) => { if (flyout) openSubmenu(flyout, event.currentTarget, true); else options.onSelect?.(event.currentTarget); }}>
			<Icon name={options.icon} width="15" height="15" /><span>{options.label}</span>{flyout && <Icon name="chevronRight" className="pd-menu-chevron" width="13" height="13" />}
		</button>;
	}
	/** A flyout row; the first nine rows answer to the digit keys shown beside them. */
	function submenuItem(options: { key: string; label: string; index?: number; icon?: IconName; image?: string; checked?: boolean; disabled?: boolean; onHover?(): void; onSelect(): void }) {
		const digit = options.index !== undefined && options.index >= 1 && options.index <= 9 ? String(options.index) : undefined;
		return <button key={options.key} type="button" role={options.checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={options.checked} className="pd-menu-item" data-shortcut={digit} data-shortcut-label={digit} disabled={options.disabled} onMouseEnter={options.onHover} onClick={options.onSelect}>
			{options.image ? <img className="pd-menu-app-icon" src={options.image} alt="" /> : <Icon name={options.icon ?? 'folder'} width="15" height="15" />}
			<span>{options.label}</span>{options.checked && <Icon name="check" className="pd-menu-check" width="14" height="14" />}
		</button>;
	}
	/** Editors and terminals detected on this machine, opening the given folder. */
	function openerItems(folder: string, firstIndex: number) {
		if (!openers) return [<p key="openers-loading" className="pd-sidebar-menu-note">{t('sidebar.openersLoading')}</p>];
		return openers.filter((opener) => opener.kind !== 'file-manager' && opener.id !== 'explorer').map((opener, index) => submenuItem({
			key: `opener:${opener.id}`, label: opener.name ?? (opener.id === 'vscode' ? 'VS Code' : opener.id), index: firstIndex + index, image: opener.icon, icon: opener.kind === 'terminal' ? 'terminal' : 'code',
			onSelect: () => { setPopup(null); void perform(() => bridge ? bridge.openWorkspaceWith(folder, opener.id) : Promise.resolve()); },
		}));
	}
	function editorOpenerCount() {
		return openers ? openers.filter((opener) => opener.kind !== 'file-manager' && opener.id !== 'explorer').length : 0;
	}
	function sessionBusy(session: SidebarSession) {
		const phase = sessionRuntimes[sessionRuntimeKey(session.workspace, session.path)]?.phase;
		return phase === 'running' || phase === 'waiting-input' || phase === 'waiting-approval'
			|| session.workspace === cwd && session.path === sessionPath && status !== 'idle';
	}
	function openInNewWindow(session: SidebarSession) {
		setPopup(null);
		void perform(async () => {
			if (!bridge?.openSessionInNewWindow) return;
			await bridge.openSessionInNewWindow(session.path);
			// The new window now owns this transcript. Leave it here instead of letting
			// two app instances append to the same conversation file.
			const current = useChatStore.getState();
			if (current.cwd === session.workspace && current.sessionPath === session.path) { await newSession({ cwd: session.workspace }); onNavigate(); }
		});
	}
	function forkFromMenu(session: SidebarSession) {
		setPopup(null);
		if (!bridge?.forkSession) return;
		setNavigating(true);
		void perform(async () => {
			try {
				const forked = await bridge.forkSession(session.path, `${titleOf(session)}${t('sidebar.forkSuffix')}`.slice(0, 200));
				if (!await selectSession(session.workspace, forked)) return;
				onNavigate();
			} finally { setNavigating(false); }
		});
	}
	function newChatInProject(workspace: string) {
		setPopup(null);
		setNavigating(true);
		void perform(async () => { try { const preparation = newSession({ cwd: workspace }); onNavigate(); await preparation; } finally { setNavigating(false); } });
	}
	function checkbox(label: string, checked: boolean, action: () => void) {
		return <button type="button" role="menuitemcheckbox" className="pd-menu-check-item" aria-checked={checked} onClick={action}><span>{label}</span>{checked && <Icon name="check" width="14" height="14" />}</button>;
	}
	function radio(label: string, selected: boolean, action: () => void) {
		return <button type="button" role="menuitemradio" aria-checked={selected} onClick={action}><span>{label}</span>{selected && <Icon name="check" width="14" height="14" />}</button>;
	}
	function openProjectCreation(groupId: string | null) {
		setPopup(null);
		setNewProjectGroup(groupId);
		setCreatingProject(true);
	}
	function newTempSession() {
		if (defaultWorkspace) newChatInProject(defaultWorkspace);
	}
	const filtered = preferences.filter !== 'all';
	function region(id: string, title: string, content: ReactNode, options?: { hint?: string; hintDetail?: string; actions?: ReactNode }) {
		const isCollapsed = sectionLayout.collapsed.includes(id);
		const height = sectionLayout.heights[id] ?? (id === 'unassigned-sessions' ? 170 : 240);
		const heading = <button type="button" className="pd-sidebar-region-heading" aria-expanded={!isCollapsed} onClick={() => toggleRegion(id)}><Icon name="chevronRight" width="13" height="13" className={!isCollapsed ? 'is-expanded' : ''} /><span>{title}</span></button>;
		return <section className={`pd-sidebar-region${isCollapsed ? ' is-collapsed' : ''}`} key={id} data-region-id={id} data-project-group-target={id === 'ungrouped-projects' ? '' : undefined} style={{ flex: isCollapsed ? '0 0 30px' : `1 1 ${height}px` }}>
			<div className="pd-sidebar-region-heading-row">
				{options?.hint ? <HoverTooltip title={options.hint} description={options.hintDetail} side="top" interactive={false}>{heading}</HoverTooltip> : heading}
				{options?.actions && <div className="pd-sidebar-region-heading-actions">{options.actions}</div>}
			</div>
			{!isCollapsed && <div className="pd-sidebar-region-content">{content}</div>}
		</section>;
	}
	function resizer(upper: string, lower: string) {
		return <div className="pd-sidebar-region-resizer" role="separator" aria-orientation="horizontal" aria-label={`${t('sidebar.resizeSection')}: ${upper}, ${lower}`} onPointerDown={event => resizeRegionPair(upper, lower, event.clientY, event)} />;
	}
	const dragItem = drag?.item;
	const ghostSession = dragItem?.kind === 'session' ? sessionByPath.get(dragItem.path) : null;
	const ghostGroup = dragItem?.kind === 'group' ? groups.find((group) => group.id === dragItem.id) : null;
	const ghostProject = dragItem?.kind === 'project' ? dragItem.workspace : null;
	return <div className="pd-sidebar-detail pd-project-section pd-organized-sessions" onDragStart={(event) => event.preventDefault()}>
		{archived ? <div className="pd-sidebar-organize-toolbar is-archive">
			{iconButton(t('sidebar.closeArchive'), 'arrowLeft', () => { setArchived(false); setPopup(null); })}
			<strong className="pd-sidebar-archive-title">{t('sidebar.archived')}</strong><span className="pd-sidebar-archive-count">{sessions.length}</span>
			<div className="pd-sidebar-organize-actions">{iconButton(t('sidebar.viewOptions'), 'more', (anchor) => setPopup(popup?.kind === 'filter' ? null : { kind: 'filter', anchor }), { dot: filtered, expanded: popup?.kind === 'filter' })}</div>
		</div> : <div className="pd-sidebar-organize-toolbar">
			<strong className="pd-sidebar-archive-title">{t('sidebar.projects')}</strong>
			<div className="pd-sidebar-organize-actions">
				{iconButton(t('sidebar.viewOptions'), 'more', (anchor) => setPopup(popup?.kind === 'filter' ? null : { kind: 'filter', anchor }), { dot: filtered, expanded: popup?.kind === 'filter' })}
			</div>
		</div>}
		{creatingProjectGroup && !archived && <form className="pd-sidebar-inline-group-form" onSubmit={event => { event.preventDefault(); const name = groupDraft.trim(); if (!name) return; setProjectGroupItems(current => [...current, { id: crypto.randomUUID(), name, projects: [] }]); setGroupDraft(''); setCreatingProjectGroup(false); }}>
			<input aria-label={t('sidebar.groupName')} maxLength={80} autoFocus value={groupDraft} placeholder={t('sidebar.groupName')} onChange={event => setGroupDraft(event.target.value)} />
			<button type="submit" disabled={!groupDraft.trim()} aria-label={t('sidebar.save')}><Icon name="check" width="14" height="14" /></button>
			<button type="button" aria-label={t('sidebar.cancel')} onClick={() => { setCreatingProjectGroup(false); setGroupDraft(''); }}><Icon name="close" width="14" height="14" /></button>
		</form>}
		{filtered && <button type="button" className="pd-sidebar-filter-chip" aria-label={`${t(preferences.filter === 'unread' ? 'sidebar.onlyUnread' : 'sidebar.onlyPinned')} · ${t('sidebar.clearFilter')}`} onClick={() => preference({ filter: 'all' })}>{t(preferences.filter === 'unread' ? 'sidebar.onlyUnread' : 'sidebar.onlyPinned')}<Icon name="close" width="11" height="11" /></button>}
		{archived ? <div className="pd-project-list pd-organized-list" ref={scrollRef} tabIndex={-1} aria-label={t('sidebar.sessions')} style={scrollMaskStyle}>
			{dates.map(date => section(`archive:${date.id}`, t(`sidebar.${date.id}`), date.sessions.slice(0, limitOf(`archive:${date.id}`)).map(session => renderSession(session, null)), { icon: 'clock' }))}
			{!dates.length && <div className="pd-session-empty">{t(loadingSessions ? 'sidebar.loading' : 'sidebar.noArchived')}</div>}
		</div> : <div className="pd-sidebar-regions" ref={scrollRef}>
			{(loadingSessions) && sessions.length > 0 && <div className="pd-session-loading-hint" role="status"><Icon name="loader" className="pd-session-spinner" width="14" height="14" />{t('sidebar.refreshing')}</div>}
			{regionVisible('project-groups') && region('project-groups', t('sidebar.groups'), <>
				{projectOrganization.groups.map(group => {
					const groupKey = `pgroup:${group.id}`;
					const groupExpanded = !collapsed.has(groupKey);
					return <div key={group.id} className="pd-sidebar-project-subgroup">
						<div className="pd-sidebar-group-heading" data-project-group-target={group.id} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setPopup({ kind: 'project-group', groupId: group.id, name: group.name, anchor: event.currentTarget, trigger: event.currentTarget, point: { x: event.clientX, y: event.clientY } }); }}>
							<button type="button" className="pd-sidebar-group-toggle" aria-expanded={groupExpanded} onClick={() => toggleSection(groupKey)}>
								<Icon name="layers" width="14" height="14" /><span>{group.name}</span><Icon name="chevronRight" width="12" height="12" className={groupExpanded ? 'is-expanded' : ''} /><small>{group.projects.length}</small>
							</button>
							<HoverTooltip title={t('sidebar.addProjectToGroup')}><button type="button" className="pd-icon-button pd-group-add" aria-label={t('sidebar.addProjectToGroup')} onClick={event => { event.stopPropagation(); openProjectCreation(group.id); }}><Icon name="plus" width="13" height="13" /></button></HoverTooltip>
						<HoverTooltip title={t('sidebar.groupMenuLabel', { name: group.name })}><button type="button" className="pd-icon-button pd-group-more" aria-haspopup="menu" aria-expanded={popup?.kind === 'project-group' && popup.groupId === group.id} aria-label={t('sidebar.groupMenuLabel', { name: group.name })} onClick={event => { event.stopPropagation(); const current = popupRef.current; setPopup(current?.kind === 'project-group' && current.groupId === group.id ? null : { kind: 'project-group', groupId: group.id, name: group.name, anchor: event.currentTarget, trigger: event.currentTarget }); }}><Icon name="more" width="13" height="13" /></button></HoverTooltip>
						</div>
						{groupExpanded && group.projects.map(path => <div key={path} data-project-path={path} data-project-group={group.id}>{renderProject(path)}</div>)}
					</div>;
				})}
				{projectOrganization.groups.length === 0 && <div className="pd-session-empty pd-group-empty">{t('sidebar.emptyGroup')}</div>}
			</>, { hint: t('sidebar.sectionGroupsHint'), actions: iconButton(t('sidebar.newGroup'), 'plus', () => setCreatingProjectGroup(value => !value), { disabled: pending }) })}
			{regionVisible('project-groups') && regionVisible('ungrouped-projects') && resizer('project-groups', 'ungrouped-projects')}
			{regionVisible('ungrouped-projects') && region('ungrouped-projects', t('sidebar.ungrouped'), <>
				{projectOrganization.ungrouped.map(path => <div key={path} data-project-path={path}>{renderProject(path)}</div>)}
				{!projectOrganization.ungrouped.length && <div className="pd-session-empty pd-group-empty">{t('sidebar.noProjects')}</div>}
			</>, { hint: t('sidebar.sectionProjectsHint'), actions: iconButton(t('sidebar.newProject'), 'plus', () => openProjectCreation(null), { disabled: !bridge || status === 'starting' || workspaceNavigationPending || navigating }) })}
			{regionVisible('ungrouped-projects') && regionVisible('unassigned-sessions') && resizer('ungrouped-projects', 'unassigned-sessions')}
			{regionVisible('unassigned-sessions') && region('unassigned-sessions', t('sidebar.unassigned'), <>
				{showUnsaved && !unsavedProject && unsaved()}
				{projectGroups.unassigned.slice(0, limitOf(UNASSIGNED_KEY)).map(session => renderSession(session, null))}
				{moreButton(UNASSIGNED_KEY, projectGroups.unassigned.length)}
				{!projectGroups.unassigned.length && !(showUnsaved && !unsavedProject) && <div className="pd-session-empty">{t(loadingSessions ? 'sidebar.loading' : filtered ? 'sidebar.noMatches' : 'sidebar.noSessions')}</div>}
			</>, { hint: t('sidebar.sectionUnassignedHint'), hintDetail: t('sidebar.sectionUnassignedTip'), actions: iconButton(t('sidebar.newTempSession'), 'plus', newTempSession, { disabled: !defaultWorkspace || navigating || status === 'starting' }) })}
			{workspacePaths.map(workspace => workspaceRequests[workspace]?.phase === 'error' ? <div key={workspace} className="pd-workspace-list-error" role="alert"><strong>{!isConversationWorkspace(workspace, conversationWorkspaces) && `${projectDisplayName(workspace)} · `}{copy.loadFailed}</strong><p>{workspaceRequests[workspace]?.error}</p><button type="button" onClick={() => void refreshWorkspaceSessions(workspace)}>{copy.retry}</button></div> : null)}
		</div>}
		{/* A failing dialog shows a local error card instead of blanking the whole window. */}
		<ScopedErrorBoundary scope="dialog" resetKeys={[creatingProject, projectRemovalTarget, trashTarget, bulkTrashTarget]}>
		{creatingProject && <ProjectCreationDialog onCreated={workspace => { if (newProjectGroup) setProjectGroupItems(current => assignProjectToGroup(current, workspace, newProjectGroup)); setNewProjectGroup(null); }} onClose={(opened) => {
			setCreatingProject(false);
			setNewProjectGroup(null);
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
		{trashTarget && <SessionDeleteDialog title={titleOf(trashTarget.session)} workspace={trashTarget.session.workspace} onDelete={() => useChatStore.getState().deleteSession(trashTarget.session.path)} onClose={(deleted) => {
			const target = trashTarget;
			trashFocus.current = deleted ? { path: target.nextPath } : { path: target.session.path, anchor: target.anchor };
			setTrashTarget(null);
			if (deleted) operationFeedback.show({ id: `session-delete:${target.session.path}`, kind: 'success', title: copy.deleted, detail: titleOf(target.session) });
		}} />}
		{bulkTrashTarget && <SessionBulkDeleteDialog sessions={bulkTrashTarget} onDelete={paths => useChatStore.getState().deleteSessions(paths, { expectArchived: true })} onClose={() => {
			trashFocus.current = { anchor: archiveSelectAllRef.current ?? undefined };
			setBulkTrashTarget(null);
		}} />}
		</ScopedErrorBoundary>
		{drag && (ghostSession || ghostGroup || ghostProject) && <div className="pd-sidebar-drag-ghost" style={{ left: drag.ghost.x, top: drag.ghost.y, width: drag.ghost.width }} aria-hidden>
			{ghostProject ? <><Icon name={pinnedWorkspaceSet.has(ghostProject) ? 'pin' : 'folder'} width="14" height="14" /><span>{projectDisplayName(ghostProject)}</span></> : ghostGroup ? <><Icon name="hash" width="14" height="14" /><span>{ghostGroup.name}</span></> : <span>{titleOf(ghostSession!)}</span>}
		</div>}
		{popup && <SidebarPopover key={popup.kind} anchor={popup.anchor} trigger={popup.trigger} point={popup.point} label={t(popup.kind === 'filter' ? 'sidebar.viewOptions' : popup.kind === 'rename-project' ? 'sidebar.projectNicknameEdit' : popup.kind === 'add-custom-command' ? 'sidebar.customCommandAdd' : popup.kind === 'add-custom-open' ? 'sidebar.customOpenAdd' : popup.kind === 'rename-custom-entry' ? 'sidebar.customRename' : popup.kind === 'edit-group' ? popup.group ? 'sidebar.renameGroup' : 'sidebar.newGroup' : popup.kind === 'project-group' ? 'sidebar.groupActions' : popup.kind === 'project' ? 'sidebar.projectActions' : 'sidebar.menuTitle')} dialog={popup.kind === 'edit-group' || popup.kind === 'rename-project' || popup.kind === 'add-custom-command' || popup.kind === 'add-custom-open' || popup.kind === 'rename-custom-entry'} className={popup.kind === 'session' || popup.kind === 'project' || popup.kind === 'project-group' ? 'pd-context-menu' : undefined} onClose={() => setPopup(null)}>
			{popup.kind === 'filter' && <>
				<div className="pd-sidebar-menu-label">{t('sidebar.showRegions')}</div>
				{checkbox(t('sidebar.groups'), regionVisible('project-groups'), () => toggleRegionVisibility('project-groups'))}
				{checkbox(t('sidebar.ungrouped'), regionVisible('ungrouped-projects'), () => toggleRegionVisibility('ungrouped-projects'))}
				{checkbox(t('sidebar.unassigned'), regionVisible('unassigned-sessions'), () => toggleRegionVisibility('unassigned-sessions'))}
				<hr />
				<div className="pd-sidebar-menu-label">{t('sidebar.filterHeading')}</div>
				{(['all', 'unread', 'pinned'] as const).map((filter) => <div key={filter}>{radio(t(filter === 'all' ? 'sidebar.allSessions' : filter === 'unread' ? 'sidebar.onlyUnread' : 'sidebar.onlyPinned'), preferences.filter === filter, () => preference({ filter }))}</div>)}
				<hr /><div className="pd-sidebar-menu-label">{t('sidebar.sortOrder')}</div>
				{radio(t('sidebar.sortRecent'), preferences.sort === 'newest', () => preference({ sort: 'newest' }))}{radio(t('sidebar.sortOldest'), preferences.sort === 'oldest', () => preference({ sort: 'oldest' }))}
				{!archived && <>
					<hr />
					<button type="button" role="menuitem" disabled={sectionKeys.length === 0} onClick={() => { toggleAll(); setPopup(null); }}><span>{t(allExpanded ? 'sidebar.collapseAllGroups' : 'sidebar.expandAllGroups')}</span></button>
					<hr />
					<button type="button" role="menuitem" onClick={() => { setArchived(true); setPopup(null); }}><span>{t('sidebar.showArchive')}</span><Icon name="archive" width="14" height="14" /></button>
				</>}
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
				{menuItem({ icon: 'plus', label: t('sidebar.projectNewChat'), shortcut: 'N', disabled: navigating, onSelect: () => newChatInProject(popup.workspace) })}
				<hr />
				{menuItem({ icon: 'hash', label: t('sidebar.moveToGroup'), submenu: 'move' })}
				{menuItem({ icon: 'panelRight', label: t('sidebar.openIn'), shortcut: 'O', submenu: 'open' })}
				{menuItem({ icon: 'palette', label: t('sidebar.appearance'), submenu: 'appearance' })}
				{menuItem({ icon: 'terminal', label: t('sidebar.customCommand'), submenu: 'custom' })}
				<hr />
				{menuItem({ icon: 'pin', label: t(pinnedWorkspaceSet.has(popup.workspace) ? 'sidebar.projectUnpin' : 'sidebar.projectPin'), shortcut: 'P', action: pinnedWorkspaceSet.has(popup.workspace) ? 'unpin-project' : 'pin-project', disabled: !bridge || !pinsReady || pinsLoading || pinSaving, onSelect: () => toggleProjectPin(popup.workspace, popup.trigger ?? popup.anchor) })}
				{menuItem({ icon: 'pencil', label: t('sidebar.projectNickname'), shortcut: 'B', disabled: !bridge, onSelect: () => openProjectNickname(popup.workspace, popup.trigger ?? popup.anchor) })}
				{menuItem({ icon: 'copy', label: t('sidebar.copyProjectPath'), shortcut: 'C', onSelect: () => { const workspace = popup.workspace; setPopup(null); void perform(() => navigator.clipboard.writeText(workspace)); } })}
				<hr />
				{menuItem({ icon: 'trash', label: t('sidebar.projectRemove'), shortcut: 'Delete', danger: true, disabled: pinSaving, onSelect: () => {
					const workspace = popup.workspace;
					const anchor = popup.trigger ?? popup.anchor;
					const projectSessions = sessionsByWorkspace[workspace] ?? [];
					const activeCount = projectSessions.filter((session) => {
						const phase = sessionRuntimes[sessionRuntimeKey(workspace, session.path)]?.phase;
						return phase === 'running' || phase === 'waiting-input' || phase === 'waiting-approval';
					}).length + (workspace === cwd && !sessionPath && (status === 'busy' || status === 'starting') ? 1 : 0);
					setProjectRemovalTarget({ summary: { workspace, name: projectDisplayName(workspace), sessionCount: projectSessions.length, activeCount }, anchor });
					setPopup(null);
				} })}
			</>}
			{popup.kind === 'rename-project' && <form onSubmit={(event) => {
				event.preventDefault();
				if (!bridge || pending) return;
				const target = popup;
				const nickname = nicknameDraft.trim();
				setFormError(null);
				setPending(true);
				void (async () => {
					try {
						await bridge.setProjectNickname(target.workspace, nickname);
									setProjectNicknames((current) => ({ ...current, [target.workspace]: { nickname: nickname || null, hasWorkspaceFile: current[target.workspace]?.hasWorkspaceFile ?? false } }));
						if (popupRef.current === target) setPopup(null);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						if (popupRef.current === target) setFormError(message); else onError(message);
					} finally { setPending(false); }
				})();
			}}>
				<label htmlFor="pd-sidebar-project-nickname">{t('sidebar.projectNicknameEdit')}</label>
				<input id="pd-sidebar-project-nickname" maxLength={80} value={nicknameDraft} placeholder={t('sidebar.projectNicknamePlaceholder')} disabled={pending} onChange={(event) => setNicknameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }} />
				<p className="pd-sidebar-menu-note">{t(projectNicknames[popup.workspace]?.hasWorkspaceFile ? 'sidebar.projectNicknameHintFile' : 'sidebar.projectNicknameHintApp')}</p>
				{formError && <p role="alert">{formError}</p>}
				<div className="pd-sidebar-form-actions"><button type="button" onClick={() => { setPopup(null); popup.anchor.focus(); }}>{t('sidebar.cancel')}</button><button type="submit" disabled={pending}>{t(pending ? 'sidebar.saving' : 'sidebar.save')}</button></div>
			</form>}
			{popup.kind === 'add-custom-command' && <form onSubmit={(event) => { event.preventDefault(); const workspace = popup.workspace; const value = customDraft.trim(); if (!value) return; addCustomEntry(workspace, 'command', value); setPopup(null); popup.anchor.focus(); }}>
				<label htmlFor="pd-custom-command">{t('sidebar.customCommandAdd')}</label>
				<input id="pd-custom-command" autoFocus value={customDraft} placeholder={t('sidebar.customCommandPlaceholder')} onChange={(event) => setCustomDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }} />
				<div className="pd-sidebar-form-actions"><button type="button" onClick={() => { setPopup(null); popup.anchor.focus(); }}>{t('sidebar.cancel')}</button><button type="submit" disabled={!customDraft.trim()}>{t('sidebar.save')}</button></div>
			</form>}
			{popup.kind === 'add-custom-open' && <form onSubmit={(event) => { event.preventDefault(); const workspace = popup.workspace; const value = customPathDraft.trim(); if (!value) return; addCustomEntry(workspace, 'open', value); setPopup(null); popup.anchor.focus(); }}>
				<label htmlFor="pd-custom-open">{t('sidebar.customOpenAdd')}</label>
				<input id="pd-custom-open" autoFocus value={customPathDraft} placeholder={t('sidebar.customPathPlaceholder')} onChange={(event) => setCustomPathDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }} />
				<div className="pd-custom-browse-row"><button type="button" onClick={() => { void bridge?.pickPath('file', popup.workspace).then((picked) => { if (picked) setCustomPathDraft(picked); }); }}>{t('sidebar.customBrowseFile')}</button><button type="button" onClick={() => { void bridge?.pickPath('folder', popup.workspace).then((picked) => { if (picked) setCustomPathDraft(picked); }); }}>{t('sidebar.customBrowseFolder')}</button></div>
				<div className="pd-sidebar-form-actions"><button type="button" onClick={() => { setPopup(null); popup.anchor.focus(); }}>{t('sidebar.cancel')}</button><button type="submit" disabled={!customPathDraft.trim()}>{t('sidebar.customOpen')}</button></div>
			</form>}
			{popup.kind === 'rename-custom-entry' && <form onSubmit={(event) => { event.preventDefault(); renameCustomEntry(popup.workspace, popup.entryId, customRenameDraft); setPopup(null); popup.anchor.focus(); }}>
				<label htmlFor="pd-custom-rename">{t('sidebar.customRename')}</label>
				<input id="pd-custom-rename" autoFocus value={customRenameDraft} maxLength={80} onChange={(event) => setCustomRenameDraft(event.target.value)} />
				<div className="pd-sidebar-form-actions"><button type="button" onClick={() => { setPopup(null); popup.anchor.focus(); }}>{t('sidebar.cancel')}</button><button type="submit">{t('sidebar.save')}</button></div>
			</form>}
			{popup.kind === 'project-group' && <>
				{menuItem({ icon: 'trash', label: t('sidebar.dissolveGroup'), shortcut: 'D', disabled: pending, onSelect: () => { const groupId = popup.groupId; setPopup(null); setProjectGroupItems(current => current.filter(group => group.id !== groupId)); } })}
				<p className="pd-sidebar-menu-note">{t('sidebar.dissolveProjectGroupHint')}</p>
			</>}
			{popup.kind === 'session' && <>
				{menuItem({ icon: 'panelRight', label: t('sidebar.openIn'), shortcut: 'O', submenu: 'open' })}
				<hr />
				{menuItem({ icon: 'pin', label: t(popup.session.pinned ? 'sidebar.unpin' : 'sidebar.pin'), shortcut: 'P', onSelect: () => { const s = popup.session; sessionAction(s, popup.anchor, () => updateSessionMeta(s.path, { pinned: !s.pinned })); } })}
				{menuItem({ icon: 'message', label: t(popup.session.unread ? 'sidebar.markRead' : 'sidebar.markUnread'), shortcut: 'U', onSelect: () => { const s = popup.session; sessionAction(s, popup.anchor, () => updateSessionMeta(s.path, s.unread ? { unread: false, expectedUnreadAt: s.unreadAt } : { unread: true })); } })}
				{menuItem({ icon: 'pencil', label: t('sidebar.rename'), shortcut: 'R', onSelect: () => { renameCancelled.current = false; setRenaming(popup.session.path); setRenameDraft(titleOf(popup.session)); setPopup(null); } })}
				{menuItem({ icon: 'gitBranch', label: t('sidebar.fork'), shortcut: 'F', disabled: !bridge?.forkSession || navigating || sessionBusy(popup.session), onSelect: () => forkFromMenu(popup.session) })}
				{menuItem({ icon: 'archive', label: t(popup.session.archived ? 'sidebar.unarchive' : 'sidebar.archive'), shortcut: 'A', onSelect: () => { const s = popup.session; sessionAction(s, popup.anchor, () => updateSessionMeta(s.path, { archived: !s.archived })); } })}
				<hr />
				{menuItem({ icon: 'trash', label: t('sidebar.deleteSession'), shortcut: 'Delete', danger: true, onSelect: () => {
					const s = popup.session;
					const rows = [...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-session-path]') ?? [])];
					const index = rows.findIndex((row) => row.dataset.sessionPath === s.path);
					setTrashTarget({ session: s, anchor: popup.anchor, nextPath: (rows[index + 1] ?? rows[index - 1])?.dataset.sessionPath });
					setPopup(null);
				} })}
			</>}
			{submenu && (popup.kind === 'session' || popup.kind === 'project') && <SidebarSubmenu anchor={submenu.anchor} label={t(submenu.key === 'open' ? 'sidebar.openIn' : submenu.key === 'appearance' ? 'sidebar.appearance' : submenu.key === 'custom' ? 'sidebar.customCommand' : 'sidebar.moveToGroup')} autoFocus={submenu.keyboard}
				onPointerEnter={clearSubmenuTimer} onClose={(restore) => { const anchor = submenu.anchor; setSubmenu(null); if (restore) anchor.focus(); }}>
				{submenu.key === 'open' && popup.kind === 'session' && <>
					{submenuItem({ key: 'new-window', label: t('sidebar.openInNewWindow'), index: 1, icon: 'maximize', disabled: !bridge?.openSessionInNewWindow || sessionBusy(popup.session), onSelect: () => openInNewWindow(popup.session) })}
					<hr />
					{openerItems(popup.session.workspace, 2)}
					{submenuItem({ key: 'explorer', label: t('sidebar.projectReveal'), index: 2 + editorOpenerCount(), icon: 'folder', onSelect: () => { const workspace = popup.session.workspace; setPopup(null); void perform(() => bridge ? bridge.openWorkspaceFolder(workspace) : Promise.resolve()); } })}
					<hr />
					{submenuItem({ key: 'reveal-file', label: t('sidebar.revealSessionFile'), icon: 'file', disabled: !bridge?.revealSessionFile, onSelect: () => { const s = popup.session; setPopup(null); void perform(() => bridge!.revealSessionFile(s.path)); } })}
					{submenuItem({ key: 'copy-path', label: t('sidebar.copySessionPath'), icon: 'copy', onSelect: () => { const s = popup.session; setPopup(null); void perform(() => navigator.clipboard.writeText(s.path)); } })}
				</>}
				{submenu.key === 'open' && popup.kind === 'project' && <>
					{submenuItem({ key: 'switch', label: t('sidebar.openProject'), index: 1, icon: 'arrowRight', onSelect: () => {
						const workspace = popup.workspace;
						setNavigating(true); setPopup(null);
						void perform(async () => { try { await switchWorkspace(workspace); } finally { setNavigating(false); } }, true);
					} })}
					<hr />
					{openerItems(popup.workspace, 2)}
					{submenuItem({ key: 'explorer', label: t('sidebar.projectReveal'), index: 2 + editorOpenerCount(), icon: 'folder', onSelect: () => { const workspace = popup.workspace; setPopup(null); void perform(() => bridge ? bridge.openWorkspaceFolder(workspace) : Promise.resolve()); } })}
				</>}
				{submenu.key === 'move' && popup.kind === 'project' && <>
					{[null, ...projectGroupItems].map((group, index) => submenuItem({
						key: group?.id ?? 'ungrouped', label: group?.name ?? t('sidebar.ungrouped'), index: index + 1, icon: group ? 'layers' : 'box',
						checked: group ? group.projects.includes(popup.workspace) : !projectGroupItems.some(item => item.projects.includes(popup.workspace)),
						onSelect: () => { const workspace = popup.workspace; setPopup(null); setProjectGroupItems(current => assignProjectToGroup(current, workspace, group?.id ?? null)); },
					}))}
					{projectGroupItems.length === 0 && <p className="pd-sidebar-menu-note">{t('sidebar.createGroupFirst')}</p>}
				</>}
				{submenu.key === 'custom' && popup.kind === 'project' && <>
					{(customEntries[sidebarWorkspaceKey(popup.workspace)] ?? []).map((entry) => {
						const workspace = popup.workspace;
						return <div key={entry.id} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setCustomEntryFlyout({ entryId: entry.id, anchor: event.currentTarget }); }}>
							{submenuItem({ key: entry.id, label: projectCustomEntryDisplayName(entry), icon: entry.kind === 'command' ? 'terminal' : entry.target === 'folder' ? 'folder' : 'file', onSelect: () => { setPopup(null); if (entry.kind === 'command') void runCustomCommand(workspace, entry.value).catch((error) => onError(error instanceof Error ? error.message : String(error))); else void openCustomPath(workspace, entry.value).catch((error) => onError(error instanceof Error ? error.message : String(error))); } })}
						</div>;
					})}
					{submenuItem({ key: 'add-command', label: t('sidebar.customCommandAdd'), icon: 'plus', onSelect: () => { const workspace = popup.workspace; setCustomDraft(''); setPopup({ kind: 'add-custom-command', workspace, anchor: popup.anchor, trigger: popup.trigger }); } })}
					{submenuItem({ key: 'add-open', label: t('sidebar.customOpenAdd'), icon: 'plus', onSelect: () => { const workspace = popup.workspace; setCustomPathDraft(''); setPopup({ kind: 'add-custom-open', workspace, anchor: popup.anchor, trigger: popup.trigger }); } })}
					{customEntryFlyout && <SidebarSubmenu anchor={customEntryFlyout.anchor} label={t('sidebar.customRename')} autoFocus onPointerEnter={clearBarSubTimer} onClose={() => setCustomEntryFlyout(null)}>
						{submenuItem({ key: 'rename', label: t('sidebar.customRename'), icon: 'pencil', onSelect: () => { const workspace = popup.workspace; const entryId = customEntryFlyout.entryId; setCustomRenameDraft((customEntries[sidebarWorkspaceKey(workspace)] ?? []).find((entry) => entry.id === entryId)?.label ?? ''); setCustomEntryFlyout(null); setPopup({ kind: 'rename-custom-entry', workspace, entryId, anchor: popup.anchor, trigger: popup.trigger }); } })}
						{submenuItem({ key: 'delete', label: t('sidebar.customDelete'), icon: 'trash', onSelect: () => { removeCustomEntry(popup.workspace, customEntryFlyout.entryId); setCustomEntryFlyout(null); } })}
					</SidebarSubmenu>}
				</>}
				{submenu.key === 'appearance' && popup.kind === 'project' && <>
					<button type="button" role="menuitem" className="pd-menu-item" aria-haspopup="menu" aria-expanded={barFlyout !== null}
						onMouseEnter={(event) => openBarFlyout(event.currentTarget, false)}
						onKeyDown={(event) => { if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); openBarFlyout(event.currentTarget, true); } }}
						onClick={(event) => { const anchor = event.currentTarget; setBarFlyout((current) => current?.anchor === anchor ? null : { anchor, keyboard: true }); }}>
						<Icon name="palette" width="15" height="15" /><span>{t('sidebar.appearanceBar')}</span><Icon name="chevronRight" className="pd-menu-chevron" width="13" height="13" />
					</button>
					<hr />
					{submenuItem({ key: 'bar-reset', label: t('sidebar.appearanceReset'), icon: 'rotateCcw', disabled: !projectBars[popup.workspace] && !projectAnims[popup.workspace], onHover: scheduleBarClose, onSelect: () => { const workspace = popup.workspace; applyProjectBar(workspace, null); applyProjectAnim(workspace, null); setBarCssDraft(null); setBarConfirm(null); } })}
					{barFlyout && <SidebarSubmenu anchor={barFlyout.anchor} label={t('sidebar.appearanceBar')} autoFocus={barFlyout.keyboard} onPointerEnter={clearBarTimer}
						onClose={(restore) => { const anchor = barFlyout.anchor; setBarFlyout(null); if (restore) anchor.focus(); }}>
						<div className="pd-appearance-swatches" role="group" aria-label={t('sidebar.appearanceCustom')} onMouseEnter={scheduleBarSubClose}>
							<label className={`pd-appearance-swatch pd-appearance-swatch-custom${projectBars[popup.workspace]?.startsWith('#') ? ' is-active' : ''}`} title={t('sidebar.appearanceCustom')}>
								<input type="color" value={projectBars[popup.workspace]?.startsWith('#') ? projectBars[popup.workspace]! : '#667eea'} aria-label={t('sidebar.appearanceCustom')} onChange={(event) => applyProjectBar(popup.workspace, event.target.value)} />
							</label>
						</div>
						<button type="button" role="menuitem" className="pd-menu-item" aria-haspopup="menu" aria-expanded={barSubFlyout?.kind === 'presets'}
							onMouseEnter={(event) => openBarSubFlyout('presets', event.currentTarget, false)}
							onKeyDown={(event) => { if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); openBarSubFlyout('presets', event.currentTarget, true); } }}
							onClick={(event) => { const anchor = event.currentTarget; setBarSubFlyout((current) => current?.kind === 'presets' && current.anchor === anchor ? null : { kind: 'presets', anchor, keyboard: true }); }}>
							<Icon name="spark" width="15" height="15" /><span>{t('sidebar.appearancePresets')}</span><Icon name="chevronRight" className="pd-menu-chevron" width="13" height="13" />
						</button>
						<button type="button" role="menuitem" className="pd-menu-item" aria-haspopup="menu" aria-expanded={barSubFlyout?.kind === 'user'}
							onMouseEnter={(event) => openBarSubFlyout('user', event.currentTarget, false)}
							onKeyDown={(event) => { if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); openBarSubFlyout('user', event.currentTarget, true); } }}
							onClick={(event) => { const anchor = event.currentTarget; setBarSubFlyout((current) => current?.kind === 'user' && current.anchor === anchor ? null : { kind: 'user', anchor, keyboard: true }); }}>
							<Icon name="user" width="15" height="15" /><span>{t('sidebar.appearanceUserPresets')}</span><Icon name="chevronRight" className="pd-menu-chevron" width="13" height="13" />
						</button>
						<button type="button" role="menuitem" className="pd-menu-item" aria-haspopup="menu" aria-expanded={barSubFlyout?.kind === 'css'}
							onMouseEnter={(event) => openBarSubFlyout('css', event.currentTarget, false)}
							onKeyDown={(event) => { if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); openBarSubFlyout('css', event.currentTarget, true); } }}
							onClick={(event) => { const anchor = event.currentTarget; setBarSubFlyout((current) => current?.kind === 'css' && current.anchor === anchor ? null : { kind: 'css', anchor, keyboard: true }); }}>
							<Icon name="code" width="15" height="15" /><span>{t('sidebar.appearanceCss')}</span><Icon name="chevronRight" className="pd-menu-chevron" width="13" height="13" />
						</button>
						<hr />
						<button type="button" role="menuitem" className="pd-menu-item" aria-haspopup="menu" aria-expanded={barSubFlyout?.kind === 'anim'}
							onMouseEnter={(event) => openBarSubFlyout('anim', event.currentTarget, false)}
							onKeyDown={(event) => { if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); openBarSubFlyout('anim', event.currentTarget, true); } }}
							onClick={(event) => { const anchor = event.currentTarget; setBarSubFlyout((current) => current?.kind === 'anim' && current.anchor === anchor ? null : { kind: 'anim', anchor, keyboard: true }); }}>
							<Icon name="spark" width="15" height="15" /><span>{t('sidebar.appearanceAnim')}</span><Icon name="chevronRight" className="pd-menu-chevron" width="13" height="13" />
						</button>
						{barSubFlyout?.kind === 'presets' && <SidebarSubmenu anchor={barSubFlyout.anchor} label={t('sidebar.appearancePresets')} autoFocus={barSubFlyout.keyboard} onPointerEnter={clearBarSubTimer}
							onClose={(restore) => { const anchor = barSubFlyout.anchor; setBarSubFlyout(null); if (restore) anchor.focus(); }}>
							<div className="pd-appearance-swatches" role="group" aria-label={t('sidebar.appearancePresets')}>
								{PROJECT_BAR_PRESETS.map((preset) => {
									const label = t(`sidebar.bar${preset.id[0]!.toUpperCase()}${preset.id.slice(1)}`);
									return <button key={preset.id} type="button" role="menuitemradio" aria-checked={projectBars[popup.workspace] === preset.id} className={`pd-appearance-swatch${projectBars[popup.workspace] === preset.id ? ' is-active' : ''}`} style={{ background: preset.css }} title={label} aria-label={label} onClick={() => applyProjectBar(popup.workspace, preset.id)} />;
								})}
							</div>
						</SidebarSubmenu>}
						{barSubFlyout?.kind === 'user' && <SidebarSubmenu anchor={barSubFlyout.anchor} label={t('sidebar.appearanceUserPresets')} autoFocus={barSubFlyout.keyboard} onPointerEnter={clearBarSubTimer}
							onClose={(restore) => { const anchor = barSubFlyout.anchor; setBarSubFlyout(null); setUserDeleteFlyout(null); if (restore) anchor.focus(); }}>
							{userBarPresets.length === 0 && <p className="pd-sidebar-menu-note">{t('sidebar.appearanceUserPresetsEmpty')}</p>}
							{userBarPresets.length > 0 && <div className="pd-appearance-swatches" role="group" aria-label={t('sidebar.appearanceUserPresets')}>
								{userBarPresets.map((preset) => <button key={preset.id} type="button" role="menuitemradio" aria-checked={projectBars[popup.workspace] === `user:${preset.id}`} className={`pd-appearance-swatch${projectBars[popup.workspace] === `user:${preset.id}` ? ' is-active' : ''}`} style={{ background: preset.css }} title={preset.name} aria-label={preset.name} onClick={() => applyProjectBar(popup.workspace, `user:${preset.id}`)} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setUserDeleteFlyout({ presetId: preset.id, presetName: preset.name, anchor: event.currentTarget, keyboard: false }); }} />)}
							</div>}
							{userBarPresets.length > 0 && <p className="pd-sidebar-menu-note">{t('sidebar.appearanceUserPresetHint')}</p>}
							{userDeleteFlyout && <SidebarSubmenu anchor={userDeleteFlyout.anchor} label={userDeleteFlyout.presetName} autoFocus={userDeleteFlyout.keyboard} onPointerEnter={clearBarSubTimer}
								onClose={() => setUserDeleteFlyout(null)}>
								{submenuItem({ key: 'user-text', label: t((userBarPresets.find((preset) => preset.id === userDeleteFlyout.presetId)?.light ?? false) ? 'sidebar.appearanceUserPresetToLight' : 'sidebar.appearanceUserPresetToDark'), icon: 'palette', onSelect: () => { toggleUserBarPresetText(userDeleteFlyout.presetId); setUserDeleteFlyout(null); } })}
								{submenuItem({ key: 'confirm-delete', label: t('sidebar.appearanceDeletePreset'), icon: 'trash', onSelect: () => { removeUserBarPreset(userDeleteFlyout.presetId); setUserDeleteFlyout(null); } })}
							</SidebarSubmenu>}
						</SidebarSubmenu>}
						{barSubFlyout?.kind === 'css' && <SidebarSubmenu anchor={barSubFlyout.anchor} label={t('sidebar.appearanceCss')} autoFocus={barSubFlyout.keyboard} onPointerEnter={clearBarSubTimer}
							onClose={(restore) => { const anchor = barSubFlyout.anchor; setBarSubFlyout(null); if (restore) anchor.focus(); }}>
							<textarea className="pd-appearance-css" rows={2} spellCheck={false} placeholder={t('sidebar.appearanceCssPlaceholder')}
								value={barCssDraft ?? customBarCss(popup.workspace)}
								onKeyDown={(event) => { if (event.key !== 'Escape') event.stopPropagation(); }}
								onChange={(event) => setBarCssDraft(event.target.value)} />
							{barConfirm === null ? submenuItem({ key: 'bar-apply', label: t('sidebar.appearanceCssApply'), icon: 'check', disabled: !(barCssDraft ?? customBarCss(popup.workspace)).trim(), onSelect: () => { const workspace = popup.workspace; const value = (barCssDraft ?? customBarCss(workspace)).trim(); if (projectBarLeavesMachine(value)) { setBarConfirm(value); return; } applyProjectBar(workspace, value); } }) : <>
								<p className="pd-sidebar-menu-note pd-appearance-net-warn">{t('sidebar.appearanceNetWarn')}</p>
								{submenuItem({ key: 'bar-apply-net', label: t('sidebar.appearanceNetApply'), icon: 'alert', onSelect: () => { const workspace = popup.workspace; applyProjectBar(workspace, barConfirm); setBarConfirm(null); } })}
								{submenuItem({ key: 'bar-apply-cancel', label: t('sidebar.cancel'), icon: 'close', onSelect: () => setBarConfirm(null) })}
							</>}
							{submenuItem({ key: 'bar-save-user', label: t('sidebar.appearanceAddUserPreset'), icon: 'plus', disabled: !isValidProjectBarValue((barCssDraft ?? customBarCss(popup.workspace)).trim()) || projectBarLeavesMachine((barCssDraft ?? customBarCss(popup.workspace)).trim()), onSelect: () => addUserBarPreset(popup.workspace, barCssDraft ?? customBarCss(popup.workspace)) })}
							{submenuItem({ key: 'bar-ai', label: t('sidebar.appearanceAiCopy'), icon: 'brain', onSelect: () => { void navigator.clipboard.writeText(t('sidebar.appearanceAiPrompt')).then(() => setAiPromptCopied(true), () => {}); } })}
							{aiPromptCopied && <p className="pd-sidebar-menu-note">{t('sidebar.appearanceAiCopied')}</p>}
						</SidebarSubmenu>}
						{barSubFlyout?.kind === 'anim' && <SidebarSubmenu anchor={barSubFlyout.anchor} label={t('sidebar.appearanceAnim')} autoFocus={barSubFlyout.keyboard} onPointerEnter={clearBarSubTimer}
							onClose={(restore) => { const anchor = barSubFlyout.anchor; setBarSubFlyout(null); if (restore) anchor.focus(); }}>
							{(['', 'flow', 'pulse', 'shimmer', 'hue', 'flicker', 'slide', 'tornado'] as const).map((animId) => submenuItem({ key: `anim:${animId || 'none'}`, label: t(animId ? `sidebar.anim${animId[0]!.toUpperCase()}${animId.slice(1)}` : 'sidebar.animNone'), icon: animId ? 'spark' : 'close', checked: (projectAnims[popup.workspace] ?? null) === (animId || null), onSelect: () => { const workspace = popup.workspace; applyProjectAnim(workspace, animId || null); } }))}
						</SidebarSubmenu>}
					</SidebarSubmenu>}
				</>}
			</SidebarSubmenu>}
		</SidebarPopover>}
	</div>;
}
