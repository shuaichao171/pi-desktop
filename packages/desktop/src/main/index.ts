import { app, BrowserWindow, dialog, Menu, session, shell } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPC_CHANNELS } from '@pidesktop/shared';
import { getAppLocale } from './appLocale';
import { createSplashErrorHtml, createSplashHtml } from './splash';

const here = fileURLToPath(new URL('.', import.meta.url));
let ipc: typeof import('./ipc') | null = null;
let updateService: typeof import('./updateService').updateService | null = null;
let mainRevealed = false;
let startupCancelled = false;

function splashUrl(html: string): string {
	return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function showStartupError(splash: BrowserWindow, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	const english = getAppLocale() === 'en-US';
	console.error('Pi Desktop failed to start:', error);
	if (splash.isDestroyed()) {
		dialog.showErrorBox(english ? 'Pi Desktop startup failed' : 'Pi Desktop 启动失败', message);
		app.quit();
		return;
	}
	if (!splash.isVisible()) splash.show();
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
		width: 1280,
		height: 820,
		minWidth: 680,
		minHeight: 520,
		backgroundColor: '#111216',
		title: 'Pi Desktop',
		// Match ZCode's Windows chrome: the renderer draws the title bar and controls.
		// Keep the native title bar on macOS and Linux.
		frame: process.platform !== 'win32',
		autoHideMenuBar: process.platform === 'win32',
		show: false,
		webPreferences: {
			preload: join(here, '../preload/index.mjs'),
			contextIsolation: true,
			// ESM preload requires sandbox: false (Electron ≥ 28). Keep the
			// context-isolated bridge narrow; the preload itself has Node access.
			sandbox: false,
			nodeIntegration: false,
		},
	});
	const publishChromeState = (): void => {
		if (win.webContents.isDestroyed()) return;
		win.webContents.send(IPC_CHANNELS.windowChromeStateChanged, { isMaximized: win.isMaximized() });
	};
	win.on('maximize', publishChromeState);
	win.on('unmaximize', publishChromeState);

	let loaded = false;
	let firstPaintReady = false;
	let revealed = false;
	let startupFailureReported = false;
	let recoveryDialogVisible = false;
	let unresponsiveTimer: ReturnType<typeof setTimeout> | null = null;
	const reportStartupFailure = (error: unknown): void => {
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
			else win.close();
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
	win.on('closed', () => { if (unresponsiveTimer) clearTimeout(unresponsiveTimer); });
	const reveal = (): void => {
		if (!loaded || !firstPaintReady || revealed || win.isDestroyed()) return;
		revealed = true;
		win.show();
		onReady?.();
	};
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
		// Loading Pi's SDK is the slow part. Import it after the splash has painted.
		const module = await import('./ipc');
		if (startupCancelled || splash.isDestroyed()) return;
		ipc = module;
		updateService = module.updateService;
		module.registerIpc();
		createWindow(() => {
			mainRevealed = true;
			if (!splash.isDestroyed()) splash.close();
			module.updateService.setBeforeInstall(async () => {
				if (ipc) await ipc.disposeServices().catch((error: unknown) => console.error('Pi Desktop shutdown before update failed:', error));
				readyToQuit = true;
			});
			module.updateService.start();
			// Let the visible main window reach the screen before initializing the agent.
			setTimeout(() => {
				try {
					const workspace = module.defaultWorkspace();
					mkdirSync(workspace, { recursive: true });
					void module.agentService.init({ cwd: workspace }).catch((error: unknown) => {
						console.error('Pi agent failed to initialize:', error);
					});
				} catch (error) {
					console.error('Pi workspace failed to initialize:', error);
				}
			}, 120);
		}, (error) => showStartupError(splash, error));
	} catch (error) {
		if (!startupCancelled) showStartupError(splash, error);
	}
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
	app.quit();
} else {
	app.on('second-instance', () => {
		const windows = BrowserWindow.getAllWindows();
		const target = windows.find((window) => window.isVisible()) ?? windows.find((window) => window.isMinimized());
		if (!target || target.isDestroyed()) return;
		if (target.isMinimized()) target.restore();
		target.show();
		target.focus();
	});

	void app.whenReady().then(() => {
	if (process.platform === 'win32') {
		app.setAppUserModelId('dev.pidesktop.app');
		Menu.setApplicationMenu(null);
	}
	// The renderer only needs clipboard write for its explicit copy action.
	session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
		callback(permission === 'clipboard-sanitized-write');
	});
	const splash = new BrowserWindow({
		width: 420,
		height: 300,
		resizable: false,
		maximizable: false,
		minimizable: false,
		frame: false,
		center: true,
		show: false,
		backgroundColor: '#111216',
		title: getAppLocale() === 'en-US' ? 'Pi Desktop is starting' : 'Pi Desktop 正在启动',
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
	if (process.platform !== 'darwin') app.quit();
});

let readyToQuit = false;
let disposing = false;
app.on('before-quit', (event) => {
	updateService?.stop();
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
