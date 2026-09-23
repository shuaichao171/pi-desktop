import { useEffect, useState } from 'react';
import { ChatView } from './ChatView';
import { SettingsPanel } from './SettingsPanel';
import { Sidebar } from './Sidebar';
import { WindowControls } from './WindowControls';
import { useChatStore } from '../store';

const NARROW_WINDOW_QUERY = '(max-width: 880px)';

export function AppShell() {
	const [sidebarOpen, setSidebarOpen] = useState(
		() => !window.matchMedia(NARROW_WINDOW_QUERY).matches,
	);
	const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_WINDOW_QUERY).matches);
	const [settingsOpen, setSettingsOpen] = useState(false);
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

	return (
		<div className={`pd-app-shell flex${isWindows ? ' is-frameless' : ''}${settingsOpen ? ' is-settings-open' : ''}`}>
			{isWindows && <div className="pd-window-drag-strip" aria-hidden="true"><span className="pd-window-drag-mark">π</span><span>Pi Desktop</span></div>}
			{narrow && sidebarOpen && (
				<button
					type="button"
					className="pd-sidebar-scrim"
					aria-label="关闭侧栏"
					onClick={() => setSidebarOpen(false)}
				/>
			)}
			<Sidebar
				open={sidebarOpen}
				narrow={narrow}
				onToggle={() => setSidebarOpen((open) => !open)}
					onNavigate={() => {
					if (narrow) setSidebarOpen(false);
				}}
				onOpenSettings={() => {
					if (narrow) setSidebarOpen(false);
					setSettingsOpen(true);
				}}
			/>
			<ChatView onToggleSidebar={() => setSidebarOpen((open) => !open)} onOpenSettings={() => setSettingsOpen(true)} />
			{settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
			{isWindows && <WindowControls />}
		</div>
	);
}
