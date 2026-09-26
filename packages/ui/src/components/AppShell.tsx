import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import type { UiSessionSearchResult, WorkspaceEntry } from '@pidesktop/shared';
import { ChatView, type SearchMessageTarget } from './ChatView';
import { AutomationPage } from './AutomationPage';
import { PluginsPage } from './PluginsPage';
import { SearchDialog, type SearchCommand } from './SearchDialog';
import { SettingsPanel, type ThemePreference } from './SettingsPanel';
import { Sidebar } from './Sidebar';
import { Icon } from './Icons';
import { HoverTooltip } from './HoverTooltip';
import { WindowControls } from './WindowControls';
import { ExtensionDialogHost } from './ExtensionDialogHost';
import { UpdateNotice } from './UpdateNotice';
import { OperationFeedback } from './OperationFeedback';
import { clampWorkbenchWidth } from '../workbenchReading';
import { WorkbenchSidePane, type WorkbenchOpenRequest } from './WorkbenchSidePane';
import { useChatStore } from '../store';
import { bindingKeysFor, matchesShortcut } from '../shortcuts/bindings';
import { useT } from '../i18n';
import { useSessionNavigation } from '../useSessionNavigation';
import { HistoryNavigation, type HistoryNavigationProps } from './HistoryNavigation';
import { SearchButton } from './SearchButton';
import { applyThemeColors, readColorPreferences, writeColorPreferences } from '../themeColors';
import type { ModelManagementTarget } from '../modelManagement';
import './shellMotion.css';

const NARROW_WINDOW_QUERY = '(max-width: 880px)';
const MIN_SIDEBAR_WIDTH = 232;
const MAX_SIDEBAR_WIDTH = 420;

function readStoredPreference(key: string): string | null {
	try { return localStorage.getItem(key); }
	catch { return null; }
}

function writeStoredPreference(key: string, value: string): void {
	try { localStorage.setItem(key, value); }
	catch {}
}

function readSidebarWidth(): number {
	const stored = Number(readStoredPreference('pi-desktop.sidebar-width'));
	return Number.isFinite(stored) && stored >= MIN_SIDEBAR_WIDTH && stored <= MAX_SIDEBAR_WIDTH ? stored : 274;
}

function readThemePreference(): ThemePreference {
	const stored = readStoredPreference('pi-desktop.theme');
	return stored === 'light' || stored === 'dark' ? stored : 'system';
}

function readWorkbenchOpen(): boolean {
	return !window.matchMedia(NARROW_WINDOW_QUERY).matches && readStoredPreference('pi-desktop.workbench-open') === 'true';
}

export function AppShell() {
	const { t } = useT();
	const navigation = useSessionNavigation();
	const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia(NARROW_WINDOW_QUERY).matches);
	const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_WINDOW_QUERY).matches);
	const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
	const [sidebarResizing, setSidebarResizing] = useState(false);
	const [themePreference, setThemePreference] = useState<ThemePreference>(readThemePreference);
	const [colorPreferences, setColorPreferences] = useState(readColorPreferences);
	const [colorSaveFailed, setColorSaveFailed] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [searchOpen, setSearchOpen] = useState(false);
	const [mainView, setMainView] = useState<'chat' | 'automations' | 'plugins'>('chat');
	const [searchMessageTarget, setSearchMessageTarget] = useState<SearchMessageTarget | null>(null);
	const [workbenchRequest, setWorkbenchRequest] = useState<WorkbenchOpenRequest | null>(null);
	const navigationRequest = useRef(0);
	const [settingsInitialPage, setSettingsInitialPage] = useState<'general' | 'model' | 'updates'>('general');
	const [modelManagementTarget, setModelManagementTarget] = useState<ModelManagementTarget>({ kind: 'manage' });
	const [workbenchOpen, setWorkbenchOpen] = useState(readWorkbenchOpen);
	const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
	const [workbenchWidth, setWorkbenchWidth] = useState(() => {
		const value = Number(readStoredPreference('pi-desktop.workbench-width'));
		return Number.isFinite(value) && value >= 320 && value <= 800 ? value : 420;
	});
	const [workbenchResizing, setWorkbenchResizing] = useState(false);
	const workbenchOverlay = viewportWidth <= 1100;
	useEffect(() => { const resize = () => setViewportWidth(window.innerWidth); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize); }, []);
	useEffect(() => { writeStoredPreference('pi-desktop.workbench-width', String(workbenchWidth)); }, [workbenchWidth]);
	useEffect(() => { if (workbenchOpen && narrow) setSidebarOpen(false); }, [workbenchOpen, narrow]);
	const resizeStart = useRef<{ x: number; width: number } | null>(null);
	const workbenchToggleRef = useRef<HTMLButtonElement>(null);
	const platform = useChatStore((state) => state.appInfo?.platform);
	const commandBridge = useChatStore((state) => state.bridge);
	const isWindows = (platform ?? (navigator.userAgent.includes('Windows') ? 'win32' : '')) === 'win32';
	const history: HistoryNavigationProps = {
		canGoBack: navigation.canGoBack,
		canGoForward: navigation.canGoForward,
		navigating: navigation.navigating,
		onGoBack: () => { setMainView('chat'); setSearchMessageTarget(null); void navigation.goBack(); },
		onGoForward: () => { setMainView('chat'); setSearchMessageTarget(null); void navigation.goForward(); },
	};

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey)) return;
			const direction = matchesShortcut(event, bindingKeysFor('historyBack')) ? 'back' : matchesShortcut(event, bindingKeysFor('historyForward')) ? 'forward' : null;
			if (!direction || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
			event.preventDefault();
			setSearchMessageTarget(null);
			setMainView('chat');
			if (direction === 'back') void navigation.goBack();
			else void navigation.goForward();
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [navigation.goBack, navigation.goForward]);

	// Tray menu / notification-click commands from the main process (4.1).
	useEffect(() => {
		const bridge = commandBridge;
		if (!bridge?.onAppCommand) return;
		return bridge.onAppCommand((command) => {
			setMainView('chat');
			setSearchMessageTarget(null);
			if (command.type === 'new-session') {
				void useChatStore.getState().newSession().catch(() => { /* Navigation errors are shown by the store. */ });
				return;
			}
			const state = useChatStore.getState();
			const workspace = command.cwd ?? Object.entries(state.sessionsByWorkspace)
				.find(([, sessions]) => sessions.some((session) => session.path === command.path))?.[0];
			if (workspace) void state.selectSession(workspace, command.path).catch(() => { /* Navigation errors are shown by the store. */ });
		});
	}, [commandBridge]);

	useEffect(() => {
		const media = window.matchMedia(NARROW_WINDOW_QUERY);
		const onChange = () => {
			setNarrow(media.matches);
			setSidebarOpen(!media.matches);
		};
		media.addEventListener('change', onChange);
		return () => media.removeEventListener('change', onChange);
	}, []);

	useEffect(() => {
		if (!narrow || !sidebarOpen || settingsOpen || searchOpen) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setSidebarOpen(false);
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [narrow, sidebarOpen, settingsOpen, searchOpen]);

	useLayoutEffect(() => {
		const media = window.matchMedia('(prefers-color-scheme: dark)');
		const applyTheme = () => {
			const resolved = themePreference === 'system' ? (media.matches ? 'dark' : 'light') : themePreference;
			document.documentElement.dataset.theme = resolved;
			document.documentElement.style.colorScheme = resolved;
			applyThemeColors(document.documentElement, colorPreferences[resolved], resolved);
		};
		applyTheme();
		media.addEventListener('change', applyTheme);
		writeStoredPreference('pi-desktop.theme', themePreference);
		return () => media.removeEventListener('change', applyTheme);
	}, [themePreference, colorPreferences]);

	useEffect(() => {
		setColorSaveFailed(!writeColorPreferences(colorPreferences));
	}, [colorPreferences]);

	useEffect(() => {
		writeStoredPreference('pi-desktop.sidebar-width', String(sidebarWidth));
	}, [sidebarWidth]);

	useEffect(() => {
		if (sidebarOpen && !narrow) return;
		resizeStart.current = null;
		setSidebarResizing(false);
	}, [sidebarOpen, narrow]);

	useEffect(() => {
		writeStoredPreference('pi-desktop.workbench-open', String(workbenchOpen));
	}, [workbenchOpen]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.isComposing) return;
			if (matchesShortcut(event, bindingKeysFor('search')) || matchesShortcut(event, bindingKeysFor('commandPalette'))) {
				if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
				event.preventDefault();
				setSearchOpen(true);
				return;
			}
			if (matchesShortcut(event, bindingKeysFor('toggleSidebar'))) {
				event.preventDefault();
				setSidebarOpen((open) => !open);
			}
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, []);

	async function selectSearchSession(result: UiSessionSearchResult) {
		if (!await useChatStore.getState().selectSession(result.cwd, result.path)) return;
		if ('otherBranch' in result && result.otherBranch && 'branchLeafId' in result && typeof result.branchLeafId === 'string') await useChatStore.getState().bridge?.switchSessionBranch(result.branchLeafId);
		setMainView('chat');
		if (result.messageId || result.snippet) setSearchMessageTarget({ sessionPath: result.path, messageId: result.messageId ?? '', snippet: result.snippet, requestId: ++navigationRequest.current });
		if (narrow) setSidebarOpen(false);
	}

	function selectSearchFile(entry: WorkspaceEntry) {
		setMainView('chat');
		setWorkbenchRequest({ cwd: useChatStore.getState().cwd, path: entry.path, requestId: ++navigationRequest.current });
		setWorkbenchOpen(true);
		if (narrow) setSidebarOpen(false);
	}

	const searchCommands: SearchCommand[] = [
		{ id: 'new-session', label: t('sidebar.newSession'), icon: 'plus', keywords: 'new chat session 新建对话', run: async () => { const state = useChatStore.getState(); await (state.cwd ? state.newSession() : state.pickWorkspace()); setMainView('chat'); if (narrow) setSidebarOpen(false); } },
		{ id: 'open-project', label: t('sidebar.openProject'), icon: 'folder', keywords: 'open folder workspace 项目 文件夹 工作区', run: async () => { await useChatStore.getState().pickWorkspace(); setMainView('chat'); } },
		{ id: 'automations', label: t('sidebar.automation'), icon: 'automation', keywords: 'automation schedule recurring 自动化 定时 计划', run: () => { setMainView('automations'); if (narrow) setSidebarOpen(false); } },
		{ id: 'plugins', label: t('sidebar.plugins'), icon: 'plugins', keywords: 'plugins extensions skills prompts 插件 扩展 技能 提示词', run: () => { setMainView('plugins'); if (narrow) setSidebarOpen(false); } },
		{ id: 'settings', label: t('sidebar.settings'), icon: 'settings', keywords: 'preferences general appearance model language 设置 常规 偏好 模型 语言', run: () => { setSettingsInitialPage('general'); setSettingsOpen(true); } },
		{ id: 'sidebar', label: t('settings.shortcutSidebar'), icon: 'panel', shortcut: platform === 'darwin' ? '⌘B' : 'Ctrl+B', keywords: 'sidebar toggle 侧栏', run: () => setSidebarOpen((open) => !open) },
		{ id: 'workbench', label: t('app.openWorkbench'), icon: 'panelRight', keywords: 'files git terminal workbench 文件 工作台', run: () => { setMainView('chat'); setWorkbenchOpen(true); } },
	];

	function startResize(event: PointerEvent<HTMLDivElement>): void {
		if (event.button !== 0) return;
		resizeStart.current = { x: event.clientX, width: sidebarWidth };
		setSidebarResizing(true);
		event.currentTarget.setPointerCapture(event.pointerId);
		event.preventDefault();
	}

	function moveResize(event: PointerEvent<HTMLDivElement>): void {
		if (!resizeStart.current) return;
		const width = resizeStart.current.width + event.clientX - resizeStart.current.x;
		setSidebarWidth(Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width)));
	}

	function stopResize(event: PointerEvent<HTMLDivElement>): void {
		resizeStart.current = null;
		setSidebarResizing(false);
		if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
	}

	function closeWorkbench(): void {
		setWorkbenchOpen(false);
		window.requestAnimationFrame(() => workbenchToggleRef.current?.focus());
	}
	function openModelManagement(target: ModelManagementTarget): void {
		setModelManagementTarget(target);
		setSettingsInitialPage('model');
		setSettingsOpen(true);
	}
	const headerControls = !sidebarOpen && !narrow ? <div className="pd-header-navigation"><HistoryNavigation {...history} /><SearchButton open={searchOpen} onClick={() => setSearchOpen(true)} /></div> : undefined;

	return (
		<div className={`pd-app-shell flex${isWindows ? ' is-frameless' : ''}${settingsOpen || searchOpen ? ' is-settings-open' : ''}${sidebarResizing ? ' is-sidebar-resizing' : ''}${workbenchResizing ? ' is-workbench-resizing' : ''}`} style={{ '--pd-sidebar-width': `${sidebarWidth}px`, '--pd-workbench-width': `${clampWorkbenchWidth(workbenchWidth, viewportWidth)}px` } as CSSProperties}>
			<button type="button" className={`pd-sidebar-scrim${narrow && sidebarOpen ? ' is-open' : ''}`} aria-label={t('app.closeSidebar')} aria-hidden={!narrow || !sidebarOpen} inert={!narrow || !sidebarOpen} tabIndex={-1} onClick={() => setSidebarOpen(false)} />
			<Sidebar
				open={sidebarOpen}
				narrow={narrow}
				onToggle={() => setSidebarOpen((open) => !open)}
				onNavigate={() => { setMainView('chat'); if (narrow) setSidebarOpen(false); }}
				automationsOpen={mainView === 'automations'}
				onOpenAutomations={() => { setMainView('automations'); if (narrow) setSidebarOpen(false); }}
				pluginsOpen={mainView === 'plugins'}
				onOpenPlugins={() => { setMainView('plugins'); if (narrow) setSidebarOpen(false); }}
				onOpenSettings={(page) => { if (narrow) setSidebarOpen(false); setSettingsInitialPage(page ?? 'general'); setSettingsOpen(true); }}
				searchOpen={searchOpen}
				history={history}
				onOpenSearch={() => setSearchOpen(true)}
			/>
			{!narrow && sidebarOpen && <div className="pd-sidebar-resize" role="separator" aria-label={t('app.resizeSidebar')} aria-orientation="vertical" aria-valuemin={MIN_SIDEBAR_WIDTH} aria-valuemax={MAX_SIDEBAR_WIDTH} aria-valuenow={sidebarWidth} tabIndex={0} onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={stopResize} onPointerCancel={stopResize} onLostPointerCapture={stopResize} onKeyDown={(event) => {
				if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
				event.preventDefault();
				setSidebarWidth((value) => Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, value + (event.key === 'ArrowRight' ? 16 : -16))));
			}} />}
			<div className="pd-chat-view-host" hidden={mainView !== 'chat'} inert={mainView !== 'chat'}><ChatView onToggleSidebar={() => setSidebarOpen((open) => !open)} onOpenModelManagement={openModelManagement} searchTarget={searchMessageTarget} navigationError={navigation.error} historyControls={mainView === 'chat' ? headerControls : undefined} /></div>
			{mainView === 'automations' && <AutomationPage headerControls={headerControls} onToggleSidebar={() => setSidebarOpen((open) => !open)} onOpenSession={async (cwd, path) => { const selected = await useChatStore.getState().selectSession(cwd, path); if (selected) { setSearchMessageTarget(null); setMainView('chat'); if (narrow) setSidebarOpen(false); } return selected; }} />}
			{mainView === 'plugins' && <PluginsPage headerControls={headerControls} onToggleSidebar={() => setSidebarOpen((open) => !open)} />}
			<button type="button" className={`pd-workbench-scrim${workbenchOpen && mainView === 'chat' ? ' is-open' : ''}`} aria-label={t('app.closeWorkbench')} aria-hidden={!workbenchOpen || mainView !== 'chat'} inert={!workbenchOpen || mainView !== 'chat'} tabIndex={-1} onClick={closeWorkbench} />
			<WorkbenchSidePane open={workbenchOpen && mainView === 'chat'} modal={workbenchOverlay && !settingsOpen && !searchOpen} suspended={settingsOpen || searchOpen} width={clampWorkbenchWidth(workbenchWidth, viewportWidth)} onWidthChange={value => setWorkbenchWidth(clampWorkbenchWidth(value, viewportWidth))} onResizing={setWorkbenchResizing} onClose={closeWorkbench} openRequest={workbenchRequest} />
			{mainView === 'chat' && <HoverTooltip title={t('app.workbench')}><button ref={workbenchToggleRef} type="button" className="pd-workbench-toggle pd-icon-button" aria-label={t(workbenchOpen ? 'app.closeWorkbench' : 'app.openWorkbench')} aria-pressed={workbenchOpen} onClick={() => setWorkbenchOpen((value) => !value)}><Icon name="panelRight" width="17" height="17" /></button></HoverTooltip>}
			{settingsOpen && <SettingsPanel initialPage={settingsInitialPage} modelManagementTarget={settingsInitialPage === 'model' ? modelManagementTarget : undefined} onClose={() => setSettingsOpen(false)} themePreference={themePreference} onThemePreferenceChange={setThemePreference} colorPreferences={colorPreferences} onColorPreferencesChange={setColorPreferences} colorSaveFailed={colorSaveFailed} />}
			{searchOpen && <SearchDialog commands={searchCommands} onClose={() => setSearchOpen(false)} onSelectSession={selectSearchSession} onSelectFile={selectSearchFile} />}
			{isWindows && <WindowControls />}
			<ExtensionDialogHost />
			<UpdateNotice />
			<OperationFeedback />
		</div>
	);
}
