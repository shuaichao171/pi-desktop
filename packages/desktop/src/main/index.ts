import { initializeDiagnostics, recordDiagnostic } from './diagnostics.ts';
import { userInfo } from 'node:os';
import { app, BrowserWindow, dialog, Menu, session, shell } from 'electron';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPC_CHANNELS } from '@pidesktop/shared';
import { getAppLocale } from './appLocale';
import { createBootErrorHtml, createBootHtml } from './splash';
import { showEditContextMenu } from './editContextMenu.ts';
import { createAppTray, destroyAppTray } from './tray';
import { paiPipeName, startPaiPipeServer } from './paiPipe.ts';
import { parseDesktopLaunch, reservePaiProfile, validatePaiSession, validatePaiWorkspace, type DesktopLaunch, type PaiProfile } from './desktopLaunch.ts';
import {
	MAIN_WINDOW_MIN_HEIGHT,
	MAIN_WINDOW_MIN_WIDTH,
	resolveStartupWindowState,
	trackWindowState,
	windowStateFromWindow,
	windowStatePath,
	type WindowState,
} from './windowState';

let paiProfile: PaiProfile | null = null;
// A --multi window relocates userData to an isolated profile; appearance and
// other shared state still live in the original base directory.
let baseUserData: string | undefined;
// A cold `pai` launch: this process becomes the main instance (holding the
// app singleton) and opens a hosted pai chat window once boot completes.
let pendingPaiLaunch: { cwd: string; sessionPath?: string } | null = null;
const launch: DesktopLaunch = (() => {
	try {
		const parsed = parseDesktopLaunch(process.argv);
		if (parsed.windowMode === 'multi') {
			// A second full-size instance with its own profile: skips the app
			// singleton, tray and updater, and starts a fresh conversation so it
			// never reopens a transcript another instance may be writing.
			baseUserData = app.getPath('userData');
			paiProfile = reservePaiProfile(baseUserData, { rootName: 'multi-profiles' });
			app.setPath('userData', paiProfile.userData);
			app.setPath('sessionData', paiProfile.sessionData);
			return { windowMode: 'multi' };
		}
		if (parsed.windowMode === 'pai') {
			// Hosted mode: no isolated profile and no second agent boot in this
			// process. If the singleton is taken, the bid fails below and the
			// running instance receives the request through `second-instance`.
			const cwd = validatePaiWorkspace(parsed.cwd);
			const sessionPath = parsed.sessionPath === undefined ? undefined : validatePaiSession(parsed.sessionPath);
			pendingPaiLaunch = sessionPath ? { cwd, sessionPath } : { cwd };
		}
		return { windowMode: 'full' };
	} catch (error) {
		dialog.showErrorBox('Pi Desktop', error instanceof Error ? error.message : String(error));
		app.exit(1);
		return { windowMode: 'full' };
	}
})();
// Electron/agent shutdown completes before the process exits. Keep the lease
// until then so another instance cannot open a profile still used by this one.
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

/**
 * A second process lost its singleton bid. A `pai` spawn hands its window
 * request over to this instance; a plain launch just reveals the main window.
 */
function showPaiError(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	console.error('pai request failed:', message);
	// The async dialog keeps the app responsive; showErrorBox is synchronous and
	// would freeze the main process (and the pai pipe server) until dismissed.
	void dialog.showMessageBox({
		type: 'error',
		title: 'pai',
		message,
		buttons: [getAppLocale() === 'en-US' ? 'Close' : '关闭'],
	}).catch(() => {});
}

function openPaiHandoff(commandLine: readonly string[]): void {
	try {
		const parsed = parseDesktopLaunch(commandLine);
		if (parsed.windowMode !== 'pai') {
			showMainWindow();
			return;
		}
		const cwd = validatePaiWorkspace(parsed.cwd);
		const sessionPath = parsed.sessionPath === undefined ? undefined : validatePaiSession(parsed.sessionPath);
		void import('./ipc')
			.then(module => module.openPaiWindow(sessionPath ? { cwd, sessionPath } : { cwd }))
			.catch((error: unknown) => showPaiError(error));
	} catch (error) {
		showPaiError(error);
	}
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
	void splash.loadURL(splashUrl(createBootErrorHtml(message, getAppLocale())))
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

interface CreateMainWindowOptions {
	/** Where the window opens: the saved placement, aligned with the boot window. */
	state: WindowState;
	/** Follow this window's position when revealed (the boot window the user may drag). */
	mirror?: BrowserWindow;
	onReady?: () => void;
	onLoadError?: (error: unknown) => void;
}

function createWindow(options: CreateMainWindowOptions): BrowserWindow {
	const { state, onReady, onLoadError } = options;
	const win = new BrowserWindow({
		width: state.bounds.width,
		height: state.bounds.height,
		x: state.bounds.x,
		y: state.bounds.y,
		minWidth: MAIN_WINDOW_MIN_WIDTH,
		minHeight: MAIN_WINDOW_MIN_HEIGHT,
		backgroundColor: '#111216',
		title: 'Pi Desktop',
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
	// A window closed maximized reopens maximized; maximize() before the first
	// show() reveals it already covering the work area.
	if (state.maximized) win.maximize();
	// Remember where the user leaves the window so the next launch opens here.
	trackWindowState(win, windowStatePath(app.getPath('userData')));
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
	// default (with a notice while tasks run), or quit after a confirm dialog. The
	// dialog's "remember my choice" checkbox persists the chosen behavior and stops
	// asking; picking a behavior in Settings brings the confirmation back.
	let closeDialogOpen = false;
	const requestClose = (): void => {
		if (closeDialogOpen || win.isDestroyed()) return;
		closeDialogOpen = true;
		void (async () => {
			try {
				const settings = ipc ? ipc.readCurrentDesktopSettings() : null;
				const closeBehavior = launch.windowMode !== 'full' ? 'quit' as const : settings?.closeBehavior ?? 'tray';
				const confirmBusyClose = settings?.confirmBusyClose !== false;
				const busy = ipc ? await ipc.isAgentWorkActive() : false;
				const english = getAppLocale() === 'en-US';
				// Only the full window can change the close behavior again, so pai keeps asking instead of
				// offering a memory it could never undo.
				const rememberChoice = launch.windowMode === 'full' ? { checkboxLabel: english ? 'Remember my choice' : '记住我的选择' } : {};
				// A remembered choice is applied straight away; only a busy close that has not
				// been decided yet asks.
				if (!busy || !confirmBusyClose) {
					if (closeBehavior === 'quit') app.quit(); else win.hide();
					return;
				}
				if (closeBehavior === 'quit') {
					const choice = await dialog.showMessageBox(win, {
						type: 'warning',
						message: english ? 'Tasks are still running' : '仍有任务在运行',
						detail: english ? 'Quitting interrupts the running conversation or automation.' : '退出会中断正在运行的会话或自动化任务。',
						buttons: [english ? 'Cancel' : '取消', english ? 'Quit' : '退出'],
						...rememberChoice,
						defaultId: 0,
						cancelId: 0,
					});
					if (choice.response === 1) {
						if (choice.checkboxChecked) await ipc?.saveCloseChoice('quit');
						app.quit();
					}
					return;
				}
				const choice = await dialog.showMessageBox(win, {
					type: 'info',
					message: english ? 'Pi Desktop is still running tasks' : 'Pi Desktop 仍有任务在运行',
					detail: english ? 'It keeps running from the tray.' : '窗口将最小化到托盘，任务继续在后台运行。',
					buttons: [english ? 'Minimize to tray' : '最小化到托盘', english ? 'Quit anyway' : '仍要退出'],
					...rememberChoice,
					defaultId: 0,
					cancelId: 0,
				});
				if (choice.response === 1) {
					if (choice.checkboxChecked) await ipc?.saveCloseChoice('quit');
					app.quit();
				} else {
					if (choice.checkboxChecked) await ipc?.saveCloseChoice('tray');
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
		if (process.platform !== 'win32' && launch.windowMode === 'full' || readyToQuit) return;
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
		// The boot window may have been dragged since the main window was
		// created; take its current position so the swap happens in place.
		const mirror = options.mirror;
		if (mirror && !mirror.isDestroyed() && !mirror.isMaximized() && !win.isMaximized()) {
			const bounds = mirror.getBounds();
			win.setPosition(bounds.x, bounds.y);
		}
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
		? win.loadURL(process.env.ELECTRON_RENDERER_URL)
		: win.loadFile(join(here, '../renderer/index.html'));
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
		const workspace = module.defaultWorkspace();
		// A workspace that already exists — notably a Windows drive root such as
		// D:\ — must not be passed to mkdirSync: recursive mkdir still fails with
		// EPERM on drive roots. Only create the directory when it is missing.
		if (!statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) mkdirSync(workspace, { recursive: true });
		updateService?.setBeforeInstall(async () => {
			if (ipc) await ipc.disposeServices();
			readyToQuit = true;
		});
		updateService?.start();
		// Open the main window where the boot window is right now — the saved
		// placement plus any drag made while the app was still loading — and
		// keep following the boot window's position until the reveal.
		const mainWindow = createWindow({
			state: windowStateFromWindow(splash),
			mirror: splash,
			onReady: () => {
				mainRevealed = true;
				if (!splash.isDestroyed()) splash.close();
				if (pendingOpenSettings) {
					pendingOpenSettings = false;
					module.sendAppCommand({ type: 'open-settings' });
				}
			},
			onLoadError: (error) => showStartupError(splash, error),
		});
		// Load the UI and Pi history concurrently, keeping the logo until React
		// acknowledges a committed conversation (or a required extension dialog).
		// Extra instances start fresh so they never reopen a transcript in use;
		// a hosted pai window (below) resumes its own conversation.
		void module.agentService.init({ cwd: workspace, ...(launch.windowMode !== 'full' ? { fresh: true } : {}) }).catch((error: unknown) => {
			recordDiagnostic({ stage: 'startup', action: 'agent-init', outcome: 'failure' });
			console.error('Pi agent failed to initialize:', error);
			if (startupCancelled || mainRevealed) return;
			mainWindow.destroy();
			showStartupError(splash, error);
		});
		// A cold `pai` launch booted the main instance; open its window now that
		// IPC, the tray and the main window's agent are on their way.
		if (pendingPaiLaunch) {
			const request = pendingPaiLaunch;
			pendingPaiLaunch = null;
			module.openPaiWindow(request);
		}
	} catch (error) {
		if (!startupCancelled) showStartupError(splash, error);
		recordDiagnostic({ stage: 'startup', action: 'bootstrap', outcome: 'failure' });
	}
}

// Full launches and cold `pai` launches share userData, so they compete for
// the same app singleton; --multi keeps its isolated profile and skips it.
const hasSingleInstanceLock = launch.windowMode !== 'full' || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
	// This process was spawned as `pai` while the main app is already running;
	// its request is handed to the holder through the second-instance event.
	app.quit();
} else {
	app.on('second-instance', (_event, commandLine) => {
		openPaiHandoff(commandLine);
	});

	void app.whenReady().then(() => {
		initializeDiagnostics(join(app.getPath('userData'), 'diagnostics'));
		recordDiagnostic({ stage: 'startup', action: 'app-ready', outcome: 'success' });
		// Fast path for the `pai` command: the running instance serves pipe
		// requests without starting another Electron process.
		if (process.platform === 'win32' && launch.windowMode === 'full') {
			startPaiPipeServer({
				pipeName: paiPipeName(userInfo().username || process.env.USERNAME || 'user'),
				handle: async (request) => { (await import('./ipc')).openPaiWindow(request); },
			});
		}
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
	// A ZCode-style boot window: the same size and shell as the real window,
	// with the main window's background color so the swap is invisible. It
	// opens at the main window's saved placement (centered on first run) so
	// the finished window appears exactly where loading started.
	const startupState = resolveStartupWindowState(windowStatePath(app.getPath('userData')));
	const splash = new BrowserWindow({
		width: startupState.bounds.width,
		height: startupState.bounds.height,
		x: startupState.bounds.x,
		y: startupState.bounds.y,
		resizable: false,
		maximizable: false,
		minimizable: true,
		frame: process.platform !== 'win32',
		autoHideMenuBar: process.platform === 'win32',
		show: false,
		hasShadow: true,
		backgroundColor: '#111216',
		title: 'Pi Desktop',
		webPreferences: {
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
		},
	});
	if (startupState.maximized) splash.maximize();
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
	void splash.loadURL(splashUrl(createBootHtml(getAppLocale())))
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
		if (BrowserWindow.getAllWindows().length === 0 && ipc) {
			createWindow({ state: resolveStartupWindowState(windowStatePath(app.getPath('userData'))) });
		}
	});
	});
}

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin' || launch.windowMode !== 'full') app.quit();
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
