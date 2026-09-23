import { useEffect, useState } from 'react';
import { ChatView } from './ChatView';
import { SettingsPanel } from './SettingsPanel';
import { Sidebar } from './Sidebar';

const NARROW_WINDOW_QUERY = '(max-width: 880px)';

export function AppShell() {
	const [sidebarOpen, setSidebarOpen] = useState(
		() => !window.matchMedia(NARROW_WINDOW_QUERY).matches,
	);
	const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_WINDOW_QUERY).matches);
	const [settingsOpen, setSettingsOpen] = useState(false);

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
		<div className="pd-app-shell flex">
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
		</div>
	);
}
