import { app, Menu, nativeImage, Tray } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAppLocale } from './appLocale';

const here = fileURLToPath(new URL('.', import.meta.url));

export interface TrayStatus { running: boolean; project: string }
export interface TraySession { path: string; title: string }

export interface AppTrayOptions {
	showMainWindow: () => void;
	quitApp: () => void;
	/** Async status provider (agent snapshot); null keeps the last known state. */
	getStatus?: () => Promise<TrayStatus | null>;
	/** Async recent-conversation provider for the current workspace. */
	getRecentSessions?: () => Promise<TraySession[]>;
	onNewSession?: () => void;
	onSwitchSession?: (path: string) => void;
	onCheckUpdates?: () => void;
}

let appTray: Tray | null = null;
let rebuildMenu: (() => void) | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let trayOptions: AppTrayOptions | null = null;
let lastStatus: TrayStatus | null = null;
let recentSessions: TraySession[] = [];

function trayIconPath(): string {
	return app.isPackaged ? join(process.resourcesPath, 'icon.ico') : join(here, '../../build/icon.ico');
}

function truncate(value: string, max: number): string {
	const plain = value.replace(/\s+/g, ' ').trim();
	return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

async function refreshTrayData(): Promise<void> {
	if (!trayOptions) return;
	try {
		const [status, sessions] = await Promise.all([
			trayOptions.getStatus?.() ?? Promise.resolve(null),
			trayOptions.getRecentSessions?.() ?? Promise.resolve([]),
		]);
		if (status) lastStatus = status;
		recentSessions = sessions;
	} catch { /* keep the last known state */ }
	rebuildMenu?.();
}

/**
 * Windows tray icon mirroring ZCode: closing the window hides it, so the tray
 * is the always-available handle for showing the app again or quitting for
 * real (macOS keeps standard dock behavior; Linux closes directly).
 * 4.1: the menu also surfaces run status, recent conversations, a new-session
 * action and an update check.
 */
export function createAppTray(options: AppTrayOptions): Tray | null {
	if (process.platform !== 'win32') return null;
	if (appTray && !appTray.isDestroyed()) return appTray;
	try {
		// An empty image would register an invisible (ghost) tray entry, so bail
		// out explicitly instead of creating a tray nobody can see or click.
		const image = nativeImage.createFromPath(trayIconPath());
		if (image.isEmpty()) {
			console.error('Pi Desktop tray icon not found:', trayIconPath());
			return null;
		}
		appTray = new Tray(image);
	} catch (error) {
		console.error('Pi Desktop tray icon failed to load:', error);
		return null;
	}
	trayOptions = options;
	rebuildMenu = (): void => {
		if (!appTray || appTray.isDestroyed()) return;
		const english = getAppLocale() === 'en-US';
		const running = lastStatus?.running ?? false;
		const project = lastStatus?.project ?? '';
		const tooltip = running
			? (english ? 'Pi Desktop — running' : 'Pi Desktop — 运行中')
			: 'Pi Desktop';
		appTray.setToolTip(tooltip);
		const template: Electron.MenuItemConstructorOptions[] = [
			{ label: running ? (english ? `Running${project ? ` · ${project}` : ''}` : `运行中${project ? ` · ${project}` : ''}`) : (english ? 'Idle' : '空闲'), enabled: false },
			{ label: english ? 'New conversation' : '新建会话', click: () => options.onNewSession?.() ?? options.showMainWindow() },
			{ type: 'separator' },
		];
		if (recentSessions.length > 0) {
			for (const session of recentSessions) {
				template.push({ label: truncate(session.title, 36), click: () => options.onSwitchSession?.(session.path) ?? options.showMainWindow() });
			}
			template.push({ type: 'separator' });
		}
		if (options.onCheckUpdates) template.push({ label: english ? 'Check for updates' : '检查更新', click: options.onCheckUpdates });
		template.push(
			{ type: 'separator' },
			{ label: english ? 'Show Pi Desktop' : '显示 Pi Desktop', click: options.showMainWindow },
			{ label: english ? 'Quit' : '退出', click: options.quitApp },
		);
		appTray.setContextMenu(Menu.buildFromTemplate(template));
	};
	appTray.on('click', () => { void refreshTrayData(); options.showMainWindow(); });
	appTray.on('double-click', () => { void refreshTrayData(); options.showMainWindow(); });
	rebuildMenu();
	// Keep status/recent sessions fresh without new plumbing: poll while the
	// tray exists (unref'd so it never holds the process open).
	refreshTimer = setInterval(() => { void refreshTrayData(); }, 20_000);
	refreshTimer.unref?.();
	void refreshTrayData();
	return appTray;
}

/** Removes the tray icon so quitting never leaves a ghost entry behind. */
export function destroyAppTray(): void {
	rebuildMenu = null;
	trayOptions = null;
	lastStatus = null;
	recentSessions = [];
	if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
	if (!appTray) return;
	try { appTray.destroy(); } catch { /* already gone */ }
	appTray = null;
}

/** Re-reads the locale so tray labels follow an in-app language switch. */
export function updateAppTrayMenu(): void {
	rebuildMenu?.();
}
