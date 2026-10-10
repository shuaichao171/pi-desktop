import { initializeDiagnostics, recordDiagnostic } from './diagnostics.ts';
import { app, BrowserWindow, dialog, Menu, session, shell } from 'electron';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPC_CHANNELS } from '@pidesktop/shared';
import { getAppLocale } from './appLocale';
import { createSplashErrorHtml, createSplashHtml } from './splash';
import { showEditContextMenu } from './editContextMenu.ts';
import { createAppTray, destroyAppTray } from './tray';
import { parseDesktopLaunch, rendererLaunchUrl, reservePaiProfile, validatePaiWorkspace, type DesktopLaunch, type PaiProfile } from './desktopLaunch.ts';

let paiProfile: PaiProfile | null = null;
// Pai windows relocate userData to an isolated profile; appearance and other
// shared state still live in the original base directory.
let baseUserData: string | undefined;
const launch: DesktopLaunch = (() => {
	try {
		const parsed = parseDesktopLaunch(process.argv);
		if (parsed.windowMode === 'full') return parsed;
		const cwd = validatePaiWorkspace(parsed.cwd);
		// The pai profile relocates userData; keep the base path for shared state.
		baseUserData = app.getPath('userData');
		paiProfile = reservePaiProfile(baseUserData);
		// Must be configured before app.ready creates Chromium's default session.
		app.setPath('userData', paiProfile.userData);
		app.setPath('sessionData', paiProfile.sessionData);
		return { windowMode: 'pai', cwd };
	} catch (error) {
		dialog.showErrorBox('Pi Desktop', error instanceof Error ? error.message : String(error));
		app.exit(1);
		return { windowMode: 'full' };
	}
})();
// Electron/agent shutdown completes before the process exits. Keep the lease
// until then so another pai cannot open a profile still used by this instance.
if (paiProfile) process.once('exit', () => paiProfile?.release());

const here = fileURLToPath(new URL('.', import.meta.url));
let ipc: typeof import('./ipc') | null = null;
let updateService: typeof import('./updateService').updateService | null = null;
let mainRevealed = false;
let pendingOpenSettings = false;
let startupCancelled = false;
const pendingWindowReveals = new WeakMap<BrowserWindow, () => void>();
const rendererWindows = new Set<BrowserWindow>();

function showMainWindow(): void {
	const windows = BrowserWindow.getAllWindows();
	const target = windows.find((window) => window.isVisible()) ?? windows.find((window) => window.isMinimized()) ?? windows[0];
	if (!target || target.isDestroyed()) return;
	if (target.isMinimized()) target.restore();
	target.show();
	target.focus();
}

function openSettings(): void {
	showMainWindow();
	if (!mainRevealed || !ipc) {
		pendingOpenSettings = true;
		return;
	}
	ipc.sendAppCommand({ type: 'open-settings' });
}

function splashUrl(html: string): string {
	return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function showStartupError(splash: BrowserWindow, error: unknown): void {
	startupCancelled = true;
	const message = error instanceof Error ? error.message : String(error);
	const english = getAppLocale() === 'en-US';
	console.error('Pi Desktop failed to start:', error);
	if (splash.isDestroyed()) {
		dialog.showErrorBox(english ? 'Pi Desktop startup failed' : 'Pi Desktop 启动失败', message);
		app.quit();
		return;
	}
	if (!splash.isVisible()) splash.show();
	splash.setSize(420, 300);
	splash.center();
	void splash.loadURL(splashUrl(createSplashErrorHtml(message, getAppLocale())))
		.catch(() => {})
		.finally(() => {
			if (splash.isDestroyed()) return;
			void dialog.showMessageBox(splash, {
				type: 'error',
				title: english ? 'Pi Desktop startup failed' : 'Pi Desktop 启动失败',
				message: english ? 'The workspace could not start' : '工作台未能启动',
				detail: message,
				buttons: [english ? 'Close' : '关闭'],
			}).finally(() => app.quit());
		});
}

function createWindow(onReady?: () => void, onLoadError?: (error: unknown) => void): BrowserWindow {
	const win = new BrowserWindow({
		width: launch.windowMode === 'pai' ? 920 : 1280,
		height: launch.windowMode === 'pai' ? 780 : 820,
		minWidth: 680,
		minHeight: 520,
		backgroundColor: '#111216',
		title: launch.windowMode === 'pai' ? 'pai' : 'Pi Desktop',
		// Match ZCode's Windows chrome: the renderer draws the title bar and controls.
		// Keep the native title bar on macOS and Linux.
		frame: process.platform !== 'win32',
		autoHideMenuBar: process.platform === 'win32',
		show: false,
		webPreferences: {
			preload: join(here, '../preload/index.mjs'),
			// Allow the restored conversation to paint while the logo is visible.
			backgroundThrottling: false,
			contextIsolation: true,
			// ESM preload requires sandbox: false (Electron ≥ 28). Keep the
			// context-isolated bridge narrow; the preload itself has Node access.
			sandbox: false,
			nodeIntegration: false,
		},
	});
	rendererWindows.add(win);
	const publishChromeState = (): void => {
		if (win.webContents.isDestroyed()) return;
		win.webContents.send(IPC_CHANNELS.windowChromeStateChanged, { isMaximized: win.isMaximized() });
	};
	win.on('maximize', publishChromeState);
	win.on('unmaximize', publishChromeState);

	let loaded = false;
	let firstPaintReady = false;
	let rendererReady = false;
	let revealed = false;
	let startupFailureReported = false;
	let recoveryDialogVisible = false;
	let unresponsiveTimer: ReturnType<typeof setTimeout> | null = null;
	const reportStartupFailure = (error: unknown): void => {
		recordDiagnostic({ stage: 'startup', action: 'renderer-start', outcome: 'failure' });
		if (startupFailureReported || win.isDestroyed()) return;
		startupFailureReported = true;
		if (onLoadError) onLoadError(error);
		else {
			console.error('Pi Desktop renderer failed to load:', error);
			dialog.showErrorBox(getAppLocale() === 'en-US' ? 'Pi Desktop startup failed' : 'Pi Desktop 启动失败', String(error));
		}
		win.destroy();
	};
	const reportRendererFailure = (reason: string): void => {
		if (win.isDestroyed()) return;
		console.error('Pi Desktop renderer failed:', reason);
		if (!revealed) { reportStartupFailure(new Error(reason)); return; }
		if (recoveryDialogVisible) return;
		recoveryDialogVisible = true;
		const english = getAppLocale() === 'en-US';
		void dialog.showMessageBox(win, {
			type: 'error',
			title: english ? 'Pi Desktop stopped responding' : 'Pi Desktop 界面无响应',
			message: english ? 'The window stopped working.' : '应用窗口未能正常运行。',
			detail: english ? 'Reload the window to restore your workspace.' : '重新加载窗口可恢复工作区。',
			buttons: english ? ['Reload window', 'Close window'] : ['重新加载窗口', '关闭窗口'],
			defaultId: 0,
			cancelId: 1,
			noLink: true,
		}).then(({ response }) => {
			if (win.isDestroyed()) return;
			if (response === 0) win.reload();
			// destroy() bypasses the Windows close-to-tray interception: a dead
			// renderer must not linger as an invisible tray window.
			else win.destroy();
		}).catch((error: unknown) => console.error('Pi Desktop renderer recovery failed:', error))
			.finally(() => { recoveryDialogVisible = false; });
	};
	win.webContents.on('render-process-gone', (_event, details) => {
		if (details.reason !== 'clean-exit') reportRendererFailure(details.reason);
	});
	win.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
		if (isMainFrame && code !== -3) reportRendererFailure(description);
	});
	win.on('unresponsive', () => {
		if (unresponsiveTimer) return;
		unresponsiveTimer = setTimeout(() => {
			unresponsiveTimer = null;
			reportRendererFailure('The renderer remained unresponsive.');
		}, 5_000);
	});
	win.on('responsive', () => {
		if (unresponsiveTimer) clearTimeout(unresponsiveTimer);
		unresponsiveTimer = null;
	});
	// Windows mirrors ZCode: closing hides to the tray while the agent keeps
	// running. 4.2: the behavior follows the desktop setting — hide to tray by
	// default (with a notice while tasks run), or quit after a confirm dialog.
	let closeDialogOpen = false;
	const requestClose = (): void => {
		if (closeDialogOpen || win.isDestroyed()) return;
		closeDialogOpen = true;
		void (async () => {
			try {
				const settings = launch.windowMode === 'pai' ? { closeBehavior: 'quit' as const }
					: ipc ? ipc.readCurrentDesktopSettings() : { notificationsEnabled: true, closeBehavior: 'tray' as const };
				const busy = ipc ? await ipc.isAgentWorkActive() : false;
				const english = getAppLocale() === 'en-US';
				if (!busy) {
					if (settings.closeBehavior === 'quit') app.quit(); else win.hide();
					return;
				}
				if (settings.closeBehavior === 'quit') {
					const choice = await dialog.showMessageBox(win, {
						type: 'warning',
						message: english ? 'Tasks are still running' : '仍有任务在运行',
						detail: english ? 'Quitting interrupts the running conversation or automation.' : '退出会中断正在运行的会话或自动化任务。',
						buttons: [english ? 'Cancel' : '取消', english ? 'Quit' : '退出'],
						defaultId: 0,
						cancelId: 0,
					});
					if (choice.response === 1) app.quit();
					return;
				}
				const choice = await dialog.showMessageBox(win, {
					type: 'info',
					message: english ? 'Pi Desktop is still running tasks' : 'Pi Desktop 仍有任务在运行',
					detail: english ? 'It keeps running from the tray.' : '窗口将最小化到托盘，任务继续在后台运行。',
					buttons: [english ? 'Minimize to tray' : '最小化到托盘', english ? 'Quit anyway' : '仍要退出'],
					checkboxLabel: english ? 'Remember my choice' : '记住我的选择',
					defaultId: 0,
					cancelId: 0,
				});
				if (choice.response === 1) {
					if (choice.checkboxChecked) await ipc?.saveCloseBehavior('quit');
					app.quit();
				} else {
					if (choice.checkboxChecked) await ipc?.saveCloseBehavior('tray');
					win.hide();
				}
			} catch (error) {
				console.error('Close handling failed:', error);
				if (!win.isDestroyed()) dialog.showErrorBox('Pi Desktop', error instanceof Error ? error.message : String(error));
			} finally {
				closeDialogOpen = false;
			}
		})();
	};
	win.on('close', (event) => {
		if (process.platform !== 'win32' && launch.windowMode !== 'pai' || readyToQuit) return;
		event.preventDefault();
		requestClose();
	});
	win.on('closed', () => {
		if (unresponsiveTimer) clearTimeout(unresponsiveTimer);
		pendingWindowReveals.delete(win);
		rendererWindows.delete(win);
	});
	const reveal = (): void => {
		if (!loaded || !firstPaintReady || !rendererReady || revealed || startupCancelled || win.isDestroyed()) return;
		revealed = true;
		pendingWindowReveals.delete(win);
		win.show();
		win.webContents.setBackgroundThrottling(true);
		onReady?.();
	};
	pendingWindowReveals.set(win, () => {
		rendererReady = true;
		reveal();
	});
	win.once('ready-to-show', () => {
		firstPaintReady = true;
		reveal();
	});
	const openExternalLink = (url: string): void => {
		try {
			const parsed = new URL(url);
			if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
				void shell.openExternal(parsed.toString());
			}
		} catch {
			// Ignore malformed links from generated content.
		}
	};
	win.webContents.setWindowOpenHandler(({ url }) => {
		openExternalLink(url);
		return { action: 'deny' };
	});
	win.webContents.on('will-navigate', (event, url) => {
		if (url === win.webContents.getURL()) return;
		event.preventDefault();
		openExternalLink(url);
	});
	// Right-click editing menu (cut/copy/paste...) for plain text fields; targets
	// with their own React menu preventDefault() and never reach this handler.
	win.webContents.on('context-menu', (_event, params) => {
		showEditContextMenu(win, params);
	});

	// electron-vite dev serves the renderer from the HMR server.
	const load = !app.isPackaged && process.env.ELECTRON_RENDERER_URL
		? win.loadURL(rendererLaunchUrl(process.env.ELECTRON_RENDERER_URL, launch))
		: win.loadFile(join(here, '../renderer/index.html'), { query: launch.windowMode === 'pai' ? { mode: 'pai' } : {} });
	void load.then(() => {
		loaded = true;
		reveal();
	}).catch(reportStartupFailure);
	return win;
}

async function bootstrap(splash: BrowserWindow): Promise<void> {
	try {
		// Import the host bridge after the splash has painted.
		const module = await import('./ipc');
		if (startupCancelled || splash.isDestroyed()) return;
		ipc = module;
		updateService = launch.windowMode === 'full' ? module.updateService : null;
		module.registerIpc({
			windowMode: launch.windowMode,
			baseUserData,
			onRendererReady: (win) => pendingWindowReveals.get(win)?.(),
			getDialogWindow: () => {
				const focused = BrowserWindow.getFocusedWindow();
				return focused && rendererWindows.has(focused) ? focused : [...rendererWindows][0];
			},
		});
		const workspace = module.defaultWorkspace(launch.windowMode === 'pai' ? launch.cwd : undefined);
		// A workspace that already exists — notably a Windows drive root such as
		// D:\ — must not be passed to mkdirSync: recursive mkdir still fails with
		// EPERM on drive roots. Only create the directory when it is missing.
		if (!statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) mkdirSync(workspace, { recursive: true });
		updateService?.setBeforeInstall(async () => {
			if (ipc) await ipc.disposeServices();
			readyToQuit = true;
		});
		updateService?.start();
		const mainWindow = createWindow(() => {
			mainRevealed = true;
			if (!splash.isDestroyed()) splash.close();
			if (pendingOpenSettings) {
				pendingOpenSettings = false;
				module.sendAppCommand({ type: 'open-settings' });
			}
		}, (error) => showStartupError(splash, error));
		// Load the UI and Pi history concurrently, keeping the logo until React
		// acknowledges a committed conversation (or a required extension dialog).
		void module.agentService.init({ cwd: workspace, ...(launch.windowMode === 'pai' ? { fresh: true } : {}) }).catch((error: unknown) => {
			recordDiagnostic({ stage: 'startup', action: 'agent-init', outcome: 'failure' });
			console.error('Pi agent failed to initialize:', error);
			if (startupCancelled || mainRevealed) return;
			mainWindow.destroy();
			showStartupError(splash, error);
		});
	} catch (error) {
		if (!startupCancelled) showStartupError(splash, error);
		recordDiagnostic({ stage: 'startup', action: 'bootstrap', outcome: 'failure' });
	}
}

const hasSingleInstanceLock = launch.windowMode === 'pai' || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
	app.quit();
} else {
	app.on('second-instance', () => {
		// Also restores a window hidden to the tray (neither visible nor minimized).
		showMainWindow();
	});

	void app.whenReady().then(() => {
		initializeDiagnostics(join(app.getPath('userData'), 'diagnostics'));
		recordDiagnostic({ stage: 'startup', action: 'app-ready', outcome: 'success' });
	if (process.platform === 'win32') {
		app.setAppUserModelId('dev.pidesktop.app');
		Menu.setApplicationMenu(null);
		if (launch.windowMode === 'full') createAppTray({
			showMainWindow,
			onOpenSettings: openSettings,
			quitApp: () => app.quit(),
			getStatus: async () => {
				if (!ipc) return null;
				try {
					const snapshot = await ipc.agentService.getSnapshot();
					return { running: snapshot.status === 'busy' };
				} catch { return null; }
			},
		});
	}
	// The renderer only needs clipboard write for its explicit copy action.
	session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
		callback(permission === 'clipboard-sanitized-write');
	});
	const splash = new BrowserWindow({
		width: 224,
		height: 224,
		resizable: false,
		maximizable: false,
		minimizable: false,
		frame: false,
		center: true,
		show: false,
		transparent: true,
		hasShadow: false,
		backgroundColor: '#00000000',
		title: 'Pi Desktop',
		webPreferences: {
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
		},
	});
	splash.on('closed', () => {
		if (!mainRevealed) {
			startupCancelled = true;
			app.quit();
		}
	});
	let started = false;
	const showAndStart = (): void => {
		if (started || splash.isDestroyed()) return;
		started = true;
		splash.show();
		// Give the visible splash a few frames before evaluating the heavy Pi import.
		setTimeout(() => {
			if (!startupCancelled && !splash.isDestroyed()) void bootstrap(splash);
		}, 100);
	};
	splash.once('ready-to-show', showAndStart);
	void splash.loadURL(splashUrl(createSplashHtml(getAppLocale())))
		.then(() => {
			// A fallback for environments that never emit ready-to-show.
			setTimeout(showAndStart, 800);
		})
		.catch((error: unknown) => {
			console.error('Pi Desktop splash failed to load:', error);
			startupCancelled = true;
			showStartupError(splash, error);
		});

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0 && ipc) createWindow();
	});
	});
}

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin' || launch.windowMode === 'pai') app.quit();
});

let readyToQuit = false;
let disposing = false;
app.on('before-quit', (event) => {
	updateService?.stop();
	destroyAppTray();
	if (readyToQuit || !ipc) return;
	event.preventDefault();
	if (disposing) return;
	disposing = true;
	void ipc.disposeServices()
		.catch((error: unknown) => console.error('Pi Desktop shutdown failed:', error))
		.finally(() => {
			readyToQuit = true;
			app.quit();
		});
});
