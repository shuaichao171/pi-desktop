import { app, Menu, nativeImage, Tray } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAppLocale } from './appLocale';

const here = fileURLToPath(new URL('.', import.meta.url));

export interface TrayStatus { running: boolean }

export interface AppTrayOptions {
	showMainWindow: () => void;
	onOpenSettings: () => void;
	quitApp: () => void;
	/** Async status provider (agent snapshot); null keeps the last known state. */
	getStatus?: () => Promise<TrayStatus | null>;
}

let appTray: Tray | null = null;
let trayMenu: Menu | null = null;
let rebuildMenu: (() => void) | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let trayOptions: AppTrayOptions | null = null;
let lastStatus: TrayStatus | null = null;
let refreshInFlight: Promise<void> | null = null;
let dataRevision = 0;
let refreshedRevision = -1;
let refreshedAt = 0;
const REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

/** The app icon shared by the tray and every app window: the packaged
 * resource in production, the build asset in dev (dev otherwise falls back to
 * electron.exe's default icon in the taskbar). */
export function appIconPath(): string {
	return app.isPackaged ? join(process.resourcesPath, 'icon.ico') : join(here, '../../build/icon.ico');
}

function refreshTrayData(): Promise<void> {
	if (refreshInFlight) return refreshInFlight;
	const options = trayOptions;
	if (!options || (dataRevision === refreshedRevision && Date.now() - refreshedAt < REFRESH_INTERVAL_MS)) return Promise.resolve();
	const revision = dataRevision;
	const pending = (async () => {
		try {
			const status = await options.getStatus?.();
			// Ignore a refresh that finished after destruction or replacement of the tray.
			if (trayOptions !== options) return;
			if (status) lastStatus = status;
			refreshedRevision = revision;
			refreshedAt = Date.now();
		} catch { /* keep the last known state and retry on the next menu open */ }
		if (trayOptions === options) rebuildMenu?.();
	})();
	refreshInFlight = pending;
	void pending.finally(() => { if (refreshInFlight === pending) refreshInFlight = null; });
	return pending;
}

/** Session events invalidate the cached tooltip status. */
export function invalidateAppTrayData(): void { dataRevision += 1; }

/**
 * Windows tray icon mirroring ZCode: closing the window hides it, so the tray
 * is the always-available handle for showing the app again or quitting for
 * real (macOS keeps standard dock behavior; Linux closes directly).
 * The context menu only exposes the window, settings and quit actions.
 */
export function createAppTray(options: AppTrayOptions): Tray | null {
	if (process.platform !== 'win32') return null;
	if (appTray && !appTray.isDestroyed()) return appTray;
	try {
		// An empty image would register an invisible (ghost) tray entry, so bail
		// out explicitly instead of creating a tray nobody can see or click.
		const image = nativeImage.createFromPath(appIconPath());
		if (image.isEmpty()) {
			console.error('Pi Desktop tray icon not found:', appIconPath());
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
		const tooltip = running
			? (english ? 'Pi Desktop — running' : 'Pi Desktop — 运行中')
			: 'Pi Desktop';
		appTray.setToolTip(tooltip);
		const template: Electron.MenuItemConstructorOptions[] = [
			{ label: english ? 'Show window' : '显示界面', click: options.showMainWindow },
			{ label: english ? 'Settings' : '设置', click: options.onOpenSettings },
			{ label: english ? 'Quit' : '退出', click: options.quitApp },
		];
		trayMenu = Menu.buildFromTemplate(template);
	};
	appTray.on('click', () => { void refreshTrayData(); options.showMainWindow(); });
	appTray.on('double-click', () => { void refreshTrayData(); options.showMainWindow(); });
	// Always expose all three actions immediately, even if the agent is unresponsive.
	// Refresh the tooltip without a delayed popup stealing focus.
	appTray.on('right-click', () => {
		if (appTray && !appTray.isDestroyed() && trayMenu) appTray.popUpContextMenu(trayMenu);
		void refreshTrayData();
	});
	rebuildMenu();
	// A bounded fallback keeps the tooltip status current.
	refreshTimer = setInterval(() => { void refreshTrayData(); }, REFRESH_INTERVAL_MS);
	refreshTimer.unref?.();
	void refreshTrayData();
	return appTray;
}

/** Removes the tray icon so quitting never leaves a ghost entry behind. */
export function destroyAppTray(): void {
	rebuildMenu = null;
	trayMenu = null;
	trayOptions = null;
	lastStatus = null;
	refreshInFlight = null;
	refreshedRevision = -1;
	refreshedAt = 0;
	if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
	if (!appTray) return;
	try { appTray.destroy(); } catch { /* already gone */ }
	appTray = null;
}

/** Re-reads the locale so tray labels follow an in-app language switch. */
export function updateAppTrayMenu(): void {
	rebuildMenu?.();
}
