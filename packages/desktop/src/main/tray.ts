import { app, Menu, nativeImage, Tray } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAppLocale } from './appLocale';

const here = fileURLToPath(new URL('.', import.meta.url));

let appTray: Tray | null = null;
let rebuildMenu: (() => void) | null = null;

function trayIconPath(): string {
	return app.isPackaged ? join(process.resourcesPath, 'icon.ico') : join(here, '../../build/icon.ico');
}

/**
 * Windows tray icon mirroring ZCode: closing the window hides it, so the tray
 * is the always-available handle for showing the app again or quitting for
 * real (macOS keeps standard dock behavior; Linux closes directly).
 */
export function createAppTray(options: { showMainWindow: () => void; quitApp: () => void }): Tray | null {
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
	const english = getAppLocale() === 'en-US';
	rebuildMenu = (): void => {
		if (!appTray || appTray.isDestroyed()) return;
		appTray.setToolTip('Pi Desktop');
		appTray.setContextMenu(Menu.buildFromTemplate([
			{ label: english ? 'Show Pi Desktop' : '显示 Pi Desktop', click: options.showMainWindow },
			{ type: 'separator' },
			{ label: english ? 'Quit' : '退出', click: options.quitApp },
		]));
	};
	appTray.on('click', options.showMainWindow);
	appTray.on('double-click', options.showMainWindow);
	rebuildMenu();
	return appTray;
}

/** Removes the tray icon so quitting never leaves a ghost entry behind. */
export function destroyAppTray(): void {
	rebuildMenu = null;
	if (!appTray) return;
	try { appTray.destroy(); } catch { /* already gone */ }
	appTray = null;
}

/** Re-reads the locale so tray labels follow an in-app language switch. */
export function updateAppTrayMenu(): void {
	rebuildMenu?.();
}
