import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { ChatView } from './ChatView';
import { SettingsPanel, type ThemePreference } from './SettingsPanel';
import { Sidebar } from './Sidebar';
import { Icon } from './Icons';
import { WindowControls } from './WindowControls';
import { WorkbenchSidePane } from './WorkbenchSidePane';
import { useChatStore } from '../store';
import { useT } from '../i18n';

const NARROW_WINDOW_QUERY = '(max-width: 880px)';
const MIN_SIDEBAR_WIDTH = 232;
const MAX_SIDEBAR_WIDTH = 420;

function readSidebarWidth(): number {
	const stored = Number(localStorage.getItem('pi-desktop.sidebar-width'));
	return Number.isFinite(stored) && stored >= MIN_SIDEBAR_WIDTH && stored <= MAX_SIDEBAR_WIDTH ? stored : 274;
}

function readThemePreference(): ThemePreference {
	const stored = localStorage.getItem('pi-desktop.theme');
	return stored === 'light' || stored === 'dark' ? stored : 'system';
}

function readWorkbenchOpen(): boolean {
	return !window.matchMedia(NARROW_WINDOW_QUERY).matches && localStorage.getItem('pi-desktop.workbench-open') === 'true';
}

export function AppShell() {
	const { t } = useT();
	const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia(NARROW_WINDOW_QUERY).matches);
	const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_WINDOW_QUERY).matches);
	const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
	const [themePreference, setThemePreference] = useState<ThemePreference>(readThemePreference);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [workbenchOpen, setWorkbenchOpen] = useState(readWorkbenchOpen);
	const resizeStart = useRef<{ x: number; width: number } | null>(null);
	const platform = useChatStore((state) => state.appInfo?.platform);
	const isWindows = (platform ?? (navigator.userAgent.includes('Windows') ? 'win32' : '')) === 'win32';

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
		if (!narrow || !sidebarOpen || settingsOpen) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setSidebarOpen(false);
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [narrow, sidebarOpen, settingsOpen]);

	useLayoutEffect(() => {
		const media = window.matchMedia('(prefers-color-scheme: dark)');
		const applyTheme = () => {
			const resolved = themePreference === 'system' ? (media.matches ? 'dark' : 'light') : themePreference;
			document.documentElement.dataset.theme = resolved;
			document.documentElement.style.colorScheme = resolved;
		};
		applyTheme();
		media.addEventListener('change', applyTheme);
		localStorage.setItem('pi-desktop.theme', themePreference);
		return () => media.removeEventListener('change', applyTheme);
	}, [themePreference]);

	useEffect(() => {
		localStorage.setItem('pi-desktop.sidebar-width', String(sidebarWidth));
	}, [sidebarWidth]);

	useEffect(() => {
		localStorage.setItem('pi-desktop.workbench-open', String(workbenchOpen));
	}, [workbenchOpen]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'b') {
				event.preventDefault();
				setSidebarOpen((open) => !open);
			}
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, []);

	function startResize(event: PointerEvent<HTMLDivElement>): void {
		if (event.button !== 0) return;
		resizeStart.current = { x: event.clientX, width: sidebarWidth };
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
		if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
	}

	return (
		<div className={`pd-app-shell flex${isWindows ? ' is-frameless' : ''}${settingsOpen ? ' is-settings-open' : ''}`} style={{ '--pd-sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
			{narrow && sidebarOpen && <button type="button" className="pd-sidebar-scrim" aria-label={t('app.closeSidebar')} onClick={() => setSidebarOpen(false)} />}
			<Sidebar
				open={sidebarOpen}
				narrow={narrow}
				onToggle={() => setSidebarOpen((open) => !open)}
				onNavigate={() => { if (narrow) setSidebarOpen(false); }}
				onOpenSettings={() => { if (narrow) setSidebarOpen(false); setSettingsOpen(true); }}
			/>
			{!narrow && sidebarOpen && <div className="pd-sidebar-resize" role="separator" aria-label={t('app.resizeSidebar')} aria-orientation="vertical" aria-valuemin={MIN_SIDEBAR_WIDTH} aria-valuemax={MAX_SIDEBAR_WIDTH} aria-valuenow={sidebarWidth} tabIndex={0} onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={stopResize} onPointerCancel={stopResize} onKeyDown={(event) => {
				if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
				event.preventDefault();
				setSidebarWidth((value) => Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, value + (event.key === 'ArrowRight' ? 16 : -16))));
			}} />}
			<ChatView onToggleSidebar={() => setSidebarOpen((open) => !open)} />
			{workbenchOpen && <button type="button" className="pd-workbench-scrim" aria-label={t('app.closeWorkbench')} onClick={() => setWorkbenchOpen(false)} />}
			<WorkbenchSidePane open={workbenchOpen} onClose={() => setWorkbenchOpen(false)} />
			<button type="button" className="pd-workbench-toggle pd-icon-button" aria-label={t(workbenchOpen ? 'app.closeWorkbench' : 'app.openWorkbench')} aria-pressed={workbenchOpen} title={t('app.workbench')} onClick={() => setWorkbenchOpen((value) => !value)}><Icon name="panelRight" width="17" height="17" /></button>
			{settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} themePreference={themePreference} onThemePreferenceChange={setThemePreference} />}
			{isWindows && <WindowControls />}
		</div>
	);
}
