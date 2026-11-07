/**
 * Split panes: WebContentsView-hosted chat panes embedded in the main window.
 *
 * Each pane is a fully isolated renderer (own agent service via the pai slot
 * infrastructure, own cwd, own trust state) attached to its parent window's
 * contentView and positioned by the main renderer's reported region rect.
 * Cross-project panes are supported by design: the pane's cwd travels with its
 * own agent host, never touching the main window's workspace.
 */
import { app, BrowserWindow, dialog, WebContentsView, type WebContents } from 'electron';
import { join } from 'node:path';
import { IPC_CHANNELS, type AgentEventEnvelope, type UiExtensionDialogRequest, type UiExtensionDialogResponse } from '@pidesktop/shared';
import { getAppLocale } from './appLocale';
import { rendererLaunchUrl, validatePaiSession, validatePaiWorkspace } from './desktopLaunch';
import { createIsolatedAgentService } from './agentClient';
import { paneHeldSessionPaths, paneSlotForSender, paneSlots, registerPaneSlot, unregisterPaneSlot, type PaiPaneSlot } from './paneRegistry';

interface PaneExtensionDialog {
	request: UiExtensionDialogRequest;
	resolve(value: UiExtensionDialogResponse): void;
	cleanup(): void;
}

const panePendingDialogs = new Map<string, PaneExtensionDialog>();
const paneStartupNotices = new Map<WebContents, UiExtensionDialogRequest[]>();
const paneNotificationReady = new WeakSet<WebContents>();
const pendingUnreadPaths = new Set<string>();
const parentWindowsWatched = new WeakSet<BrowserWindow>();

let hooks: {
	updateKeepAwakeBusy(): void;
	isAutomationRunning(cwd: string, path: string): boolean;
	markBackgroundActivity(path: string): void;
	isHeldElsewhere(path: string): boolean;
} | null = null;

/** Called from ipc.ts once: injects the main-process collaborators so this
 * module stays free of ipc.ts imports (no cycles). */
export function initSplitPanes(collaborators: {
	updateKeepAwakeBusy(): void;
	isAutomationRunning(cwd: string, path: string): boolean;
	markBackgroundActivity(path: string): void;
	/** True when a pai window already owns the session (a second host must not open it). */
	isHeldElsewhere(path: string): boolean;
}): void {
	hooks = collaborators;
}

function paneErrorDialog(parentWin: BrowserWindow | undefined, message: string): void {
	const options = {
		type: 'error' as const,
		title: 'pane',
		message,
		buttons: [getAppLocale() === 'en-US' ? 'Close' : '关闭'],
	};
	const shown = parentWin && !parentWin.isDestroyed() ? dialog.showMessageBox(parentWin, options) : dialog.showMessageBox(options);
	void shown.catch(() => {});
}

let nextPaneId = 1;

export function openSplitPane(parentWin: BrowserWindow, request: { cwd: string; sessionPath?: string; background?: string }): number {
	const cwd = validatePaiWorkspace(request.cwd);
	const sessionPath = request.sessionPath === undefined ? undefined : validatePaiSession(request.sessionPath);
	if (sessionPath && hooks?.isAutomationRunning(cwd, sessionPath)) throw new Error('自动化仍在运行，请结束后再打开窗格');
	// 同一会话已在某窗格 → 不重复创建，聚焦已有窗格并返回其 id（多窗格下
	// 重复点是「回到那个窗格」，不是错误）。
	if (sessionPath) {
		const existing = paneSlots().find((slot) => slot.sessionPath === sessionPath || slot.liveSessionPath === sessionPath);
		if (existing) {
			if (!existing.parentWin.isDestroyed() && !existing.webContents.isDestroyed()) {
				existing.parentWin.focus();
				existing.webContents.focus();
			}
			return existing.paneId;
		}
		if (hooks?.isHeldElsewhere(sessionPath)) throw new Error('会话已在 pai 小窗中打开，请先关闭该小窗');
	}
	const view = new WebContentsView({
		webPreferences: {
			preload: join(app.getAppPath(), 'out', 'preload', 'index.mjs'),
			backgroundThrottling: false,
			contextIsolation: true,
			sandbox: false,
			nodeIntegration: false,
		},
	});
	view.setBackgroundColor(request.background ?? '#111216');
	// 创建即给非零 bounds：0 尺寸 view 在 Electron 44 下页面加载事件会被冻结
	// （loadURL 永不 settle）。先按「右侧均分」估算落位，主窗占位区上报真实
	// rect 后立即覆盖（renderer 拿到 paneId 后才渲染占位区）。
	view.setBounds(estimatedPaneBounds(parentWin, paneIdsFor(parentWin).length + 1));
	const entry: PaiPaneSlot = {
		paneId: nextPaneId++,
		view, parentWin,
		webContents: view.webContents,
		cwd,
		...(sessionPath ? { sessionPath } : {}),
		agent: null!,
		liveSessionPath: null,
		busy: false,
		loaded: false,
		firstPaintReady: false,
		rendererReady: false,
		revealed: false,
		closing: false,
		disposed: false,
	};
	entry.agent = createIsolatedAgentService({
		requestProjectTrust: (target) => requestPaneProjectTrust(entry, target),
		requestExtensionDialog: (dialogRequest, signal) => requestPaneExtensionDialog(entry, dialogRequest, signal),
		onHostCrash: () => {
			setTimeout(() => void recoverPaneAgent(entry), 250);
		},
	});
	registerPaneSlot(entry);
	// Attach immediately: an unattached WebContentsView does not advance page
	// loads in Electron 44.
	parentWin.contentView.addChildView(view);
	watchParentWindow(parentWin);
	let failureReported = false;
	const reportFailure = (reason: string): void => {
		if (failureReported || entry.disposed) return;
		failureReported = true;
		console.error('split pane renderer failed:', reason);
		paneErrorDialog(parentWin, reason);
		void closeSplitPane(entry, { skipConfirm: true });
	};
	entry.webContents.on('render-process-gone', (_event, details) => {
		if (details.reason !== 'clean-exit') reportFailure(details.reason);
	});
	entry.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
		if (isMainFrame && code !== -3) reportFailure(description);
	});
	entry.webContents.setWindowOpenHandler(({ url }) => {
		try {
			const parsed = new URL(url);
			if (parsed.protocol === 'https:' || parsed.protocol === 'http:') void import('electron').then(({ shell }) => shell.openExternal(parsed.toString()));
		} catch { /* Ignore malformed links from generated content. */ }
		return { action: 'deny' };
	});
	entry.agent.onEvent((envelope: AgentEventEnvelope) => {
		const event = envelope.event;
		if (event.type === 'ready') entry.liveSessionPath = event.sessionPath;
		if (event.type === 'status') {
			entry.busy = event.status === 'busy';
			hooks?.updateKeepAwakeBusy();
		}
		if (entry.webContents.isDestroyed()) return;
		entry.webContents.send(IPC_CHANNELS.agentEvent, envelope);
	});
	entry.agent.onBackgroundActivity((_paneCwd, path) => {
		if (entry.liveSessionPath === path || pendingUnreadPaths.has(path)) return;
		pendingUnreadPaths.add(path);
		hooks?.markBackgroundActivity(path);
		pendingUnreadPaths.delete(path);
	});
	// The pane renderer bootstraps from a snapshot, so loading starts only after
	// the agent can serve a real one (same ordering as pai windows).
	const startLoad = (): void => {
		if (entry.disposed) return;
		const load = !app.isPackaged && process.env.ELECTRON_RENDERER_URL
			? view.webContents.loadURL(rendererLaunchUrl(process.env.ELECTRON_RENDERER_URL, { windowMode: 'pane', cwd }))
			: view.webContents.loadFile(join(app.getAppPath(), 'out', 'renderer', 'index.html'), { query: { mode: 'pane' } });
		void load.then(() => {
			entry.loaded = true;
			revealPane(entry);
		}).catch((error: unknown) => reportFailure(error instanceof Error ? error.message : String(error)));
	};
	void entry.agent.init({ cwd, ...(sessionPath ? { sessionPath } : { fresh: true }) })
		.then(() => { startLoad(); })
		.catch((error: unknown) => {
			console.error('split pane agent failed to initialize:', error);
			paneErrorDialog(parentWin, error instanceof Error ? error.message : String(error));
			void closeSplitPane(entry, { skipConfirm: true });
		});
	return entry.paneId;
}


/** Pre-report placement: the right half of the window, split evenly. The main
 * renderer's region report replaces it as soon as the pane id reaches it. */
function estimatedPaneBounds(parentWin: BrowserWindow, count: number): { x: number; y: number; width: number; height: number } {
	const content = parentWin.contentView.getBounds();
	const columnWidth = Math.max(280, Math.floor(content.width * 0.5 / Math.max(1, count)));
	return { x: Math.max(0, content.width - columnWidth), y: 0, width: columnWidth, height: Math.max(1, content.height) };
}

/** Panes live and die with their parent window. */
function watchParentWindow(parentWin: BrowserWindow): void {
	if (parentWindowsWatched.has(parentWin)) return;
	parentWindowsWatched.add(parentWin);
	parentWin.once('closed', () => {
		for (const entry of paneSlots().filter((slot) => slot.parentWin === parentWin)) {
			entry.closing = true;
			unregisterPaneSlot(entry.webContents);
			void disposePaneEntry(entry).finally(() => {
				try { if (!entry.webContents.isDestroyed()) entry.webContents.close(); } catch { /* Already gone. */ }
			});
		}
	});
}

function revealPane(entry: PaiPaneSlot): void {
	if (entry.revealed || !entry.loaded || !entry.firstPaintReady || !entry.rendererReady) return;
	if (!entry.parentWin.isDestroyed() && !entry.webContents.isDestroyed()) {
		// Loaded and painted: from here on the pane may throttle like any
		// background page while it is hidden.
		entry.revealed = true;
		entry.webContents.setBackgroundThrottling(true);
	}
}

export function paneIdForWebContents(webContents: WebContents): number | null {
	return paneSlotForSender(webContents)?.paneId ?? null;
}

export function notifyPaneRendererReady(webContents: WebContents): void {
	const entry = paneSlotForSender(webContents);
	if (!entry || entry.disposed) return;
	entry.rendererReady = true;
	entry.firstPaintReady = true;
	revealPane(entry);
	flushPaneNotices(entry);
}

/**
 * Position/resize one pane by id from the main renderer's reported region (DIP,
 * viewport-relative). An empty rect hides the pane: the native view sits above
 * all page content, so the main window hides its panes while a dialog, overlay
 * or non-chat page would otherwise end up underneath them.
 */
export function setPaneBounds(parentWin: BrowserWindow, paneId: number, rect: { x: number; y: number; width: number; height: number }): void {
	const entry = paneById(parentWin, paneId);
	if (!entry || entry.webContents.isDestroyed()) return;
	const visible = rect.width >= 1 && rect.height >= 1;
	entry.view.setVisible(visible);
	if (!visible) return;
	entry.view.setBounds({
		x: Math.max(0, Math.round(rect.x)),
		y: Math.max(0, Math.round(rect.y)),
		width: Math.max(0, Math.round(rect.width)),
		height: Math.max(0, Math.round(rect.height)),
	});
}

export function paneById(parentWin: BrowserWindow, paneId: number): PaiPaneSlot | undefined {
	return paneSlots().find((slot) => slot.paneId === paneId && slot.parentWin === parentWin && !slot.disposed);
}

/** Open pane ids of a window, oldest first (a reloaded main renderer resyncs from it). */
export function paneIdsFor(parentWin: BrowserWindow): number[] {
	return paneSlots().filter((slot) => slot.parentWin === parentWin && !slot.disposed && !slot.closing).map((slot) => slot.paneId);
}

export async function closeSplitPane(entry: PaiPaneSlot, options?: { skipConfirm?: boolean }): Promise<void> {
	if (entry.closing || entry.disposed) return;
	if (!options?.skipConfirm && entry.busy) {
		const english = getAppLocale() === 'en-US';
		const { response } = await dialog.showMessageBox(entry.parentWin, {
			type: 'warning',
			message: english ? 'Tasks are still running' : '仍有任务在运行',
			detail: english ? 'Closing this pane interrupts its conversation.' : '关闭窗格会中断其中正在运行的会话。',
			buttons: [english ? 'Cancel' : '取消', english ? 'Close' : '关闭'],
			defaultId: 0,
			cancelId: 0,
			noLink: true,
		});
		if (response !== 1) return;
	}
	entry.closing = true;
	try {
		if (!entry.parentWin.isDestroyed() && entry.parentWin.contentView.children.includes(entry.view)) {
			entry.parentWin.contentView.removeChildView(entry.view);
		}
	} catch { /* The parent may already be gone. */ }
	unregisterPaneSlot(entry.webContents);
	if (!entry.parentWin.isDestroyed() && !entry.parentWin.webContents.isDestroyed()) {
		entry.parentWin.webContents.send(IPC_CHANNELS.splitPaneClosed, entry.paneId);
	}
	await disposePaneEntry(entry);
	try { if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close(); } catch { /* Already gone. */ }
}

async function disposePaneEntry(entry: PaiPaneSlot): Promise<void> {
	if (entry.disposed) return;
	entry.disposed = true;
	try { await entry.agent.dispose(); }
	catch (error) { console.error('split pane agent disposal failed:', error); }
	hooks?.updateKeepAwakeBusy();
}

export async function disposeAllPanes(): Promise<void> {
	await Promise.allSettled(paneSlots().map((entry) => disposePaneEntry(entry)));
}

async function recoverPaneAgent(entry: PaiPaneSlot): Promise<void> {
	if (entry.disposed || entry.webContents.isDestroyed()) return;
	const held = new Set(paneHeldSessionPaths());
	held.delete(entry.liveSessionPath ?? '');
	const excludeSessionPaths = [...held];
	try {
		if (entry.liveSessionPath) await entry.agent.init({ cwd: entry.cwd, sessionPath: entry.liveSessionPath, excludeSessionPaths });
		else await entry.agent.init({ cwd: entry.cwd, fresh: true });
	} catch (error) {
		console.error('split pane agent recovery failed:', error);
	}
}

function requestPaneProjectTrust(entry: PaiPaneSlot, cwd: string): Promise<{ trusted: boolean; remember: boolean }> {
	const english = getAppLocale() === 'en-US';
	const options = {
		type: 'warning',
		buttons: english ? ['Open without trusting', 'Trust this time', 'Always trust'] : ['不信任，继续打开', '仅本次信任', '始终信任'],
		defaultId: 0,
		cancelId: 0,
		noLink: true,
		title: english ? 'Trust workspace' : '信任工作区',
		message: english ? 'Do you trust this workspace?' : '是否信任此工作区？',
		detail: english
			? `${cwd}\n\nTrusting lets Pi load project settings, skills, and extensions, which may run local code. You can still open the folder without trust; those project resources will be skipped.`
			: `${cwd}\n\n信任后，Pi 可以加载此文件夹中的设置、技能和扩展；扩展可能执行本机代码。不信任仍可打开文件夹，但会跳过这些项目资源。`,
	} as const;
	const shown = entry.parentWin.isDestroyed() ? dialog.showMessageBox(options) : dialog.showMessageBox(entry.parentWin, options);
	return shown.then(({ response }) => ({ trusted: response !== 0, remember: response === 2 }));
}

function requestPaneExtensionDialog(entry: PaiPaneSlot, request: UiExtensionDialogRequest, signal?: AbortSignal): Promise<UiExtensionDialogResponse> {
	if (entry.disposed || entry.webContents.isDestroyed()) return Promise.resolve(null);
	if (request.kind === 'notify') {
		if (paneNotificationReady.has(entry.webContents)) entry.webContents.send(IPC_CHANNELS.agentExtensionDialog, request);
		else {
			const queue = paneStartupNotices.get(entry.webContents) ?? [];
			queue.push(request);
			if (queue.length > 32) queue.shift();
			paneStartupNotices.set(entry.webContents, queue);
		}
		return Promise.resolve(null);
	}
	return extensionDialogForPane(entry, request, signal);
}

/** WebContents variant of ipc.ts's extensionDialogFor: the dialog request and
 * its response both belong to the pane's own renderer. */
function extensionDialogForPane(entry: PaiPaneSlot, request: UiExtensionDialogRequest, signal?: AbortSignal): Promise<UiExtensionDialogResponse> {
	if (entry.disposed || entry.webContents.isDestroyed()) return Promise.resolve(null);
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (value: UiExtensionDialogResponse): void => {
			if (!panePendingDialogs.has(request.id)) return;
			panePendingDialogs.delete(request.id);
			cleanup();
			if (!entry.webContents.isDestroyed()) entry.webContents.send(IPC_CHANNELS.agentExtensionDialogClosed, request.id);
			resolve(value);
		};
		const onAbort = (): void => finish(null);
		const onGone = (): void => finish(null);
		const cleanup = (): void => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			entry.webContents.removeListener('destroyed', onGone);
		};
		panePendingDialogs.set(request.id, { request, resolve: finish, cleanup });
		if (signal?.aborted) { finish(null); return; }
		signal?.addEventListener('abort', onAbort, { once: true });
		entry.webContents.once('destroyed', onGone);
		if (request.timeout && request.timeout > 0) timer = setTimeout(() => finish(null), request.timeout);
		entry.webContents.send(IPC_CHANNELS.agentExtensionDialog, request);
	});
}

function flushPaneNotices(entry: PaiPaneSlot): void {
	paneNotificationReady.add(entry.webContents);
	const queue = paneStartupNotices.get(entry.webContents);
	if (!queue?.length) return;
	paneStartupNotices.delete(entry.webContents);
	for (const request of queue) {
		if (!entry.webContents.isDestroyed()) entry.webContents.send(IPC_CHANNELS.agentExtensionDialog, request);
	}
}

export function panePendingDialogRequests(sender: WebContents): UiExtensionDialogRequest[] {
	const entry = paneSlotForSender(sender);
	if (!entry) return [];
	return [...panePendingDialogs.values()].map(({ request }) => request);
}

export function resolvePanePendingDialog(id: string, value: unknown): boolean {
	const pending = panePendingDialogs.get(id);
	if (!pending) return false;
	pending.resolve((value ?? null) as UiExtensionDialogResponse);
	return true;
}
