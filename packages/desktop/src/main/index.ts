import { initializeDiagnostics, recordDiagnostic } from './diagnostics.ts';
import { userInfo } from 'node:os';
import { app, BrowserWindow, dialog, Menu, nativeImage, nativeTheme, session } from 'electron';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPC_CHANNELS } from '@pidesktop/shared';
import { getAppLocale } from './appLocale';
import { appearanceStatePath, readAppearanceState, readAppearanceStateAsync } from './appearance.ts';
import { createBootErrorHtml, createBootHtml } from './splash';
import { showEditContextMenu } from './editContextMenu.ts';
import { appIconPath, createAppTray, destroyAppTray } from './tray';
import { guardExternalNavigation } from './externalLinks.ts';
import { paiPipeName, startPaiPipeServer } from './paiPipe.ts';
import { isHeadlessPiInvocation, parseDesktopLaunch, reservePaiProfile, validatePaiSession, validatePaiWorkspace, type DesktopLaunch, type PaiProfile } from './desktopLaunch.ts';
import { createStartupMetrics } from './startupMetrics.ts';
import { readBuiltinEngineInfo } from './piEngine.ts';
import { swapSplashForMainWindow } from './startupSwap.ts';
import { resolveWindowTheme } from './windowTheme.ts';
import {
	MAIN_WINDOW_MIN_HEIGHT,
	MAIN_WINDOW_MIN_WIDTH,
	readWindowStateAsync,
	resolveStartupWindowState,
	trackWindowState,
	windowStateFromWindow,
	windowStatePath,
	type WindowState,
} from './windowState';

/**
 * Pi extensions spawn background children with `process.execPath`, expecting the
 * host to be a plain Node runtime. Inside Electron that path is the app
 * executable, so such a call would start a whole second application: it cannot
 * take the singleton lock, Electron forwards it to `second-instance`, and the
 * window surfaces. Handle those invocations with Node semantics before any lock
 * or window exists.
 */
if (isHeadlessPiInvocation(process.argv)) {
	const engine = readBuiltinEngineInfo();
	const cli = engine === null ? null : join(engine.dir, 'dist', 'bundle', 'cli.js');
	if (cli === null || !existsSync(cli)) {
		process.stderr.write('Pi Desktop: bundled pi CLI is unavailable\n');
		process.exit(1);
	}
	// ELECTRON_RUN_AS_NODE is read when the process starts, so re-enter once;
	// stdio passes the caller's pipes through unchanged.
	const result = spawnSync(process.execPath, [cli, ...process.argv.slice(1)], {
		stdio: 'inherit',
		env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
	});
	if (result.error) process.stderr.write(`Pi Desktop: headless relaunch failed: ${String(result.error)}\n`);
	process.exit(result.status ?? 1);
}

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
let startupErrorShown = false;
const pendingWindowReveals = new WeakMap<BrowserWindow, () => void>();
const rendererWindows = new Set<BrowserWindow>();

// Cold-start phases (audit P2): one structured diagnostics event per phase, plus
// a single human-readable summary line in dev builds or with PI_STARTUP_LOG=1.
const startupMetrics = createStartupMetrics({
	now: () => performance.now(),
	enabled: process.env.PI_STARTUP_LOG === '1' || !app.isPackaged,
	logger: (...args) => console.log(...args),
	record: (record) => recordDiagnostic({ stage: 'startup', action: `boot-${record.phase}`, outcome: record.outcome, durationMs: record.atMs }),
});
startupMetrics.mark('main-start');

// Cold-start prefetch (audit P2): the boot window needs the saved placement and
// the appearance before it can be built. Read both now, concurrently and off the
// main thread's critical path, so they overlap Electron's own ready wait instead
// of running as sync reads after it. Display geometry needs `ready`, so only
// the raw saved state is prefetched; both readers fall back to null exactly
// like their sync twins.
const startupStatePrefetch = Promise.all([
	readWindowStateAsync(windowStatePath(app.getPath('userData'))),
	readAppearanceStateAsync(appearanceStatePath(baseUserData ?? app.getPath('userData'))),
]);

/** The colors the boot window, the main window and the pai windows share (splash theming). */
function currentWindowTheme(): ReturnType<typeof resolveWindowTheme> {
	return resolveWindowTheme(readAppearanceState(appearanceStatePath(baseUserData ?? app.getPath('userData'))), nativeTheme.shouldUseDarkColors);
}

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
	// Extensions relaunch this executable with pi's headless flags to spawn
	// background children (for example pi-magic-context's historian). That is
	// not a user-initiated start and must never surface the window.
	if (isHeadlessPiInvocation(commandLine)) return;
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
	// One startup error at a time: a workspace failure keeps the renderer branch
	// loading, and its own load failure must not stack a second error dialog.
	if (startupErrorShown) return;
	startupErrorShown = true;
	startupCancelled = true;
	startupMetrics.abort();
	const message = error instanceof Error ? error.message : String(error);
	const english = getAppLocale() === 'en-US';
	console.error('Pi Desktop failed to start:', error);
	if (splash.isDestroyed()) {
		dialog.showErrorBox(english ? 'Pi Desktop startup failed' : 'Pi Desktop 启动失败', message);
		app.quit();
		return;
	}
	if (!splash.isVisible()) splash.show();
	// The error page shares the boot page's background and palette, so the
	// swap between them shows no color flash.
	void splash.loadURL(splashUrl(createBootErrorHtml(message, getAppLocale(), currentWindowTheme())))
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
		// Same source as the boot window and the renderer's theme surface, so the
		// splash→main swap never changes color (splash theming).
		backgroundColor: currentWindowTheme().background,
		title: 'Pi Desktop',
		// Deterministic taskbar/alt-tab icon in dev (electron.exe would show the
		// Electron default) and packaged alike; same ico the tray uses.
		icon: nativeImage.createFromPath(appIconPath()),
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
	startupMetrics.mark('window-created');
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
		// The reveal is the first user-visible frame of the app itself.
		startupMetrics.mark('first-frame');
		startupMetrics.finish();
		onReady?.();
	};
	pendingWindowReveals.set(win, () => {
		rendererReady = true;
		startupMetrics.mark('renderer-ready');
		reveal();
	});
	win.once('ready-to-show', () => {
		firstPaintReady = true;
		startupMetrics.mark('ready-to-show');
		reveal();
	});
	// Links in transcripts open in the system browser instead of navigating this window.
	guardExternalNavigation(win.webContents);
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
		startupMetrics.mark('renderer-loaded');
		reveal();
	}).catch(reportStartupFailure);
	return win;
}

/**
 * Startup workspace branch (audit P2): the workspace's state IO runs off the
 * main thread and concurrently with the renderer load — the main window does
 * not depend on it, only the agent boot does.
 */
async function resolveStartupWorkspace(module: typeof import('./ipc')): Promise<string> {
	const workspace = await module.defaultWorkspaceAsync();
	// A workspace that already exists — notably a Windows drive root such as
	// D:\ — must not be passed to mkdir: recursive mkdir still fails with
	// EPERM on drive roots. Only create the directory when it is missing.
	if (!(await stat(workspace).catch((error: NodeJS.ErrnoException) => { if (error?.code === 'ENOENT') return null; throw error; }))?.isDirectory()) await mkdir(workspace, { recursive: true });
	return workspace;
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
		startupMetrics.mark('ipc-ready');
		// Open the main window where the boot window is right now — the saved
		// placement plus any drag made while the app was still loading — and
		// keep following the boot window's position until the reveal. Its
		// renderer load starts immediately and runs in parallel with the
		// workspace branch below (the two share no state; audit P2).
		const mainWindow = createWindow({
			state: windowStateFromWindow(splash),
			mirror: splash,
			onReady: () => {
				mainRevealed = true;
				// Same-frame swap: the boot window closes only after this window's
				// show has been processed, never before a frame is on screen.
				swapSplashForMainWindow(mainWindow, splash);
				if (pendingOpenSettings) {
					pendingOpenSettings = false;
					module.sendAppCommand({ type: 'open-settings' });
				}
			},
			onLoadError: (error) => showStartupError(splash, error),
		});
		updateService?.setBeforeInstall(async () => {
			if (ipc) await ipc.disposeServices();
			readyToQuit = true;
		});
		// A non-first-screen item: the first network check is delayed inside the
		// update service itself, so it never competes with the startup path.
		updateService?.start();
		void resolveStartupWorkspace(module)
			.then((workspace) => {
				// The renderer branch may have failed (or the user closed the boot
				// window) while the workspace resolved: don't fork an agent host into
				// a startup that is already unwinding.
				if (startupCancelled || splash.isDestroyed()) return;
				startupMetrics.mark('workspace-ready');
				// Load the UI and Pi history concurrently, keeping the logo until React
				// acknowledges a committed conversation (or a required extension dialog).
				// Extra instances start fresh so they never reopen a transcript in use;
				// a hosted pai window (below) resumes its own conversation.
				return module.agentService.init({ cwd: workspace, ...(launch.windowMode !== 'full' ? { fresh: true } : {}) }).catch((error: unknown) => {
					recordDiagnostic({ stage: 'startup', action: 'agent-init', outcome: 'failure' });
					console.error('Pi agent failed to initialize:', error);
					if (startupCancelled || mainRevealed) return;
					mainWindow.destroy();
					showStartupError(splash, error);
				});
			})
			.catch((error: unknown) => {
				// The renderer branch keeps loading; the boot error page takes over
				// exactly as before, once, for the failed workspace.
				recordDiagnostic({ stage: 'startup', action: 'workspace-init', outcome: 'failure' });
				if (!startupCancelled) showStartupError(splash, error);
			});
		// A cold `pai` launch booted the main instance; open its window now that
		// IPC, the tray and the main window's agent are on their way.
		if (pendingPaiLaunch) {
			const request = pendingPaiLaunch;
			pendingPaiLaunch = null;
			try {
				module.openPaiWindow(request);
			} catch (error) {
				// A cold pai launch validates its workspace directory; one removed during
				// the boot gap is a pai-only failure — same handling as the handoff path,
				// it must not take down the main instance.
				showPaiError(error);
			}
		}
	} catch (error) {
		if (!startupCancelled) showStartupError(splash, error);
		recordDiagnostic({ stage: 'startup', action: 'bootstrap', outcome: 'failure' });
	}
}

// Full launches and cold `pai` launches share userData, so they compete for
// the same app singleton; --multi keeps its isolated profile and skips it.
// A pai spawn that loses the bid hands its request to the holder via the
// second-instance event instead of booting a second full instance.
const hasSingleInstanceLock = launch.windowMode === 'multi' || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
	// This process was spawned as `pai` while the main app is already running;
	// its request is handed to the holder through the second-instance event.
	app.quit();
} else {
	app.on('second-instance', (_event, commandLine) => {
		openPaiHandoff(commandLine);
	});

	void app.whenReady().then(async () => {
		initializeDiagnostics(join(app.getPath('userData'), 'diagnostics'));
		recordDiagnostic({ stage: 'startup', action: 'app-ready', outcome: 'success' });
		startupMetrics.mark('app-ready');
		// Fast path for the `pai` command: the running instance serves pipe
		// requests without starting another Electron process.
		if (process.platform === 'win32' && launch.windowMode === 'full') {
			startPaiPipeServer({
				pipeName: paiPipeName(userInfo().username || process.env.USERNAME || 'user'),
				handle: async (request) => { (await import('./ipc')).openPaiWindow(request); },
			});
		}
	if (process.platform === 'win32') {
		// AUMI matches the electron-builder appId; the old 'dev.pidesktop.app' was
		// retired because Windows StateRepository had cached its taskbar display
		// name as "Electron" from early dev-era runs and no cache flush refreshes it.
		// Packaged and dev still must differ, or a dev run (electron.exe, "Electron")
		// pollutes the packaged button record again.
		app.setAppUserModelId(app.isPackaged ? 'app.pidesktop.desktop' : 'app.pidesktop.desktop.dev');
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
	const [savedWindowState, savedAppearance] = await startupStatePrefetch;
	startupMetrics.mark('state-read');
	const startupState = resolveStartupWindowState(windowStatePath(app.getPath('userData')), undefined, savedWindowState);
	// One theme for the boot window and its page (one read, not two).
	const bootTheme = resolveWindowTheme(savedAppearance, nativeTheme.shouldUseDarkColors);
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
		// The user's appearance preference decides the boot window's color; the
		// same constant feeds the boot page and the main window (splash theming).
		backgroundColor: bootTheme.background,
		title: 'Pi Desktop',
		icon: nativeImage.createFromPath(appIconPath()),
		webPreferences: {
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
		},
	});
	startupMetrics.mark('splash-created');
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
		startupMetrics.mark('splash-shown');
		// Give the visible splash a few frames before evaluating the heavy Pi import.
		setTimeout(() => {
			if (!startupCancelled && !splash.isDestroyed()) void bootstrap(splash);
		}, 100);
	};
	splash.once('ready-to-show', showAndStart);
	void splash.loadURL(splashUrl(createBootHtml(getAppLocale(), bootTheme)))
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
