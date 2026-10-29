import { MCP_FEATURE_CHANNELS, PLUGIN_UPDATE_CHANNELS } from '@pidesktop/shared';
import { registerCloudSyncIpc } from './cloudSyncIpc';
import { registerDebugApiIpc } from './debugApiIpc';
/**
 * IPC wiring: renderer ⇄ main ⇄ AgentService.
 *
 * Agent events fan out to the requesting renderer window; every renderer→main
 * call is a typed invoke against the contract in @pidesktop/shared. Hosted pai
 */

import { app, BrowserWindow, dialog, shell, type IpcMainInvokeEvent } from 'electron';
import { mkdirSync, statSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { IPC_CHANNELS, PROJECT_BAR_PRESET_IDS, type AgentEventEnvelope, type AppLocale, type UiAppCommand, type UiAttachment, type UiExtensionDialogRequest, type UiInputScope, type UiSessionMetaPatch, type UiSidebarGroupChange, type UiSlashCommandRequest, type UiThinkingLevel } from '@pidesktop/shared';
import { createIsolatedAgentService } from './agentClient';
import { isPaiSender, isPaiWindow, paiHeldSessionPaths, paiSlotForSender, paiWindowSlots, registerPaiWindowSlot, unregisterPaiWindowSlot } from './paiWindows';
import { getAppLocale, setAppLocale } from './appLocale';
import { destroyAppTray, invalidateAppTrayData, updateAppTrayMenu } from './tray';
import { updateService } from './updateService';
export { updateService } from './updateService';
import { registerWorkbenchIpc } from './workbenchIpc';
import type { WorkbenchService } from './workbenchService';
import { backupCorruptStateFile, backupCorruptStateFileAsync, CorruptStateFileError, readStateFile, readStateFileAsync, writeStateFile, writeStateFileAsync } from './stateFiles';
import { SessionGroupService } from './sessionGroups';
import { broadcastToRenderers, handleRendererInvoke, requireRendererSender, setRendererSenderRestriction } from './rendererIpc';
import { normalizeUiDiagnostic } from '@pidesktop/shared';
import { flushDiagnostics, initializeDiagnostics, recordDiagnostic } from './diagnostics';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { normalizeSessionPath, pruneMissingSessionMeta } from './sessionPaths';
import { rendererLaunchUrl, validatePaiSession, validatePaiWorkspace } from './desktopLaunch';
import { prepareWorkspaceDrop } from './workspaceDrop';
import { createProjectCreator } from './projectCreation';
import { createConversationWorkspace, createConversationWorkspaceSync, prepareConversationStorageDirectory } from './conversationStorage';
import { createDesktopNotifier } from './notifications';
import { createKeepAwakeController, type KeepAwakeController } from './keepAwake';
import { readDesktopSettings, writeDesktopSettings, type DesktopSettings } from './desktopSettings';
import { appearanceStatePath, isValidAppearanceState, readAppearanceState, watchAppearanceState, writeAppearanceState } from './appearance';
import { readWorkspaceContext, validateContextRequest } from './contextService';
import { createAutomationService } from './automationService';
import { createAutomationExecutor } from './automationExecutor';
import { probePiEngine, readBuiltinEngineInfo, isValidPiEngineSelection } from './piEngine';
import type { AgentHostEngineOptions } from './agentClient';
import type { UiPiEngineSelection, UiPiEngineStatus } from '@pidesktop/shared';
import { createPluginDiscovery } from './pluginDiscovery';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { registerWorkbenchFeatureIpc } from './workbenchFeatureIpc';
import { registerInputAttachmentIpc } from './inputAttachmentIpc';
import { registerDataFeaturesIpc } from './dataFeaturesIpc';
import { DATA_FEATURE_CHANNELS, INPUT_FEATURE_CHANNELS, WORKBENCH_FEATURE_CHANNELS, MANAGEMENT_FEATURE_CHANNELS, requireInputQueueScope, type UiMachineSessionSummary } from '@pidesktop/shared';
import type { UiPluginMutation, UiPluginResourceKind, UiPluginScope, UiSaveInstructionRequest } from '@pidesktop/shared';
import { requireDialogResponse, type UiExtensionDialogResponse } from '@pidesktop/shared';

type PendingDialog = {
	request: UiExtensionDialogRequest;
	owner: BrowserWindow;
	resolve: (value: UiExtensionDialogResponse) => void;
	cleanup: () => void;
};

const pendingDialogs = new Map<string, PendingDialog>();
type StartupNotifications = {
	requests: UiExtensionDialogRequest[];
	rendererReady: boolean;
	flush(): void;
	cleanup(): void;
};
const startupNotifications = new Map<BrowserWindow, StartupNotifications>();
const notificationReadyWindows = new WeakSet<BrowserWindow>();
const MAX_STARTUP_NOTIFICATIONS = 100;
let getDialogWindow: () => BrowserWindow | undefined = () => undefined;
/** Set by registerIpc: OS notification for approvals/questions while unfocused. */
let notifyInputRequest: ((request: UiExtensionDialogRequest) => void) | null = null;
/** Set by registerIpc: powerSaveBlocker while tasks run and the preference is on. */
let keepAwake: KeepAwakeController | null = null;
let workbenchService: WorkbenchService | null = null;
let workbenchFeatures: ReturnType<typeof registerWorkbenchFeatureIpc> | null = null;
let cloudSync: ReturnType<typeof registerCloudSyncIpc> | null = null;
let debugApi: ReturnType<typeof registerDebugApiIpc> | null = null;
let inputFeatures: ReturnType<typeof registerInputAttachmentIpc> | null = null;
let disposingServices = false;
let serviceShutdown: Promise<void> | null = null;
let activeSessionPath: string | null = null;
const pendingUnreadPaths = new Set<string>();
let workspaceActivationQueue: Promise<void> = Promise.resolve();
let automaticRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
let sessionSearchRequest = 0;
let lastSessionMetaPrune = 0;
let sessionGroupService: SessionGroupService | null = null;
let automationService: ReturnType<typeof createAutomationService> | null = null;
let pluginMutationActive = false;
const discoverPlugins = createPluginDiscovery();
/** Resolved each time an agent host process is forked; custom engines apply after an app restart. */
const agentEngineOptions: AgentHostEngineOptions = {
	resolveEngineDir: () => {
		const selection = readCurrentDesktopSettings().piEngine;
		return selection?.mode === 'custom' ? selection.path : undefined;
	},
};
const automationExecutor = createAutomationExecutor({
	createAgent: (ui) => createIsolatedAgentService(ui, agentEngineOptions),
	withSessionSetup: (action) => queueWorkspaceActivation(action),
});

// ---------------------------------------------------------------------------
// Hosted pai chat windows
//
// `pai` used to cold-start a second Pi Desktop process for every window.
// Hosted windows live inside the main instance instead: each window owns an
// isolated agent host process, its renderer talks through the same channels,
// and agent events are delivered per window instead of broadcast.
// ---------------------------------------------------------------------------

export interface PaiWindowRequest {
	cwd: string;
	sessionPath?: string;
}
type PaiAgentService = ReturnType<typeof createIsolatedAgentService>;
interface PaiWindowEntry {
	win: BrowserWindow;
	cwd: string;
	sessionPath?: string;
	agent: PaiAgentService;
	/** Session the hosted agent currently has open; null while switching or fresh. */
	liveSessionPath: string | null;
	busy: boolean;
	loaded: boolean;
	firstPaintReady: boolean;
	rendererReady: boolean;
	revealed: boolean;
	closing: boolean;
	disposed: boolean;
}
const pendingPaiWindowRequests: PaiWindowRequest[] = [];
let paiWindowsReady = false;
let mainAgentBusy = false;

/** Pai windows keep their own agent host; every other window shares the main service. */
function agentFor(event: IpcMainInvokeEvent): PaiAgentService {
	return (paiSlotForSender(event.sender)?.agent as PaiAgentService | undefined) ?? agentService;
}


function updateKeepAwakeBusy(): void {
	let busy = mainAgentBusy;
	for (const entry of paiWindowSlots()) busy = busy || entry.busy;
	keepAwake?.setAgentBusy(busy);
}

async function disposePaiEntry(entry: PaiWindowEntry): Promise<void> {
	if (entry.disposed) return;
	entry.disposed = true;
	try { await entry.agent.dispose(); }
	catch (error) { console.error('pai agent disposal failed:', error); }
	updateKeepAwakeBusy();
}

function closePaiWindow(entry: PaiWindowEntry): void {
	if (entry.closing || entry.win.isDestroyed()) return;
	entry.closing = true;
	void (async () => {
		try {
			if (entry.busy) {
				const english = getAppLocale() === 'en-US';
				const { response } = await dialog.showMessageBox(entry.win, {
					type: 'warning',
					message: english ? 'Tasks are still running' : '仍有任务在运行',
					detail: english ? 'Closing this window interrupts its conversation.' : '关闭小窗会中断其中正在运行的会话。',
					buttons: [english ? 'Cancel' : '取消', english ? 'Close' : '关闭'],
					defaultId: 0,
					cancelId: 0,
					noLink: true,
				});
				if (response !== 1) { entry.closing = false; return; }
			}
		} catch { /* A failed confirm still allows closing the window. */ }
		unregisterPaiWindowSlot(entry.win);
		await disposePaiEntry(entry);
		if (!entry.win.isDestroyed()) entry.win.destroy();
	})().catch((error: unknown) => console.error('pai window close failed:', error));
}

async function recoverPaiAgent(entry: PaiWindowEntry): Promise<void> {
	if (entry.win.isDestroyed() || disposingServices) return;
	const held = new Set(paiHeldSessionPaths());
	held.delete(entry.liveSessionPath ?? '');
	const excludeSessionPaths = [...automationExecutor.sessionPaths(entry.cwd), ...held];
	try {
		if (entry.liveSessionPath) await entry.agent.init({ cwd: entry.cwd, sessionPath: entry.liveSessionPath, excludeSessionPaths });
		else await entry.agent.init({ cwd: entry.cwd, fresh: true });
	} catch (error) {
		console.error('pai agent recovery failed:', error);
	}
}

function requestPaiProjectTrust(entry: PaiWindowEntry, cwd: string): Promise<{ trusted: boolean; remember: boolean }> {
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
	const choice = entry.win.isDestroyed() ? dialog.showMessageBox(options) : dialog.showMessageBox(entry.win, options);
	return choice.then(({ response }) => ({ trusted: response !== 0, remember: response === 2 }));
}

function requestPaiExtensionDialog(entry: PaiWindowEntry, request: UiExtensionDialogRequest, signal?: AbortSignal): Promise<UiExtensionDialogResponse> {
	const owner = entry.win;
	if (disposingServices || owner.isDestroyed() || owner.webContents.isDestroyed()) return Promise.resolve(null);
	if (request.kind === 'notify') {
		if (notificationReadyWindows.has(owner)) owner.webContents.send(IPC_CHANNELS.agentExtensionDialog, request);
		else {
			const queue = notificationsFor(owner);
			queue.requests.push(request);
			if (queue.requests.length > MAX_STARTUP_NOTIFICATIONS) queue.requests.shift();
		}
		return Promise.resolve(null);
	}
	return extensionDialogFor(owner, request, signal);
}

function notifyPaiRendererReady(win: BrowserWindow): void {
	const entry = paiWindowSlots().find((slot) => slot.win === win) as PaiWindowEntry | undefined;
	if (!entry) return;
	entry.rendererReady = true;
	revealPaiWindow(entry);
}

function revealPaiWindow(entry: PaiWindowEntry): void {
	if (entry.revealed || entry.win.isDestroyed()) return;
	if (!entry.loaded || !entry.firstPaintReady || !entry.rendererReady) return;
	entry.revealed = true;
	entry.win.show();
	entry.win.webContents.setBackgroundThrottling(true);
}

/**
 * pai failures use the async dialog: the synchronous showErrorBox would
 * freeze the whole app (pipe server included) until the box is dismissed.
 */
function showPaiErrorDialog(owner: BrowserWindow | null | undefined, message: string): void {
	const options = {
		type: 'error' as const,
		title: 'pai',
		message,
		buttons: [getAppLocale() === 'en-US' ? 'Close' : '关闭'],
	};
	const shown = owner && !owner.isDestroyed() ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options);
	void shown.catch(() => {});
}

function createPaiWindow(request: PaiWindowRequest): void {
	const cwd = validatePaiWorkspace(request.cwd);
	const sessionPath = request.sessionPath === undefined ? undefined : validatePaiSession(request.sessionPath);
	// A conversation the user asks for twice focuses its existing window.
	if (sessionPath) {
		for (const slot of paiWindowSlots()) {
			const entry = slot as PaiWindowEntry;
			if (entry.sessionPath === sessionPath || entry.liveSessionPath === sessionPath) {
				if (entry.win.isMinimized()) entry.win.restore();
				entry.win.show();
				entry.win.focus();
				return;
			}
		}
	}
	// This module is bundled into out/main/chunks/, so relative paths from here
	// would miss; the app root carries the same out/ layout packaged and in dev.
	const appRoot = app.getAppPath();
	const win = new BrowserWindow({
		width: 920,
		height: 780,
		minWidth: 680,
		minHeight: 520,
		backgroundColor: '#111216',
		title: 'pai',
		frame: process.platform !== 'win32',
		autoHideMenuBar: process.platform === 'win32',
		show: false,
		webPreferences: {
			preload: join(appRoot, 'out', 'preload', 'index.mjs'),
			backgroundThrottling: false,
			contextIsolation: true,
			sandbox: false,
			nodeIntegration: false,
		},
	});
	const entry: PaiWindowEntry = {
		win, cwd,
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
		requestProjectTrust: (target) => requestPaiProjectTrust(entry, target),
		requestExtensionDialog: (dialogRequest, signal) => requestPaiExtensionDialog(entry, dialogRequest, signal),
		onHostCrash: () => {
			setTimeout(() => void recoverPaiAgent(entry), 250);
		},
	}, agentEngineOptions);
	registerPaiWindowSlot(entry);
	const publishChromeState = (): void => {
		if (win.webContents.isDestroyed()) return;
		win.webContents.send(IPC_CHANNELS.windowChromeStateChanged, { isMaximized: win.isMaximized() });
	};
	win.on('maximize', publishChromeState);
	win.on('unmaximize', publishChromeState);
	let failureReported = false;
	const reportFailure = (reason: string): void => {
		if (failureReported || entry.disposed) return;
		failureReported = true;
		console.error('pai renderer failed:', reason);
		showPaiErrorDialog(win, reason);
		closePaiWindow(entry);
	};
	win.webContents.on('render-process-gone', (_event, details) => {
		if (details.reason !== 'clean-exit') reportFailure(details.reason);
	});
	win.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
		if (isMainFrame && code !== -3) reportFailure(description);
	});
	win.webContents.setWindowOpenHandler(({ url }) => {
		try {
			const parsed = new URL(url);
			if (parsed.protocol === 'https:' || parsed.protocol === 'http:') void shell.openExternal(parsed.toString());
		} catch { /* Ignore malformed links from generated content. */ }
		return { action: 'deny' };
	});
	win.on('close', (event) => {
		if (entry.closing) return;
		event.preventDefault();
		closePaiWindow(entry);
	});
	win.on('closed', () => {
		unregisterPaiWindowSlot(win);
		void disposePaiEntry(entry);
	});
	entry.agent.onEvent((envelope: AgentEventEnvelope) => {
		const event = envelope.event;
		if (event.type === 'ready') entry.liveSessionPath = event.sessionPath;
		if (event.type === 'status') {
			entry.busy = event.status === 'busy';
			updateKeepAwakeBusy();
		}
		if (!entry.revealed && !entry.win.isDestroyed()) return; // Nothing is listening yet; the snapshot covers pre-reveal state.
		if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(IPC_CHANNELS.agentEvent, envelope);
	});
	entry.agent.onBackgroundActivity((_cwd, path) => {
		if (entry.liveSessionPath === path || pendingUnreadPaths.has(path)) return;
		pendingUnreadPaths.add(path);
		void (async () => {
			await withSessionMeta(async (meta) => {
				const stamp = Math.max(Date.now(), (meta[path]?.unreadAt ?? 0) + 1);
				meta[path] = { ...meta[path], unread: true, unreadAt: stamp };
				await saveSessionMeta(meta);
			});
		})().catch((error: unknown) => {
			console.error('Failed to save session activity metadata:', error);
		}).finally(() => pendingUnreadPaths.delete(path));
	});
	updateKeepAwakeBusy();
	win.once('ready-to-show', () => {
		entry.firstPaintReady = true;
		revealPaiWindow(entry);
	});
	// The renderer bootstraps from a single snapshot and receives no agent
	// events before it is revealed; loading it before the agent finishes
	// initializing would snapshot a session-less agent and the window would
	// never become ready. Load only once the agent can serve a real snapshot.
	const startLoad = (): void => {
		if (entry.disposed || entry.win.isDestroyed()) return;
		const load = !app.isPackaged && process.env.ELECTRON_RENDERER_URL
			? win.loadURL(rendererLaunchUrl(process.env.ELECTRON_RENDERER_URL, { windowMode: 'pai', cwd }))
			: win.loadFile(join(appRoot, 'out', 'renderer', 'index.html'), { query: { mode: 'pai' } });
		void load.then(() => {
			entry.loaded = true;
			revealPaiWindow(entry);
		}).catch((error: unknown) => reportFailure(error instanceof Error ? error.message : String(error)));
	};
	void entry.agent.init({ cwd, ...(sessionPath ? { sessionPath } : { fresh: true }) })
		.then(() => { startLoad(); })
		.catch((error: unknown) => {
			console.error('pai agent failed to initialize:', error);
			showPaiErrorDialog(win, error instanceof Error ? error.message : String(error));
			closePaiWindow(entry);
		});
}

/**
 * Opens a hosted pai chat window. Called by the pai pipe server, the
 * second-instance handoff, a cold `--pai` launch and "open in new window".
 * Requests that arrive before IPC is wired are queued and replayed.
 */
export function openPaiWindow(request: PaiWindowRequest): void {
	if (!paiWindowsReady) {
		pendingPaiWindowRequests.push(request);
		return;
	}
	createPaiWindow(request);
}

async function disposeAllPaiWindows(): Promise<void> {
	const entries = paiWindowSlots() as PaiWindowEntry[];
	for (const entry of entries) {
		entry.closing = true;
		unregisterPaiWindowSlot(entry.win);
	}
	await Promise.allSettled(entries.map(async (entry) => {
		if (!entry.win.isDestroyed()) entry.win.destroy();
		await disposePaiEntry(entry);
	}));
}
function notificationsFor(owner: BrowserWindow): StartupNotifications {
	const existing = startupNotifications.get(owner);
	if (existing) return existing;
	const queue: StartupNotifications = {
		requests: [],
		rendererReady: false,
		flush: () => {
			if (owner.isDestroyed() || owner.webContents.isDestroyed()) { queue.cleanup(); return; }
			if (!queue.rendererReady || !owner.isVisible()) return;
			notificationReadyWindows.add(owner);
			queue.cleanup();
			for (const request of queue.requests) owner.webContents.send(IPC_CHANNELS.agentExtensionDialog, request);
		},
		cleanup: () => {
			startupNotifications.delete(owner);
			owner.removeListener('show', queue.flush);
			owner.removeListener('closed', queue.cleanup);
		},
	};
	startupNotifications.set(owner, queue);
	owner.on('show', queue.flush);
	owner.once('closed', queue.cleanup);
	return queue;
}

/** Displays (or queues) one extension dialog request on a specific owner window. */
function extensionDialogFor(owner: BrowserWindow, request: UiExtensionDialogRequest, signal?: AbortSignal): Promise<UiExtensionDialogResponse> {
	if (owner.isDestroyed() || owner.webContents.isDestroyed()) return Promise.resolve(null);
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (value: UiExtensionDialogResponse): void => {
			if (!pendingDialogs.has(request.id)) return;
			pendingDialogs.delete(request.id);
			cleanup();
			if (!owner.isDestroyed() && !owner.webContents.isDestroyed()) owner.webContents.send(IPC_CHANNELS.agentExtensionDialogClosed, request.id);
			resolve(value);
		};
		const onAbort = (): void => finish(null);
		const onClosed = (): void => finish(null);
		const cleanup = (): void => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			owner.removeListener('closed', onClosed);
		};
		pendingDialogs.set(request.id, { request, owner, resolve: finish, cleanup });
		if (signal?.aborted) { finish(null); return; }
		signal?.addEventListener('abort', onAbort, { once: true });
		owner.once('closed', onClosed);
		if (request.timeout && request.timeout > 0) timer = setTimeout(() => finish(null), request.timeout);
		owner.webContents.send(IPC_CHANNELS.agentExtensionDialog, request);
		// A window that was never revealed is still behind the splash; startup
		// requests reveal it themselves instead of notifying.
		if (notificationReadyWindows.has(owner)) notifyInputRequest?.(request);
	});
}

function requestExtensionDialog(request: UiExtensionDialogRequest, signal?: AbortSignal): Promise<UiExtensionDialogResponse> {
	if (disposingServices) return Promise.resolve(null);
	// The focused window can still be the logo splash while Pi initializes.
	// Only a renderer with our preload bridge can display/answer extension UI.
	const owner = getDialogWindow();
	if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed()) return Promise.resolve(null);
	if (request.kind === 'notify') {
		if (notificationReadyWindows.has(owner)) owner.webContents.send(IPC_CHANNELS.agentExtensionDialog, request);
		else {
			// Do not lose startup notices before React subscribes, or let their
			// dismissal timers expire behind the splash. A notice never reveals UI.
			const queue = notificationsFor(owner);
			queue.requests.push(request);
			if (queue.requests.length > MAX_STARTUP_NOTIFICATIONS) queue.requests.shift();
		}
		return Promise.resolve(null);
	}
	return extensionDialogFor(owner, request, signal);
}

export const agentService = createIsolatedAgentService({ requestProjectTrust: async (cwd) => {
	const english = getAppLocale() === 'en-US';
	const { response } = await dialog.showMessageBox({
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
	});
	return { trusted: response !== 0, remember: response === 2 };
}, requestExtensionDialog, onHostCrash: () => {
	if (disposingServices || !activeWorkspace) return;
	const cwd = activeWorkspace;
	const sessionPath = activeSessionPath;
	automaticRecoveryTimer = setTimeout(() => {
		automaticRecoveryTimer = null;
		// Recovery changes the active Pi context too. Use the same queue as
		// workspace selection so neither transition can interrupt the other.
		void queueWorkspaceActivation(async () => {
			if (activeWorkspace !== cwd) return;
			// Hosted pai windows and automations keep working in this cwd; never
			// restore one of their sessions while recovering the main agent host.
			const excluded = [...automationExecutor.sessionPaths(cwd), ...paiHeldSessionPaths()];
			await agentService.init(excluded.length ? { cwd, excludeSessionPaths: excluded } : { cwd });
			if (sessionPath && (await agentService.listSessions(cwd)).some((session) => session.path === sessionPath)) {
				await agentService.switchSession(sessionPath);
			}
		}).catch((error: unknown) => {
			console.error('Pi agent recovery failed:', error);
		});
	}, 250);
} }, agentEngineOptions);

interface WorkspaceSettings {
	cwd?: string;
	workspaces?: string[];
	pinnedWorkspaces?: string[];
	conversationWorkspaces?: string[];
	conversationStorageDirectories?: string[];
	explicitWorkspaces?: string[];
	workspaceNicknames?: Record<string, string>;
	workspaceAppearance?: Record<string, { bar?: string | null }>;
}
function workspaceKey(cwd: string): string {
	const key = resolve(cwd);
	return process.platform === 'win32' ? key.toLowerCase() : key;
}

/** Background-bar values are preset ids or hex colors; anything else is rejected at the IPC boundary. */
const PROJECT_BAR_VALUE = new RegExp(`^(?:${PROJECT_BAR_PRESET_IDS.join('|')}|#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})$`);
let activeWorkspace = '';
const pickedWorkspaces = new Set<string>();
const sessionOwnerByPath = new Map<string, string>();
const MAX_PICKED_WORKSPACES = 16;
const MAX_CACHED_SESSION_OWNERS = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWorkspaceSettings(value: unknown): value is WorkspaceSettings {
	return isRecord(value)
		&& (value.cwd === undefined || typeof value.cwd === 'string')
		&& (value.workspaces === undefined || (Array.isArray(value.workspaces) && value.workspaces.every((cwd) => typeof cwd === 'string')))
		&& (value.conversationWorkspaces === undefined || (Array.isArray(value.conversationWorkspaces) && value.conversationWorkspaces.every((cwd) => typeof cwd === 'string')))
		&& (value.conversationStorageDirectories === undefined || (Array.isArray(value.conversationStorageDirectories) && value.conversationStorageDirectories.every((cwd) => typeof cwd === 'string')))
		&& (value.explicitWorkspaces === undefined || (Array.isArray(value.explicitWorkspaces) && value.explicitWorkspaces.every((cwd) => typeof cwd === 'string')))
		&& (value.workspaceNicknames === undefined || (isRecord(value.workspaceNicknames) && Object.values(value.workspaceNicknames).every((nickname) => typeof nickname === 'string' && nickname.length <= 80)))
		&& (value.workspaceAppearance === undefined || (isRecord(value.workspaceAppearance) && Object.values(value.workspaceAppearance).every((appearance) => isRecord(appearance) && (appearance.bar === undefined || appearance.bar === null || (typeof appearance.bar === 'string' && PROJECT_BAR_VALUE.test(appearance.bar))))))
		&& (value.pinnedWorkspaces === undefined || (Array.isArray(value.pinnedWorkspaces) && value.pinnedWorkspaces.every((cwd) => typeof cwd === 'string')));
}

function readWorkspaceSettings(): WorkspaceSettings {
	return readStateFile(workspaceSettingsPath(), () => ({}), isWorkspaceSettings);
}

function readWorkspaceSettingsAsync(): Promise<WorkspaceSettings> {
	return readStateFileAsync(workspaceSettingsPath(), () => ({}), isWorkspaceSettings);
}

let workspaceSettingsQueue: Promise<void> = Promise.resolve();
let desktopSettingsQueue: Promise<void> = Promise.resolve();
let appearancePath = appearanceStatePath(app.getPath('userData'));
let stopAppearanceWatch: (() => void) | null = null;
function withWorkspaceSettings<T>(action: (settings: WorkspaceSettings) => Promise<T> | T): Promise<T> {
	const result = workspaceSettingsQueue.then(async () => action(await readWorkspaceSettingsAsync()));
	workspaceSettingsQueue = result.then(() => undefined, () => undefined);
	return result;
}

function desktopSettingsPath(): string {
	return join(app.getPath('userData'), 'desktop-settings.json');
}

/** Sync read for the close-policy handler (4.2); corrupt files fall back to defaults. */
export function readCurrentDesktopSettings(): DesktopSettings {
	return readDesktopSettings(desktopSettingsPath(), join(app.getPath('home'), 'PiDesktopWorkspace'));
}

/** Persists the choice made in the busy-close dialog (4.2): the same close behavior the Settings
 * page shows, plus "no more asking" while tasks run. Picking a behavior in Settings asks again. */
export function saveCloseChoice(behavior: DesktopSettings['closeBehavior']): Promise<void> {
	// Share the settings queue so a concurrent Settings save cannot drop this choice.
	const result = desktopSettingsQueue.then(() => {
		const current = readCurrentDesktopSettings();
		writeDesktopSettings(desktopSettingsPath(), { ...current, closeBehavior: behavior, confirmBusyClose: false });
		keepAwake?.settingsChanged();
	});
	desktopSettingsQueue = result.then(() => undefined, () => undefined);
	return result;
}

/** Sends a main → renderer command (tray menu, notification clicks). */
export function sendAppCommand(command: UiAppCommand): void {
	broadcastToRenderers(IPC_CHANNELS.appCommand, command);
}

/** True while a foreground turn streams or an automation run is in flight (4.2). */
export async function isAgentWorkActive(): Promise<boolean> {
	try {
		const snapshot = await agentService.getSnapshot();
		if (snapshot.status === 'busy') return true;
	} catch { /* snapshot unavailable — treat as idle */ }
	try {
		if (await automationService?.hasActiveRuns()) return true;
	} catch { /* ignore scheduler errors */ }
	return false;
}

function workspaceSettingsPath(): string {
	return join(app.getPath('userData'), 'workspace.json');
}

export function defaultWorkspace(initialWorkspace?: string): string {
	if (initialWorkspace !== undefined) {
		if (!statSync(initialWorkspace).isDirectory()) throw new Error('The launch workspace must be a directory');
		saveWorkspace(initialWorkspace, true);
		activeWorkspace = initialWorkspace;
		return initialWorkspace;
	}
	let saved: WorkspaceSettings;
	try {
		saved = readWorkspaceSettings();
	} catch (error) {
		if (!(error instanceof CorruptStateFileError)) {
			dialog.showErrorBox(getAppLocale() === 'en-US' ? 'Workspace settings could not be read' : '无法读取工作区设置', String(error));
			throw error;
		}
		const backup = backupCorruptStateFile(workspaceSettingsPath());
		const english = getAppLocale() === 'en-US';
		dialog.showErrorBox(english ? 'Workspace settings recovered' : '工作区设置已恢复',
			english ? `The damaged settings were saved to:\n${backup}\n\nA default workspace will open. You can restore your old workspace list from the backup.`
				: `损坏的设置已备份到：\n${backup}\n\n将打开默认工作区。你可以从备份中恢复旧工作区列表。`);
		saved = {};
	}
	try {
		if (typeof saved.cwd === 'string' && statSync(saved.cwd).isDirectory()) {
			activeWorkspace = saved.cwd;
			return saved.cwd;
		}
	} catch {
		// A saved workspace may have been moved or removed.
	}
	const root = readCurrentDesktopSettings().conversationStorageDirectory;
	const cwd = createConversationWorkspaceSync(root);
	writeStateFile(workspaceSettingsPath(), registerConversationWorkspace(saved, cwd, root));
	activeWorkspace = cwd;
	return cwd;
}

function saveWorkspace(cwd: string, explicit = false): void {
	const previous = readWorkspaceSettings();
	const workspaces = [...new Set([...(Array.isArray(previous.workspaces) ? previous.workspaces : []), previous.cwd, cwd]
		.filter((value): value is string => typeof value === 'string' && value.length > 0))];
	writeStateFile(workspaceSettingsPath(), { ...previous, cwd, workspaces, pinnedWorkspaces: previous.pinnedWorkspaces ?? [],
		...(explicit ? { explicitWorkspaces: [...new Set([...(previous.explicitWorkspaces ?? []), cwd])] } : {}),
	});
}

async function saveWorkspaceAsync(cwd: string, explicit = false): Promise<void> {
	await withWorkspaceSettings(async (previous) => {
		const workspaces = [...new Set([...(Array.isArray(previous.workspaces) ? previous.workspaces : []), previous.cwd, cwd]
			.filter((value): value is string => typeof value === 'string' && value.length > 0))];
		await writeStateFileAsync(workspaceSettingsPath(), { ...previous, cwd, workspaces, pinnedWorkspaces: previous.pinnedWorkspaces ?? [],
			...(explicit ? { explicitWorkspaces: [...new Set([...(previous.explicitWorkspaces ?? []), cwd])] } : {}),
		});
	});
}

async function listWorkspaces(): Promise<string[]> {
	await workspaceSettingsQueue;
	const saved = await readWorkspaceSettingsAsync();
	const candidates = [...new Set([...(saved.workspaces ?? []), ...(saved.conversationWorkspaces ?? []), ...conversationWorkspaces(saved), saved.cwd, activeWorkspace]
		.filter((value): value is string => typeof value === 'string' && value.length > 0))];
	const existing = await Promise.all(candidates.map(async (cwd) => {
		try { return (await stat(cwd)).isDirectory(); }
		catch { return false; }
	}));
	return candidates.filter((_, index) => existing[index]);
}

function conversationWorkspaces(saved: WorkspaceSettings): string[] {
	const explicit = new Set((saved.explicitWorkspaces ?? []).map(workspaceKey));
	return [...new Set([...(saved.conversationWorkspaces ?? []), ...(saved.conversationStorageDirectories ?? []),
		readCurrentDesktopSettings().conversationStorageDirectory, join(app.getPath('home'), 'PiDesktopWorkspace')])]
		.filter((cwd) => !explicit.has(workspaceKey(cwd)));
}

async function listConversationWorkspaces(): Promise<string[]> {
	await workspaceSettingsQueue;
	return conversationWorkspaces(await readWorkspaceSettingsAsync());
}

export async function isConversationWorkspace(cwd: string): Promise<boolean> {
	return (await listConversationWorkspaces()).some((path) => workspaceKey(path) === workspaceKey(cwd));
}

function registerConversationWorkspace(previous: WorkspaceSettings, cwd: string, root: string): WorkspaceSettings {
	return {
		...previous, cwd,
		workspaces: [...new Set([...(previous.workspaces ?? []), ...(previous.cwd ? [previous.cwd] : []), cwd])],
		conversationWorkspaces: [...new Set([...(previous.conversationWorkspaces ?? []), cwd])],
		conversationStorageDirectories: [...new Set([...(previous.conversationStorageDirectories ?? []), root])],
	};
}

function newConversation(options?: unknown): Promise<UiInputScope> {
	if (options !== undefined && (!isRecord(options) || (options.cwd !== undefined && typeof options.cwd !== 'string'))) {
		throw new Error('新对话选项无效');
	}
	if (pluginMutationActive) return Promise.reject(new Error('插件正在更新，请完成后再新建对话'));
	if (automaticRecoveryTimer) clearTimeout(automaticRecoveryTimer);
	automaticRecoveryTimer = null;
	return queueWorkspaceActivation(async () => {
		if (isRecord(options) && typeof options.cwd === 'string') {
			await performWorkspaceActivation(options.cwd, true, true);
		} else {
			const root = readCurrentDesktopSettings().conversationStorageDirectory;
			const cwd = await createConversationWorkspace(root);
			// Keep the folder and its registry even if initialization fails: extensions
			// can already have written files, and a retry must never delete that work.
			await withWorkspaceSettings((previous) => writeStateFileAsync(workspaceSettingsPath(), {
				...registerConversationWorkspace(previous, cwd, root), cwd: previous.cwd,
			}));
			await performWorkspaceActivation(cwd, true, true);
			invalidateAppTrayData();
		}
		// Capture and authorize the created draft before the next queued navigation
		// can activate another session. The renderer may already have moved away.
		const snapshot = await agentService.getSnapshot();
		const scope = { cwd: snapshot.cwd, sessionPath: snapshot.sessionPath };
		inputFeatures?.rememberScope(scope);
		return scope;
	});
}

function getProjectsDirectory(): string {
	return join(app.getPath('documents'), 'Pi Desktop');
}

const createProject = createProjectCreator({
	getProjectsDirectory,
	getLocale: getAppLocale,
	register: (cwd) => withWorkspaceSettings(async (previous) => {
		const registered = [...(previous.workspaces ?? []), previous.cwd, activeWorkspace]
			.filter((value): value is string => typeof value === 'string' && value.length > 0);
		const workspaces = [...new Map([...registered, cwd].map((path) => [workspaceKey(path), path])).values()];
		await writeStateFileAsync(workspaceSettingsPath(), { ...previous, workspaces,
			explicitWorkspaces: [...new Set([...(previous.explicitWorkspaces ?? []), cwd])],
		});
		invalidateAppTrayData();
	}),
});

async function listPinnedWorkspaces(): Promise<string[]> {
	return withWorkspaceSettings(async (saved) => {
		const registered = [...new Set([...(saved.workspaces ?? []), saved.cwd, activeWorkspace]
			.filter((value): value is string => typeof value === 'string' && value.length > 0))];
		const byKey = new Map(registered.map((cwd) => [workspaceKey(cwd), cwd]));
		const pinned = [...new Set(saved.pinnedWorkspaces ?? [])].map((cwd) => byKey.get(workspaceKey(cwd))).filter((cwd): cwd is string => Boolean(cwd));
		const existing = await Promise.all(pinned.map(async (cwd) => {
			try { return (await stat(cwd)).isDirectory(); } catch { return false; }
		}));
		return pinned.filter((_, index) => existing[index]);
	});
}

async function setPinnedWorkspaces(value: unknown): Promise<string[]> {
	if (!Array.isArray(value) || value.length > 256 || value.some((cwd) => typeof cwd !== 'string' || !cwd || cwd.length > 32768 || cwd.includes('\0'))) {
		throw new Error('置顶项目参数无效');
	}
	return withWorkspaceSettings(async (previous) => {
		const registered = [...new Set([...(previous.workspaces ?? []), previous.cwd, activeWorkspace]
			.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))];
		const byKey = new Map(registered.map((cwd) => [workspaceKey(cwd), cwd]));
		const pinned: string[] = [];
		const seen = new Set<string>();
		for (const requested of value) {
			const key = workspaceKey(requested);
			const cwd = byKey.get(key);
			if (!cwd) throw new Error('只能置顶已打开的项目');
			if (!seen.has(key)) { seen.add(key); pinned.push(cwd); }
		}
		await writeStateFileAsync(workspaceSettingsPath(), { ...previous, pinnedWorkspaces: pinned });
		return pinned;
	});
}

type SessionMeta = Omit<UiSessionMetaPatch, 'name' | 'expectedUnreadAt'>;
function sessionMetaPath(): string { return join(app.getPath('userData'), 'sessions-meta.json'); }
function isSessionMeta(value: unknown): value is Record<string, SessionMeta> {
	return isRecord(value) && Object.values(value).every((entry) => isRecord(entry)
		&& ['pinned', 'archived', 'unread'].every((key) => entry[key] === undefined || typeof entry[key] === 'boolean')
		&& (entry.unreadAt === undefined || (typeof entry.unreadAt === 'number' && Number.isSafeInteger(entry.unreadAt) && entry.unreadAt >= 0))
		&& (entry.order === undefined || (typeof entry.order === 'number' && Number.isInteger(entry.order) && Math.abs(entry.order) <= 1e9)));
}
async function readSessionMeta(): Promise<Record<string, SessionMeta>> {
	try {
		return await readStateFileAsync(sessionMetaPath(), () => ({}), isSessionMeta);
	} catch (error) {
		if (!(error instanceof CorruptStateFileError)) throw error;
		const backup = await backupCorruptStateFileAsync(sessionMetaPath());
		const english = getAppLocale() === 'en-US';
		dialog.showErrorBox(english ? 'Session metadata recovered' : '会话信息已恢复',
			english ? `The damaged session metadata was saved to:\n${backup}\n\nPinned, archived, and unread flags can be restored from the backup.`
				: `损坏的会话信息已备份到：\n${backup}\n\n置顶、归档和未读状态可以从备份中恢复。`);
		return {};
	}
}
function saveSessionMeta(meta: Record<string, SessionMeta>): Promise<void> {
	invalidateAppTrayData();
	return writeStateFileAsync(sessionMetaPath(), meta);
}

// Serialize every metadata read and mutation so simultaneous background events,
// pin changes, and read receipts cannot overwrite one another.
let sessionMetaQueue: Promise<void> = Promise.resolve();
function withSessionMeta<T>(action: (meta: Record<string, SessionMeta>) => Promise<T> | T): Promise<T> {
	const result = sessionMetaQueue.then(async () => action(await readSessionMeta()));
	sessionMetaQueue = result.then(() => undefined, () => undefined);
	return result;
}

function rememberSessionOwner(path: string, cwd: string): void {
	sessionOwnerByPath.delete(path);
	sessionOwnerByPath.set(path, cwd);
	if (sessionOwnerByPath.size > MAX_CACHED_SESSION_OWNERS) {
		const oldest = sessionOwnerByPath.keys().next().value;
		if (oldest !== undefined) sessionOwnerByPath.delete(oldest);
	}
}

function likelySessionOwners(path: string, workspaces: string[]): string[] {
	// Pi's default session directory encodes the absolute cwd. Treat it only as
	// a hint: names can collide, and sessions may live in a custom directory.
	const directory = basename(dirname(path));
	return workspaces.filter((cwd) =>
		`--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--` === directory);
}

/** Validate session ownership against the current list of registered projects. */
async function requireSessionOwner(path: string, allowCurrentDraft = false): Promise<string> {
	return (await requireSessionOwners([path], allowCurrentDraft)).get(normalizeSessionPath(path))!;
}

/** Read only the session header line: machine-wide sessions may name a workspace the app never opened. */
async function readSessionHeaderOwner(path: string): Promise<string | null> {
	try {
		const stream = createReadStream(path, { encoding: 'utf8' });
		const lines = createInterface({ input: stream, crlfDelay: Infinity });
		try {
			for await (const line of lines) {
				if (!line.trim()) continue;
				const entry = JSON.parse(line) as { type?: unknown; cwd?: unknown };
				return entry?.type === 'session' && typeof entry.cwd === 'string' && entry.cwd ? entry.cwd : null;
			}
			return null;
		} finally { lines.close(); stream.destroy(); }
	} catch { return null; }
}

async function requireSessionOwners(paths: string[], allowCurrentDraft = false): Promise<Map<string, string>> {
	const targets = [...new Set(paths.map(normalizeSessionPath))];
	if (targets.some((path) => automationExecutor.isSessionRunning(path))) throw new Error('自动化仍在运行，请结束后再打开会话');
	const heldByPai = new Set(paiHeldSessionPaths());
	if (targets.some((path) => heldByPai.has(path))) throw new Error('会话已在 pai 小窗中打开，请先关闭该小窗');
	// Only explicit naming may materialize a currently loaded, unsaved session.
	// Snapshot identity is trusted host state; the agent rechecks its runtime path.
	const current = allowCurrentDraft ? await agentService.getSnapshot() : null;
	const knownWorkspaces = await listWorkspaces();
	// Each project is parsed at most once in a batch, including cache misses.
	const listings = new Map<string, Promise<Set<string>>>();
	const sessionsFor = (cwd: string): Promise<Set<string>> => {
		let listing = listings.get(cwd);
		if (!listing) {
			listing = agentService.listSessions(cwd).then((sessions) => new Set(sessions.map((session) => session.path)));
			listings.set(cwd, listing);
		}
		return listing;
	};
	const result = new Map<string, string>();
	for (const path of targets) {
		if (current?.sessionId && current.sessionPath === path && knownWorkspaces.includes(current.cwd)) { result.set(path, current.cwd); continue; }
		let owner: string | undefined;
		const cached = sessionOwnerByPath.get(path);
		if (cached && knownWorkspaces.includes(cached)
			&& (await sessionsFor(cached)).has(path)) owner = cached;
		else sessionOwnerByPath.delete(path);
		if (!owner) {
			const workspaces = knownWorkspaces.filter((cwd) => cwd !== cached);
			const likely = likelySessionOwners(path, workspaces);
			for (const cwd of likely) {
				if ((await sessionsFor(cwd)).has(path)) { owner = cwd; break; }
			}
			if (!owner) {
				const remaining = workspaces.filter((cwd) => !likely.includes(cwd));
				const owners = await Promise.all(remaining.map(async (cwd) => ({ cwd, sessions: await sessionsFor(cwd) })));
				owner = owners.find(({ sessions }) => sessions.has(path))?.cwd;
			}
			if (owner) rememberSessionOwner(path, owner);
		}
		// Session management lists every transcript on this machine; conversations from
		// workspaces the app never opened fall back to the header's own cwd, confirmed
		// against that workspace's listing so a stale header cannot forge ownership.
		if (!owner) {
			const headerOwner = await readSessionHeaderOwner(path);
			if (headerOwner && (await sessionsFor(headerOwner)).has(path)) owner = headerOwner;
		}
		if (!owner) throw new Error('未找到会话');
		result.set(path, owner);
	}
	return result;
}

function activateWorkspace(cwd: string, initialize: boolean, fresh = false): Promise<void> {
	if (pluginMutationActive) return Promise.reject(new Error('插件正在更新，请完成后再切换项目'));
	if (automaticRecoveryTimer) clearTimeout(automaticRecoveryTimer);
	automaticRecoveryTimer = null;
	return queueWorkspaceActivation(() => performWorkspaceActivation(cwd, initialize, fresh));
}

function queueWorkspaceActivation<T>(action: () => Promise<T>): Promise<T> {
	const result = workspaceActivationQueue.then(() => {
		if (disposingServices) throw new Error('Pi agent is shutting down');
		return action();
	});
	workspaceActivationQueue = result.then(() => undefined, () => undefined);
	return result;
}

async function performWorkspaceActivation(cwd: string, initialize: boolean, fresh: boolean): Promise<void> {
	if (typeof cwd !== 'string') throw new Error('未知工作区');
	const saved = await readWorkspaceSettingsAsync();
	// Detaching a draft must also work before the built-in home workspace has
	// ever been selected or added to the saved workspace list.
	const known = [activeWorkspace, saved.cwd, ...conversationWorkspaces(saved), ...(saved.workspaces ?? [])];
	if (!known.includes(cwd) && !pickedWorkspaces.has(cwd)) throw new Error('未知工作区');
	try { if (!(await stat(cwd)).isDirectory()) throw new Error('工作区目录无效'); }
	catch { throw new Error('工作区目录无效'); }
	if (cwd !== activeWorkspace) await workbenchService?.reset();
	const previous = activeWorkspace;
	activeWorkspace = cwd;
	try {
		// Hosted pai windows keep working in their own cwd; the main agent never
		// restores a conversation one of their windows is writing.
		const excludeSessionPaths = [...automationExecutor.sessionPaths(cwd), ...paiHeldSessionPaths()];
		if (fresh) await agentService.init({ cwd, fresh: true });
		else if (initialize) await agentService.init(excludeSessionPaths.length ? { cwd, excludeSessionPaths } : { cwd });
		else if (excludeSessionPaths.length) await agentService.switchWorkspace(cwd, excludeSessionPaths);
		else await agentService.switchWorkspace(cwd);
	} catch (error) {
		activeWorkspace = previous;
		throw error;
	}
	await saveWorkspaceAsync(cwd, pickedWorkspaces.has(cwd));
	pickedWorkspaces.delete(cwd);
	await markSessionRead((await agentService.getSnapshot()).sessionPath);
}

async function markSessionRead(path: string | null): Promise<void> {
	if (!path) return;
	await withSessionMeta(async (meta) => {
		if (!meta[path]?.unread) return;
		// zcode clearTaskUnreadIfMatches: opening a session clears unconditionally
		// and drops the watermark so stale stamps never leak into summaries.
		meta[path] = { ...meta[path], unread: false, unreadAt: undefined };
		await saveSessionMeta(meta);
	});
}

function invokingWindow(event: IpcMainInvokeEvent): BrowserWindow {
	return requireRendererSender(event);
}

function requirePluginSender(event: IpcMainInvokeEvent): BrowserWindow {
	const owner = getDialogWindow();
	if (disposingServices || !owner || owner.isDestroyed() || owner.webContents.isDestroyed()
		|| event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame) throw new Error('Invalid plugin sender');
	return owner;
}

function requirePluginWorkspace(cwd: unknown): asserts cwd is string {
	if (typeof cwd !== 'string' || !cwd || cwd !== activeWorkspace) throw new Error('项目已切换，请刷新插件页面后重试');
}

async function withPluginMutation<T>(cwd: string, action: () => Promise<T>): Promise<T> {
	if (pluginMutationActive) throw new Error('已有插件操作正在进行，请稍后重试');
	requirePluginWorkspace(cwd);
	// Reserve before any asynchronous read: new schedules are deferred, while
	// already claimed runs are observed by the serialized snapshot below.
	pluginMutationActive = true;
	try {
		let result!: T;
		await queueWorkspaceActivation(async () => {
			requirePluginWorkspace(cwd);
			if (await automationService?.hasActiveRuns() || automationExecutor.hasActiveWorkers()) throw new Error('自动化仍在运行，请结束后再修改插件');
			result = await action();
		});
		return result;
	} finally { pluginMutationActive = false; }
}

/**
 * Trusted sender check for channels a pai settings page also reaches
 * (personalization, cloud backup, debug API): the main window or the pai
 * window's own renderer. Plugin management stays main-window-only.
 */
function requireTrustedSender(event: IpcMainInvokeEvent): BrowserWindow {
	const paiSlot = paiSlotForSender(event.sender);
	if (paiSlot) return paiSlot.win;
	return requirePluginSender(event);
}

/**
 * Channels a hosted pai window must not reach: everything that drives the
 * main window's agent navigation, workspace/workbench surface, session
 * management, plugins, automations and updates. Enforced centrally in
 * handleRendererInvoke so modules registered outside ipc.ts are covered too.
 */
const mainOnlyChannels = new Set<string>([
	IPC_CHANNELS.agentInit, IPC_CHANNELS.agentNewSession, IPC_CHANNELS.agentResidentSnapshot, IPC_CHANNELS.agentActivateResident,
	IPC_CHANNELS.agentListWorkspaces, IPC_CHANNELS.workspaceListConversations, IPC_CHANNELS.conversationStoragePick,
	IPC_CHANNELS.agentListSessions, IPC_CHANNELS.agentSearchSessions, IPC_CHANNELS.agentSwitchSession,
	IPC_CHANNELS.sessionRevealFile, IPC_CHANNELS.sessionFork, IPC_CHANNELS.sessionOpenWindow, IPC_CHANNELS.sessionDelete,
	IPC_CHANNELS.agentUpdateSessionMeta, IPC_CHANNELS.agentUpdateSessionOrders, IPC_CHANNELS.agentListSessionGroups, IPC_CHANNELS.agentUpdateSessionGroups,
	IPC_CHANNELS.contextRead, IPC_CHANNELS.workspaceSearchFiles, IPC_CHANNELS.appRelaunch,
	IPC_CHANNELS.workspacePick, IPC_CHANNELS.workspaceProjectsDirectory, IPC_CHANNELS.workspaceCreateProject, IPC_CHANNELS.workspaceAddDropped,
	IPC_CHANNELS.workspaceSwitch, IPC_CHANNELS.workspaceDefault, IPC_CHANNELS.workspaceRemove, IPC_CHANNELS.workspaceListPinned, IPC_CHANNELS.workspaceSetPinned,
	IPC_CHANNELS.pluginCatalog, IPC_CHANNELS.pluginMutate, IPC_CHANNELS.pluginPreview, IPC_CHANNELS.pluginPickDirectory, IPC_CHANNELS.pluginDiscover,
	IPC_CHANNELS.agentSetExtensionEnabled, PLUGIN_UPDATE_CHANNELS.checkPluginUpdate,
	IPC_CHANNELS.updateCheck, IPC_CHANNELS.updateInstall,
	IPC_CHANNELS.automationSnapshot, IPC_CHANNELS.automationSave, IPC_CHANNELS.automationSetEnabled, IPC_CHANNELS.automationDelete, IPC_CHANNELS.automationRun, IPC_CHANNELS.automationCancelRun,
	IPC_CHANNELS.workspaceOpenFolder, IPC_CHANNELS.workspaceListEntries, IPC_CHANNELS.workspaceReadFile,
	IPC_CHANNELS.workspaceCreateEntry, IPC_CHANNELS.workspaceRenameEntry, IPC_CHANNELS.workspaceDeleteEntry,
	IPC_CHANNELS.resultFileOpen, IPC_CHANNELS.resultFileReveal, IPC_CHANNELS.resultFilePreview,
	IPC_CHANNELS.workspaceGitStatus, IPC_CHANNELS.workspaceGitDiff, IPC_CHANNELS.workspaceBranches, IPC_CHANNELS.workspaceCheckoutBranch,
	IPC_CHANNELS.workspaceGitSetStaged, IPC_CHANNELS.workspaceGitDiscard, IPC_CHANNELS.workspaceGitLog, IPC_CHANNELS.workspaceGitGraph,
	IPC_CHANNELS.workspaceGitSync, IPC_CHANNELS.workspaceGitCreateBranch,
	IPC_CHANNELS.workspaceOpenPathInEditor, IPC_CHANNELS.workspaceRevealPath, IPC_CHANNELS.workspaceOpenInVsCode, IPC_CHANNELS.workspaceOpenWith,
	IPC_CHANNELS.workspaceOpeners, IPC_CHANNELS.workspaceCommitContext, IPC_CHANNELS.workspaceCommit,
	IPC_CHANNELS.workspaceProjectNickname, IPC_CHANNELS.workspaceSetProjectNickname,
	IPC_CHANNELS.workspaceProjectAppearance, IPC_CHANNELS.workspaceSetProjectAppearance,
	IPC_CHANNELS.workspaceCommandStart, IPC_CHANNELS.workspaceCommandStop, IPC_CHANNELS.workspaceWatch,
	WORKBENCH_FEATURE_CHANNELS.getWorkspaceCommitPreview, WORKBENCH_FEATURE_CHANNELS.commitWorkspacePreview,
	WORKBENCH_FEATURE_CHANNELS.createTaskWorktree, WORKBENCH_FEATURE_CHANNELS.listTaskWorktrees, WORKBENCH_FEATURE_CHANNELS.bindTaskWorktree,
	WORKBENCH_FEATURE_CHANNELS.getGitDeliveryPreview, WORKBENCH_FEATURE_CHANNELS.pushWorkspaceBranch, WORKBENCH_FEATURE_CHANNELS.createWorkspaceDraftPr,
	WORKBENCH_FEATURE_CHANNELS.openWorkspaceTerminal, WORKBENCH_FEATURE_CHANNELS.getWorkspaceTerminal, WORKBENCH_FEATURE_CHANNELS.writeWorkspaceTerminal,
	WORKBENCH_FEATURE_CHANNELS.resizeWorkspaceTerminal, WORKBENCH_FEATURE_CHANNELS.acknowledgeWorkspaceTerminal, WORKBENCH_FEATURE_CHANNELS.closeWorkspaceTerminal,
	DATA_FEATURE_CHANNELS.listMachineSessions, DATA_FEATURE_CHANNELS.searchSessionsPage, DATA_FEATURE_CHANNELS.searchProjectFiles, DATA_FEATURE_CHANNELS.cancelDataSearch,
]);

export function registerIpc(options: {
	windowMode?: 'full' | 'pai' | 'multi';
	onRendererReady?(win: BrowserWindow): void;
	getDialogWindow?(): BrowserWindow | undefined;
	baseUserData?: string;
} = {}): void {
	const windowMode = options.windowMode ?? 'full';
	getDialogWindow = options.getDialogWindow ?? (() => undefined);
	const notifier = createDesktopNotifier({
		settingsPath: desktopSettingsPath,
		getMainWindow: () => getDialogWindow() ?? null,
		revealSession: (path, cwd) => sendAppCommand({ type: 'switch-session', path, cwd }),
	});
	notifyInputRequest = (request) => notifier.handleInputRequest(request, activeSessionPath, agentService.cwd || activeWorkspace);
	keepAwake = createKeepAwakeController({ settingsPath: desktopSettingsPath, defaultStorageDirectory: join(app.getPath('home'), 'PiDesktopWorkspace') });
	updateService.setAutoInstallSource(() => readCurrentDesktopSettings().autoInstallUpdates === true);
	appearancePath = appearanceStatePath(options.baseUserData ?? app.getPath('userData'));
	// Hosted pai windows may be requested before IPC is wired (pipe server or
	// second-instance handoff during boot); replay those requests now.
	paiWindowsReady = true;
	for (const request of pendingPaiWindowRequests.splice(0)) {
		try { createPaiWindow(request); }
		catch (error) { showPaiErrorDialog(undefined, error instanceof Error ? error.message : String(error)); }
	}
	setRendererSenderRestriction({ isPaiSender, mainOnlyChannels });
	handleRendererInvoke(MCP_FEATURE_CHANNELS.getMcpSnapshot, (event) => agentFor(event).getMcpSnapshot());
	handleRendererInvoke(MCP_FEATURE_CHANNELS.saveMcpServer, (event, request: Parameters<typeof agentService.saveMcpServer>[0]) => agentFor(event).saveMcpServer(request));
	handleRendererInvoke(MCP_FEATURE_CHANNELS.removeMcpServer, (event, request: Parameters<typeof agentService.removeMcpServer>[0]) => agentFor(event).removeMcpServer(request));
	handleRendererInvoke(MCP_FEATURE_CHANNELS.connectMcpServer, (event, request: Parameters<typeof agentService.connectMcpServer>[0]) => agentFor(event).connectMcpServer(request));
	handleRendererInvoke(MCP_FEATURE_CHANNELS.disconnectMcpServer, (event, request: Parameters<typeof agentService.disconnectMcpServer>[0]) => agentFor(event).disconnectMcpServer(request));
	handleRendererInvoke(MCP_FEATURE_CHANNELS.testMcpServer, (event, request: Parameters<typeof agentService.testMcpServer>[0]) => agentFor(event).testMcpServer(request));
	workbenchService = registerWorkbenchIpc(() => activeWorkspace, {
		// App-side remark store: only used when a project root has no .code-workspace
		// file; keys follow the same normalization as every other workspace record.
		read: (cwd) => withWorkspaceSettings((saved) => saved.workspaceNicknames?.[workspaceKey(cwd)] ?? null),
		write: async (cwd, nickname) => {
			await withWorkspaceSettings(async (previous) => {
				await writeStateFileAsync(workspaceSettingsPath(), { ...previous, workspaceNicknames: { ...(previous.workspaceNicknames ?? {}), [workspaceKey(cwd)]: nickname } });
			});
		},
		clear: async (cwd) => {
			await withWorkspaceSettings(async (previous) => {
				if (!previous.workspaceNicknames?.[workspaceKey(cwd)]) return;
				const workspaceNicknames = { ...previous.workspaceNicknames };
				delete workspaceNicknames[workspaceKey(cwd)];
				await writeStateFileAsync(workspaceSettingsPath(), { ...previous, workspaceNicknames });
			});
		},
	});
	handleRendererInvoke(IPC_CHANNELS.workspaceProjectAppearance, (_event, cwd: unknown) => {
		if (typeof cwd !== 'string' || !cwd) throw new Error('工作区路径无效');
		return withWorkspaceSettings((saved) => saved.workspaceAppearance?.[workspaceKey(cwd)] ?? { bar: null });
	});
	handleRendererInvoke(IPC_CHANNELS.workspaceSetProjectAppearance, (_event, cwd: unknown, patch: unknown) => {
		if (typeof cwd !== 'string' || !cwd) throw new Error('工作区路径无效');
		if (!isRecord(patch) || patch.bar === undefined || (patch.bar !== null && !(typeof patch.bar === 'string' && PROJECT_BAR_VALUE.test(patch.bar)))) throw new Error('外观参数无效');
		const bar = patch.bar;
		return withWorkspaceSettings(async (previous) => {
			const key = workspaceKey(cwd);
			const current = { ...(previous.workspaceAppearance?.[key] ?? {}) };
			if (bar === null) delete current.bar; else current.bar = bar;
			const workspaceAppearance = { ...(previous.workspaceAppearance ?? {}) };
			if (Object.keys(current).length > 0) workspaceAppearance[key] = current; else delete workspaceAppearance[key];
			await writeStateFileAsync(workspaceSettingsPath(), { ...previous, workspaceAppearance });
		});
	});
	workbenchFeatures = registerWorkbenchFeatureIpc(() => activeWorkspace, app.getPath('userData'));
	inputFeatures = registerInputAttachmentIpc(() => [
		{ cwd: activeWorkspace, sessionPath: activeSessionPath },
		...(paiWindowSlots() as PaiWindowEntry[]).map((entry) => ({ cwd: entry.cwd, sessionPath: entry.liveSessionPath })),
	]);
	handleRendererInvoke(INPUT_FEATURE_CHANNELS.submitInput, (event, request: Parameters<typeof agentService.submitInput>[0]) => agentFor(event).submitInput(request));
	handleRendererInvoke(INPUT_FEATURE_CHANNELS.getInputQueue, (event, scope: Parameters<typeof agentService.getInputQueue>[0]) => agentFor(event).getInputQueue(requireInputQueueScope(scope)));
	handleRendererInvoke(INPUT_FEATURE_CHANNELS.mutateInputQueue, (event, request: Parameters<typeof agentService.mutateInputQueue>[0]) => {
		requireInputQueueScope(request?.scope); return agentFor(event).mutateInputQueue(request);
	});
	handleRendererInvoke(WORKBENCH_FEATURE_CHANNELS.getFileCheckpoint, (event) => agentFor(event).getFileCheckpoint());
	handleRendererInvoke(WORKBENCH_FEATURE_CHANNELS.rewindFileCheckpoint, (event, request: Parameters<typeof agentService.rewindFileCheckpoint>[0]) => agentFor(event).rewindFileCheckpoint(request));
	handleRendererInvoke(WORKBENCH_FEATURE_CHANNELS.getEditRewindPreview, (event, entryId: string) => agentFor(event).getEditRewindPreview(entryId));
	handleRendererInvoke(WORKBENCH_FEATURE_CHANNELS.getFileChangeDiffs, (event, scope: Parameters<typeof agentService.getFileChangeDiffs>[0]) => agentFor(event).getFileChangeDiffs(scope));
	handleRendererInvoke(MANAGEMENT_FEATURE_CHANNELS.testProviderModel, (event, request: Parameters<typeof agentService.testProviderModel>[0]) => agentFor(event).testProviderModel(request));
	handleRendererInvoke(MANAGEMENT_FEATURE_CHANNELS.cancelProviderModelTest, (event, id: string) => agentFor(event).cancelProviderModelTest(id));
	handleRendererInvoke(MANAGEMENT_FEATURE_CHANNELS.getProjectDefaults, (event) => agentFor(event).getProjectDefaults());
	handleRendererInvoke(MANAGEMENT_FEATURE_CHANNELS.saveProjectDefaults, (event, request: Parameters<typeof agentService.saveProjectDefaults>[0]) => agentFor(event).saveProjectDefaults(request));
	handleRendererInvoke(MANAGEMENT_FEATURE_CHANNELS.queryProviderUsage, (event, provider: string) => agentFor(event).queryProviderUsage(provider));
	handleRendererInvoke(MANAGEMENT_FEATURE_CHANNELS.saveProviderUsageQuery, (event, request: Parameters<typeof agentService.saveProviderUsageQuery>[0]) => agentFor(event).saveProviderUsageQuery(request));
	handleRendererInvoke(MANAGEMENT_FEATURE_CHANNELS.resetProvider, (event, provider: string) => agentFor(event).resetProvider(provider));
	handleRendererInvoke(IPC_CHANNELS.personalizationRead, (event) => {
		requireTrustedSender(event);
		return agentFor(event).getPersonalization();
	});
	handleRendererInvoke(IPC_CHANNELS.personalizationSave, (event, request: UiSaveInstructionRequest) => {
		requireTrustedSender(event);
		return agentFor(event).saveInstruction(request);
	});
	cloudSync = registerCloudSyncIpc(agentService, requireTrustedSender);
	debugApi = registerDebugApiIpc({
		settingsPath: desktopSettingsPath(),
		cloudSync: () => cloudSync?.service ?? null,
		appVersion: () => app.getVersion(),
		requireTrustedSender: (event) => { requireTrustedSender(event); },
	});
	const diagnosticsService = initializeDiagnostics(join(app.getPath('userData'), 'diagnostics'));
	// Kept for the error-details export affordance; the data-management page itself is gone.
	handleRendererInvoke(MANAGEMENT_FEATURE_CHANNELS.exportDiagnostics, async (_event, days: number) => {
		if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('请选择最近 1 至 30 天');
		const result = await dialog.showSaveDialog({ title: '导出脱敏诊断包', defaultPath: `pi-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`, filters: [{ name: 'ZIP', extensions: ['zip'] }] });
		if (result.canceled || !result.filePath) return { path: null, entries: 0, skipped: [] };
		const report = await diagnosticsService.archive(result.filePath, days, { app: app.getVersion(), electron: process.versions.electron ?? '', node: process.versions.node, platform: process.platform });
		return { path: result.filePath, ...report };
	});
	const automations = createAutomationService({
		filePath: join(app.getPath('userData'), 'automations.json'),
		execute: (task, signal, dispatch) => automationExecutor.execute(task, signal, dispatch),
		canRun: () => pluginMutationActive ? false : automationExecutor.hasUnreleasedWorkers()
			? '上次自动化执行进程尚未退出，请重启应用后重试' : true,
		validateWorkspace: async (cwd) => {
			if (!(await listWorkspaces()).includes(cwd)) throw new Error('未知工作区，请先在侧栏打开项目');
		},
		onChanged: (snapshot) => {
			const win = getDialogWindow();
			if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(IPC_CHANNELS.automationChanged, snapshot);
			keepAwake?.setAutomationActive(snapshot.runs.some((run) => run.status === 'running' || run.status === 'retrying'));
		},
		onError: (error) => console.error('Automation scheduler failed:', error),
		onRunFinished: (entry, task) => { notifier.handleAutomationRun(entry, task.name, task.cwd); },
	});
	handleRendererInvoke(IPC_CHANNELS.desktopSettingsGet, () => readCurrentDesktopSettings());
	stopAppearanceWatch = watchAppearanceState(appearancePath, (state) => {
		if (state) sendAppCommand({ type: 'appearance-changed', appearance: state });
	});
	handleRendererInvoke(IPC_CHANNELS.appearanceGet, () => readAppearanceState(appearancePath));
	handleRendererInvoke(IPC_CHANNELS.appearanceSet, (_event, state: unknown) => {
		if (!isValidAppearanceState(state)) throw new Error('外观设置无效');
		writeAppearanceState(appearancePath, state);
		sendAppCommand({ type: 'appearance-changed', appearance: state });
	});
	handleRendererInvoke(IPC_CHANNELS.desktopSettingsSet, (event, patch: unknown) => {
		const win = invokingWindow(event);
		if (event.senderFrame !== win.webContents.mainFrame) throw new Error('Invalid desktop-settings sender');
		if (!isRecord(patch)) throw new Error('设置参数无效');
		let piEngine: UiPiEngineSelection | undefined;
		if (patch.piEngine !== undefined) {
			if (!isValidPiEngineSelection(patch.piEngine)) throw new Error('Pi 引擎设置无效');
			piEngine = patch.piEngine;
			if (piEngine.mode === 'custom') {
				// Refuse to persist a broken engine path: it would make every agent
				// host fork fatal after the next restart.
				const probe = probePiEngine(piEngine.path, readBuiltinEngineInfo()?.version ?? null);
				if (!probe.ok) throw new Error(`自定义 Pi 引擎不可用：${probe.problems.join('；')}`);
			}
		}
		const result = desktopSettingsQueue.then(async () => {
			const directory = patch.conversationStorageDirectory === undefined ? undefined
				: await prepareConversationStorageDirectory(patch.conversationStorageDirectory);
			const previousDirectory = readCurrentDesktopSettings().conversationStorageDirectory;
			if (directory && workspaceKey(directory) !== workspaceKey(previousDirectory)) {
				await withWorkspaceSettings((previous) => {
					const existingProject = (previous.workspaces ?? []).some(cwd => workspaceKey(cwd) === workspaceKey(directory))
						&& !(previous.conversationWorkspaces ?? []).some(cwd => workspaceKey(cwd) === workspaceKey(directory))
						&& workspaceKey(directory) !== workspaceKey(join(app.getPath('home'), 'PiDesktopWorkspace'));
					return writeStateFileAsync(workspaceSettingsPath(), {
						...previous, conversationStorageDirectories: [...new Set([...(previous.conversationStorageDirectories ?? []), previousDirectory, directory])],
						...(existingProject ? { explicitWorkspaces: [...new Set([...(previous.explicitWorkspaces ?? []), directory])] } : {}),
					});
				});
			}
			const current = readCurrentDesktopSettings();
			const chosenCloseBehavior = patch.closeBehavior === 'tray' || patch.closeBehavior === 'quit' ? patch.closeBehavior : null;
			const next: DesktopSettings = {
				notificationsEnabled: typeof patch.notificationsEnabled === 'boolean' ? patch.notificationsEnabled : current.notificationsEnabled,
				closeBehavior: chosenCloseBehavior ?? current.closeBehavior,
				// Choosing a close behavior in Settings is a fresh decision: ask again on the next busy close.
				confirmBusyClose: chosenCloseBehavior !== null ? true : current.confirmBusyClose,
				keepAwakeWhileRunning: typeof patch.keepAwakeWhileRunning === 'boolean' ? patch.keepAwakeWhileRunning : current.keepAwakeWhileRunning,
				autoInstallUpdates: typeof patch.autoInstallUpdates === 'boolean' ? patch.autoInstallUpdates : current.autoInstallUpdates,
				conversationStorageDirectory: directory ?? current.conversationStorageDirectory,
				piEngine: piEngine ?? current.piEngine,
			};
			writeDesktopSettings(desktopSettingsPath(), next);
			keepAwake?.settingsChanged();
			// Enabling auto-install is explicit consent: chain straight into download +
			// silent install for an already-known version, or start an auto-install check.
			if (patch.autoInstallUpdates === true) {
				const state = updateService.getState();
				if (state.availableVersion) void updateService.install().catch(() => { /* Published as update state. */ });
				else if (state.phase === 'idle' || state.phase === 'up-to-date' || (state.phase === 'error' && !state.availableVersion)) void updateService.check(true).catch(() => { /* Published as update state. */ });
			}
			return next;
		});
		desktopSettingsQueue = result.then(() => undefined, () => undefined);
		return result;
	});
	handleRendererInvoke(IPC_CHANNELS.piEngineProbe, (_event, path: unknown) => {
		if (typeof path !== 'string' || !path.trim()) throw new Error('引擎目录无效');
		return probePiEngine(path, readBuiltinEngineInfo()?.version ?? null);
	});
	handleRendererInvoke(IPC_CHANNELS.piEngineStatus, (event) => {
		const builtinVersion = readBuiltinEngineInfo()?.version ?? null;
		const selection = readCurrentDesktopSettings().piEngine ?? { mode: 'builtin' as const };
		const active = agentFor(event).getActiveEngine();
		const selectionVersion = selection.mode === 'custom' ? probePiEngine(selection.path, builtinVersion).version : builtinVersion;
		const sameEngine = active !== null && (
			(selection.mode === 'builtin' && active.mode === 'builtin')
			|| (selection.mode === 'custom' && active.mode === 'custom' && active.path.trim().toLowerCase() === selection.path.trim().toLowerCase())
		);
		const status: UiPiEngineStatus = { builtinVersion, selection: { ...selection, version: selectionVersion }, active, pendingRestart: active !== null && !sameEngine };
		return status;
	});
	handleRendererInvoke(IPC_CHANNELS.piEnginePickDirectory, async (event) => {
		const owner = invokingWindow(event);
		const selected = await dialog.showOpenDialog(owner, {
			properties: ['openDirectory'],
			title: getAppLocale() === 'en-US' ? 'Choose a Pi engine directory' : '选择 Pi 引擎目录',
		});
		return selected.canceled ? null : (selected.filePaths[0] ?? null);
	});
	handleRendererInvoke(IPC_CHANNELS.appRelaunch, async (event) => {
		const owner = invokingWindow(event);
		if (await isAgentWorkActive()) {
			const english = getAppLocale() === 'en-US';
			const { response } = await dialog.showMessageBox(owner, {
				type: 'warning',
				message: english ? 'Tasks are still running' : '仍有任务在运行',
				detail: english ? 'Restarting interrupts the running conversation or automation.' : '重启会中断正在运行的会话或自动化任务。',
				buttons: [english ? 'Cancel' : '取消', english ? 'Restart' : '重启'],
				defaultId: 0,
				cancelId: 0,
			});
			if (response !== 1) return false;
		}
		// app.quit (unlike app.exit) runs before-quit, which disposes the agent
		// host and flushes queued metadata before the relaunch takes over.
		app.relaunch();
		app.quit();
		return true;
	});
	automationService = automations;
	handleRendererInvoke(IPC_CHANNELS.pluginCatalog, (event, cwd: unknown) => {
		requirePluginSender(event); requirePluginWorkspace(cwd);
		return agentService.getPluginCatalog(cwd);
	});
	handleRendererInvoke(PLUGIN_UPDATE_CHANNELS.checkPluginUpdate, (event, request: Parameters<typeof agentService.checkPluginUpdate>[0]) => { requirePluginSender(event); requirePluginWorkspace(request.cwd); return agentService.checkPluginUpdate(request); });
	handleRendererInvoke(IPC_CHANNELS.pluginMutate, (event, input: UiPluginMutation) => {
		requirePluginSender(event);
		if (!isRecord(input)) throw new Error('插件操作参数无效');
		requirePluginWorkspace(input.cwd);
		return withPluginMutation(input.cwd, () => agentService.mutatePlugin(input));
	});
	handleRendererInvoke(IPC_CHANNELS.pluginPreview, (event, request: { cwd: string; path: string; kind: UiPluginResourceKind; scope: UiPluginScope }) => {
		requirePluginSender(event);
		if (!isRecord(request)) throw new Error('插件预览参数无效');
		requirePluginWorkspace(request.cwd);
		return agentService.previewPluginResource(request);
	});
	handleRendererInvoke(IPC_CHANNELS.pluginPickDirectory, async (event) => {
		const owner = requirePluginSender(event);
		const selected = await dialog.showOpenDialog(owner, {
			properties: ['openDirectory'], title: getAppLocale() === 'en-US' ? 'Choose a Pi plugin directory' : '选择 Pi 插件目录',
		});
		return selected.canceled ? null : selected.filePaths[0] ?? null;
	});
	handleRendererInvoke(IPC_CHANNELS.pluginDiscover, (event, query: unknown) => {
		requirePluginSender(event);
		return discoverPlugins(query);
	});
	const automationHandler = (action: (...args: any[]) => unknown) => (event: IpcMainInvokeEvent, ...args: unknown[]) => {
		if (isPaiSender(event)) throw new Error('Automations are available in the main Pi Desktop window');
		const owner = getDialogWindow();
		if (disposingServices || !owner || owner.isDestroyed() || owner.webContents.isDestroyed()
			|| event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame) throw new Error('Invalid automation sender');
		return action(...args);
	};
	handleRendererInvoke(IPC_CHANNELS.automationSnapshot, automationHandler(() => automations.snapshot()));
	handleRendererInvoke(IPC_CHANNELS.automationSave, automationHandler((input) => automations.save(input)));
	handleRendererInvoke(IPC_CHANNELS.automationSetEnabled, automationHandler((id, enabled) => automations.setEnabled(id, enabled)));
	handleRendererInvoke(IPC_CHANNELS.automationDelete, automationHandler((id) => automations.delete(id)));
	handleRendererInvoke(IPC_CHANNELS.automationRun, automationHandler((id) => automations.run(id)));
	handleRendererInvoke(IPC_CHANNELS.automationCancelRun, automationHandler((runId) => automations.cancelRun(runId)));
	const groups = new SessionGroupService({
		path: join(app.getPath('userData'), 'session-groups.json'),
		validateSessionPath: async (path) => { await requireSessionOwner(path); },
		onCorruptState: (backup) => {
			const english = getAppLocale() === 'en-US';
			dialog.showErrorBox(english ? 'Session groups recovered' : '会话分组已恢复',
				english ? `The damaged group settings were saved to:\n${backup}\n\nYour sessions have not been changed.`
					: `损坏的分组设置已备份到：\n${backup}\n\n原有会话未作修改。`);
		},
	});
	sessionGroupService = groups;
	handleRendererInvoke(IPC_CHANNELS.rendererReady, (event) => {
		const win = invokingWindow(event);
		if (event.senderFrame !== win.webContents.mainFrame) throw new Error('Invalid renderer-ready sender');
		notifyPaiRendererReady(win);
		options.onRendererReady?.(win);
		if (windowMode === 'full') void automations.start().catch((error: unknown) => {
			if (!disposingServices) console.error('Automation scheduler failed to start:', error);
		});
		if (!win.isDestroyed() && !notificationReadyWindows.has(win)) {
			const queue = notificationsFor(win);
			queue.rendererReady = true;
			queue.flush();
		}
	});
	// Main-window agent events go to every full window; hosted pai windows
	// receive only their own agent's envelopes (routed in createPaiWindow).
	agentService.onEvent((event: AgentEventEnvelope) => {
		if (event.event.type === 'ready') activeSessionPath = event.event.sessionPath;
		if (event.event.type === 'ready' || event.event.type === 'status' || event.event.type === 'sessions-changed') invalidateAppTrayData();
		if (event.event.type === 'status') {
			mainAgentBusy = event.event.status === 'busy';
			updateKeepAwakeBusy();
		}
		notifier.handleAgentEvent(event, activeSessionPath, agentService.cwd || activeWorkspace);
		broadcastToRenderers(IPC_CHANNELS.agentEvent, event, (win) => !isPaiWindow(win));
	});
	agentService.onBackgroundActivity((_, path) => {
		if (pendingUnreadPaths.has(path)) return;
		pendingUnreadPaths.add(path);
		void (async () => {
			// A settle that fires just before this session becomes the open one must
			// not leave a stale unread dot on the conversation the user is viewing.
			if ((await agentService.getSnapshot()).sessionPath === path) return;
			await withSessionMeta(async (meta) => {
				// zcode unread_at/last_unread_at: every settle re-stamps a strictly
				// increasing watermark so a stale clear can never wipe a newer unread.
				const stamp = Math.max(Date.now(), (meta[path]?.unreadAt ?? 0) + 1);
				meta[path] = { ...meta[path], unread: true, unreadAt: stamp };
				await saveSessionMeta(meta);
			});
		})().catch((error: unknown) => {
			console.error('Failed to save session activity metadata:', error);
		}).finally(() => pendingUnreadPaths.delete(path));
	});

	handleRendererInvoke(IPC_CHANNELS.appInfo, (event) => ({
		appVersion: app.getVersion(),
		nodeVersion: process.versions.node ?? 'unknown',
		electronVersion: process.versions.electron ?? 'unknown',
		platform: process.platform,
		windowMode: isPaiSender(event) ? 'pai' as const : windowMode,
	}));
	handleRendererInvoke(IPC_CHANNELS.appSetLocale, (_event, locale: AppLocale) => {
		setAppLocale(locale);
		updateAppTrayMenu();
	});
	handleRendererInvoke(IPC_CHANNELS.updateState, (event) => isPaiSender(event)
		? { phase: 'unavailable', unavailableReason: 'unsupported', currentVersion: app.getVersion() } : updateService.getState());
	handleRendererInvoke(IPC_CHANNELS.updateCheck, (event, autoInstall?: unknown) => {
		if (isPaiSender(event)) throw new Error('Install updates from the main Pi Desktop window');
		return updateService.check(autoInstall === true);
	});
	handleRendererInvoke(IPC_CHANNELS.updateInstall, (event) => {
		if (isPaiSender(event)) throw new Error('Install updates from the main Pi Desktop window');
		return updateService.install();
	});
	handleRendererInvoke(IPC_CHANNELS.windowChromeState, (event) => ({
		isMaximized: invokingWindow(event).isMaximized(),
	}));
	handleRendererInvoke(IPC_CHANNELS.windowMinimize, (event) => {
		invokingWindow(event).minimize();
	});
	handleRendererInvoke(IPC_CHANNELS.windowToggleMaximize, (event) => {
		const win = invokingWindow(event);
		if (win.isMaximized()) win.unmaximize();
		else win.maximize();
	});
	handleRendererInvoke(IPC_CHANNELS.windowClose, (event) => {
		invokingWindow(event).close();
	});

	handleRendererInvoke(IPC_CHANNELS.workspaceProjectsDirectory, () => getProjectsDirectory());
	handleRendererInvoke(IPC_CHANNELS.workspaceCreateProject, (_event, name: unknown) => createProject(name));
	handleRendererInvoke(IPC_CHANNELS.conversationStoragePick, async () => {
		const result = await dialog.showOpenDialog({
			properties: ['openDirectory', 'createDirectory'],
			title: getAppLocale() === 'en-US' ? 'Choose conversation storage folder' : '选择对话保存位置',
			defaultPath: readCurrentDesktopSettings().conversationStorageDirectory,
		});
		return result.canceled ? null : result.filePaths[0] ?? null;
	});
	handleRendererInvoke(IPC_CHANNELS.workspacePick, async () => {
		const result = await dialog.showOpenDialog({
			properties: ['openDirectory'],
			title: getAppLocale() === 'en-US' ? 'Choose a Pi workspace' : '选择 Pi 工作区',
		});
		if (result.canceled || result.filePaths.length === 0) return null;
		const selected = result.filePaths[0] ?? null;
		if (selected) {
			pickedWorkspaces.delete(selected);
			pickedWorkspaces.add(selected);
			if (pickedWorkspaces.size > MAX_PICKED_WORKSPACES) {
				const oldest = pickedWorkspaces.values().next().value;
				if (oldest !== undefined) pickedWorkspaces.delete(oldest);
			}
		}
		return selected;
	});
	handleRendererInvoke(IPC_CHANNELS.agentListWorkspaces, () => listWorkspaces());
	handleRendererInvoke(IPC_CHANNELS.workspaceListConversations, () => listConversationWorkspaces());
	handleRendererInvoke(IPC_CHANNELS.workspaceAddDropped, (_event, paths: unknown) => withWorkspaceSettings(async (previous) => {
		const registered = [...(previous.workspaces ?? []), previous.cwd, activeWorkspace]
			.filter((cwd): cwd is string => typeof cwd === 'string' && cwd.length > 0);
		const result = await prepareWorkspaceDrop(paths, registered);
		if (result.accepted.length > 0) {
			await writeStateFileAsync(workspaceSettingsPath(), { ...previous, workspaces: result.workspaces,
				explicitWorkspaces: [...new Set([...(previous.explicitWorkspaces ?? []), ...result.accepted])],
			});
			invalidateAppTrayData();
		}
		return result.accepted;
	}));
	handleRendererInvoke(IPC_CHANNELS.workspaceListPinned, () => listPinnedWorkspaces());
	handleRendererInvoke(IPC_CHANNELS.workspaceSetPinned, (_event, cwds: unknown) => setPinnedWorkspaces(cwds));
	handleRendererInvoke(IPC_CHANNELS.agentListSessionGroups, () => groups.list());
	handleRendererInvoke(IPC_CHANNELS.agentUpdateSessionGroups, (_event, change: UiSidebarGroupChange) => groups.update(change));
	handleRendererInvoke(IPC_CHANNELS.workspaceSwitch, (_event, cwd: string, options?: unknown) => {
		if (options !== undefined && (!isRecord(options) || (options.fresh !== undefined && typeof options.fresh !== 'boolean'))) throw new Error('项目切换选项无效');
		return activateWorkspace(cwd, false, isRecord(options) && options.fresh === true);
	});
	handleRendererInvoke(IPC_CHANNELS.workspaceDefault, () => {
		// The detach target is always the home workspace, not the last-saved cwd
		// that defaultWorkspace() restores.
		const home = readCurrentDesktopSettings().conversationStorageDirectory;
		// Recursive mkdir still fails with EPERM on an existing drive root (D:\).
		if (!statSync(home, { throwIfNoEntry: false })?.isDirectory()) mkdirSync(home, { recursive: true });
		return home;
	});
	handleRendererInvoke(IPC_CHANNELS.workspaceRemove, (_event, cwd: string) => queueWorkspaceActivation(async () => {
		if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > 32768 || cwd.includes('\0')) throw new Error('项目路径无效');
		const target = workspaceKey(cwd);
		if (target === (activeWorkspace ? workspaceKey(activeWorkspace) : activeWorkspace)) throw new Error('无法移除当前项目，请先切换到其他项目');
		await agentService.forgetWorkspace(cwd);
		await withWorkspaceSettings(async (previous) => {
			const workspaces = [...new Set([...(Array.isArray(previous.workspaces) ? previous.workspaces : []), previous.cwd]
				.filter((value): value is string => typeof value === 'string' && value.length > 0))]
				.filter((path) => workspaceKey(path) !== target);
			const pinnedWorkspaces = (previous.pinnedWorkspaces ?? []).filter((path) => workspaceKey(path) !== target);
			const explicitWorkspaces = previous.explicitWorkspaces?.filter((path) => workspaceKey(path) !== target);
			const home = readCurrentDesktopSettings().conversationStorageDirectory;
			await writeStateFileAsync(workspaceSettingsPath(), { ...previous, cwd: previous.cwd && workspaceKey(previous.cwd) === target ? home : previous.cwd, workspaces, pinnedWorkspaces,
				...(explicitWorkspaces ? { explicitWorkspaces } : {}),
			});
		});
		for (const picked of [...pickedWorkspaces]) if (workspaceKey(picked) === target) pickedWorkspaces.delete(picked);
		for (const [path, owner] of sessionOwnerByPath) if (workspaceKey(owner) === target) sessionOwnerByPath.delete(path);
	}));
	handleRendererInvoke(IPC_CHANNELS.agentInit, (_event, cwd: string) => activateWorkspace(cwd, true));
	handleRendererInvoke(IPC_CHANNELS.agentSnapshot, (event) => agentFor(event).getSnapshot());
	handleRendererInvoke(IPC_CHANNELS.agentResidentSnapshot, (_event, scope: { cwd: string; sessionId: string; sessionPath: string | null }) => agentService.getResidentSessionSnapshot(scope));
	handleRendererInvoke(IPC_CHANNELS.agentActivateResident, (_event, scope: { cwd: string; sessionId: string; sessionPath: string | null }) => queueWorkspaceActivation(async () => {
		const snapshot = await agentService.getResidentSessionSnapshot(scope);
		if (!snapshot) return false;
		if (snapshot.sessionPath && automationExecutor.isSessionRunning(snapshot.sessionPath)) throw new Error('自动化仍在运行，请结束后再打开会话');
		if (scope.cwd !== activeWorkspace) await workbenchService?.reset();
		const previous = activeWorkspace;
		activeWorkspace = scope.cwd;
		try {
			if (!await agentService.activateResidentSession(scope)) { activeWorkspace = previous; return false; }
		} catch (error) { activeWorkspace = previous; throw error; }
		await saveWorkspaceAsync(scope.cwd, false);
		await markSessionRead(snapshot.sessionPath);
		return true;
	}));
	let diagnosticWindowStart = 0, diagnosticCount = 0;
	handleRendererInvoke(IPC_CHANNELS.uiDiagnostic, (_event, value: unknown) => {
		const diagnostic = normalizeUiDiagnostic(value);
		if (!diagnostic) throw new Error('Invalid UI diagnostic');
		if (Date.now() - diagnosticWindowStart > 60_000) { diagnosticWindowStart = Date.now(); diagnosticCount = 0; }
		if (++diagnosticCount > 240) return;
		recordDiagnostic({ stage: 'renderer', action: diagnostic.kind, outcome: diagnostic.outcome === 'cancelled' ? 'exit' : diagnostic.outcome, durationMs: diagnostic.durationMs, ui: diagnostic });
	});
	handleRendererInvoke(IPC_CHANNELS.agentHistoryPage, (event, offset: unknown, limit: unknown) => {
		const pageOffset = typeof offset === 'number' ? offset : Number.NaN;
		const pageLimit = typeof limit === 'number' ? limit : Number.NaN;
		if (!Number.isInteger(pageOffset) || !Number.isInteger(pageLimit) || pageOffset < 0 || pageLimit < 1 || pageLimit > 500) throw new Error('历史分页参数无效');
		return agentFor(event).getHistoryPage(pageOffset, pageLimit);
	});
	handleRendererInvoke(IPC_CHANNELS.agentSessionStats, (event) => agentFor(event).getSessionStats());
	handleRendererInvoke(IPC_CHANNELS.agentMessageAttachment, (event, sessionPath: unknown, messageId: unknown, index: unknown) => {
		if (typeof sessionPath !== 'string' || !sessionPath || sessionPath.length > 32768 || typeof messageId !== 'string' || !messageId || messageId.length > 256 || typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 999) throw new Error('附件参数无效');
		return agentFor(event).getMessageAttachment(sessionPath, messageId, index);
	});
	handleRendererInvoke(IPC_CHANNELS.agentExportSession, async (event, format: unknown) => {
		const kind = format === 'html' ? 'html' : format === 'jsonl' ? 'jsonl' : null;
		if (!kind) throw new Error('导出格式无效');
		const win = invokingWindow(event);
		if (event.senderFrame !== win.webContents.mainFrame) throw new Error('Invalid export sender');
		const snapshot = await agentFor(event).getSnapshot();
		const baseName = (snapshot.sessionPath ? basename(snapshot.sessionPath).replace(/\.jsonl$/i, '') : snapshot.sessionId ?? 'session').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'session';
		const filters = [{ name: kind.toUpperCase(), extensions: [kind] }];
		const choice = await dialog.showSaveDialog(win, { defaultPath: `${baseName}.${kind}`, filters });
		if (choice.canceled || !choice.filePath) return null;
		return agentFor(event).exportSession(choice.filePath, kind);
	});
	handleRendererInvoke(IPC_CHANNELS.agentSessionTree, (event) => agentFor(event).getSessionTree());
	handleRendererInvoke(IPC_CHANNELS.agentSwitchBranch, (event, entryId: unknown) => {
		if (typeof entryId !== 'string' || !entryId.trim()) throw new Error('目标条目无效');
		return agentFor(event).switchSessionBranch(entryId);
	});
	handleRendererInvoke(IPC_CHANNELS.agentListSessions, async (_event, cwd?: string) => {
		const targetCwd = cwd ?? activeWorkspace;
		if (targetCwd && !(await listWorkspaces()).includes(targetCwd)) throw new Error('未知工作区');
		const sessions = (await agentService.listSessions(targetCwd)).filter((session) => !automationExecutor.isSessionRunning(session.path));
		for (const session of sessions) rememberSessionOwner(session.path, targetCwd);
		const meta = await withSessionMeta(async (value) => {
			if (Date.now() - lastSessionMetaPrune >= 5 * 60_000) {
				const livePaths = new Set(sessions.map((session) => session.path));
				if (activeSessionPath) livePaths.add(activeSessionPath);
				for (const path of Object.keys(value)) if (automationExecutor.isSessionRunning(path)) livePaths.add(path);
				if (await pruneMissingSessionMeta(value, livePaths)) await saveSessionMeta(value);
				lastSessionMetaPrune = Date.now();
			}
			return value;
		});
		return sessions.map((session) => ({ ...session, ...meta[session.path] }));
	});
	handleRendererInvoke(IPC_CHANNELS.agentSearchSessions, async (_event, query: string) => {
		const request = ++sessionSearchRequest;
		const workspaces = await listWorkspaces();
		if (request !== sessionSearchRequest) return { sessions: [], truncated: true };
		const result = await agentService.searchSessions(workspaces, query);
		const meta = await withSessionMeta((value) => value);
		for (const session of result.sessions) rememberSessionOwner(session.path, session.cwd);
		return { ...result, sessions: result.sessions.filter((session) => !automationExecutor.isSessionRunning(session.path)).map((session) => ({ ...session, ...meta[session.path] })) };
	});
	handleRendererInvoke(IPC_CHANNELS.workspaceSearchFiles, async (_event, query: string, options?: { includeDirectories?: boolean }) => agentService.searchWorkspaceFiles(activeWorkspace, query, options));
	handleRendererInvoke(IPC_CHANNELS.contextRead, async (_event, request: unknown) => {
		validateContextRequest(request);
		if (!(await listWorkspaces()).includes(request.workspace)) throw new Error('未知工作区');
		if (request.kind !== 'session') return readWorkspaceContext(request);
		if (await requireSessionOwner(request.path) !== request.workspace) throw new Error('会话不属于此工作区');
		return agentService.readSessionContext(request.workspace, request.path);
	});
	// zcode session context menu: reveal the conversation file in the OS file
	// manager. Only an existing file on disk is revealed; nothing is opened.
	handleRendererInvoke(IPC_CHANNELS.sessionRevealFile, async (_event, path: string) => {
		const target = normalizeSessionPath(path);
		// Defense in depth on top of sender validation: conversation files are
		// always .jsonl, so nothing else on disk may be revealed through this route.
		if (!/\.jsonl$/i.test(target)) throw new Error('会话路径无效');
		const info = await stat(target);
		if (!info.isFile()) throw new Error('会话文件不存在');
		shell.showItemInFolder(target);
	});
	handleRendererInvoke(IPC_CHANNELS.sessionFork, (_event, path: string, name?: string) => queueWorkspaceActivation(async () => {
		path = normalizeSessionPath(path);
		if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 200 || /[\u0000-\u001f\u007f]/u.test(name))) throw new Error('会话名称无效');
		const owner = await requireSessionOwner(path);
		return agentService.forkSession(path, owner, name?.trim());
	}));
	handleRendererInvoke(IPC_CHANNELS.sessionOpenWindow, async (_event, path: string) => {
		const target = normalizeSessionPath(path);
		if (!/\.jsonl$/i.test(target)) throw new Error('会话路径无效');
		if (!(await stat(target)).isFile()) throw new Error('会话文件不存在');
		const owner = await requireSessionOwner(target);
		if (!statSync(owner, { throwIfNoEntry: false })?.isDirectory()) throw new Error('会话所属的工作区已不存在');
		// A hosted pai window owns its own agent host and keeps running after
		// the main window that opened it closes.
		openPaiWindow({ cwd: owner, sessionPath: target });
	});
	handleRendererInvoke(IPC_CHANNELS.agentSwitchSession, (_event, path: string) => queueWorkspaceActivation(async () => {
		path = normalizeSessionPath(path);
		if (automationExecutor.isSessionRunning(path)) throw new Error('自动化仍在运行，请结束后再打开会话');
		if (new Set(paiHeldSessionPaths()).has(path)) throw new Error('会话已在 pai 小窗中打开，请先关闭该小窗');
		await agentService.switchSession(path);
		await markSessionRead(path);
	}));
	handleRendererInvoke(IPC_CHANNELS.agentUpdateSessionMeta, (_event, path: string, patch: UiSessionMetaPatch) => queueWorkspaceActivation(async () => {
		path = normalizeSessionPath(path);
		if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('会话更新参数无效');
		if (patch.name !== undefined && (typeof patch.name !== 'string' || !patch.name.trim() || patch.name.trim().length > 200 || /[\u0000-\u001f\u007f]/u.test(patch.name))) throw new Error('会话名称无效');
		const metaKeys = ['pinned', 'archived', 'unread'] as const;
		for (const key of metaKeys) {
			if (patch[key] !== undefined && typeof patch[key] !== 'boolean') throw new Error('会话状态无效');
		}
		if (patch.order !== undefined && patch.order !== null && (!Number.isInteger(patch.order) || Math.abs(patch.order) > 1e9)) throw new Error('会话顺序无效');
		if (patch.expectedUnreadAt !== undefined && (!Number.isSafeInteger(patch.expectedUnreadAt) || patch.expectedUnreadAt < 0)) throw new Error('会话状态无效');
		const owner = await requireSessionOwner(path, patch.name !== undefined);
		if (patch.name !== undefined) await agentService.renameSession(path, patch.name, owner);
		if (!metaKeys.some((key) => patch[key] !== undefined) && patch.order === undefined) return;
		await withSessionMeta(async (meta) => {
			const next: SessionMeta = { ...meta[path] };
			// zcode clearTaskUnreadIfMatches: compare and write inside the same serialized
			// meta transaction. A clear whose expected watermark is older than the
			// persisted one (a fresher background unread arrived after the renderer's
			// snapshot) misses and leaves the dot in place; other fields still apply.
			const clearBlocked = patch.unread === false && patch.expectedUnreadAt !== undefined
				&& (next.unreadAt ?? 0) > patch.expectedUnreadAt;
			for (const key of metaKeys) {
				if (key === 'unread' && clearBlocked) continue;
				if (patch[key] !== undefined) {
					next[key] = patch[key];
				}
			}
			if (patch.unread === false && !clearBlocked) next.unreadAt = undefined;
			if (patch.order === null) delete next.order;
			else if (patch.order !== undefined) next.order = patch.order;
			meta[path] = next;
			await saveSessionMeta(meta);
		});
	}));
	registerDataFeaturesIpc({
		getWorkspace: () => activeWorkspace, getWorkspaces: listWorkspaces,
		searchSessions: async request => {
			const workspaces = await listWorkspaces();
			const result = await agentService.searchSessionsPage(workspaces, request, await withSessionMeta(value => Object.fromEntries(Object.entries(value).map(([path, meta]) => [path, { ...meta, order: meta.order ?? undefined }]))), workspaces.flatMap(cwd => automationExecutor.sessionPaths(cwd)));
			for (const session of result.sessions) rememberSessionOwner(session.path, session.cwd);
			return result;
		},
		searchFiles: (cwd, request) => agentService.searchProjectFiles(cwd, request),
		cancelSearch: id => agentService.cancelDataSearch(id),
	});
	// Session management page: every transcript under the local pi sessions root,
	// including workspaces the app has never opened (native pi's listAll scope).
	handleRendererInvoke(DATA_FEATURE_CHANNELS.listMachineSessions, () => queueWorkspaceActivation(async () => {
		const [known, meta, runtimeSnapshot, sessions] = await Promise.all([
			listWorkspaces().then(value => new Set(value)),
			withSessionMeta(value => value),
			agentService.getSnapshot(),
			SessionManager.listAll(),
		]);
		const running = new Set([...(runtimeSnapshot.sessionRuntimes?.filter(item => !['idle', 'failed'].includes(item.runtime.phase)).map(item => item.path) ?? []), ...paiHeldSessionPaths()]);
		const rows: UiMachineSessionSummary[] = [];
		for (const session of sessions) {
			if (!session.cwd) continue;
			const flags = meta[session.path];
			rows.push({
				path: session.path, id: session.id, name: session.name, firstMessage: session.firstMessage,
				modified: session.modified.toISOString(), messageCount: session.messageCount,
				...(flags?.pinned !== undefined ? { pinned: flags.pinned } : {}),
				...(flags?.archived !== undefined ? { archived: flags.archived } : {}),
				...(flags?.unread !== undefined ? { unread: flags.unread } : {}),
				cwd: session.cwd, registered: known.has(session.cwd),
				running: running.has(session.path) || automationExecutor.isSessionRunning(session.path),
				bytes: await stat(session.path).then(value => value.size).catch(() => 0),
			});
		}
		rows.sort((a, b) => b.modified.localeCompare(a.modified));
		return rows;
	}));
	handleRendererInvoke(IPC_CHANNELS.sessionDelete, (event, path: unknown) => queueWorkspaceActivation(async () => {
		const win = invokingWindow(event);
		if (event.senderFrame !== win.webContents.mainFrame) throw new Error('Invalid session-delete sender');
		const target = normalizeSessionPath(path);
		const owner = await requireSessionOwner(target);
		if (automationExecutor.isSessionRunning(target)) throw new Error('自动化仍在运行，请结束后再删除会话');
		// Deleting the loaded session is rejected: the renderer switches to a fresh one first (3.3).
		const snapshot = await agentService.getSnapshot();
		if (snapshot.sessionPath === target) throw new Error('不能删除当前打开的会话');
		await agentService.prepareSessionDeletion(target, owner);
		try {
			// Native pi semantics: deleting a conversation unlinks its transcript directly.
			// There is no app trash and no recovery; only the file itself is removed.
			await rm(target, { force: true });
			sessionOwnerByPath.delete(target);
			await withSessionMeta(async (meta) => {
				delete meta[target];
				await saveSessionMeta(meta);
			});
			await sessionGroupService?.removeSession(target);
		} finally {
			await agentService.releaseSessionDeletion(target);
		}
	}));
	handleRendererInvoke(IPC_CHANNELS.agentUpdateSessionOrders, async (_event, entries: { path: string; order: number | null }[]) => {
		if (!Array.isArray(entries) || entries.length === 0 || entries.length > 500
			|| !entries.every((entry) => isRecord(entry) && typeof entry.path === 'string' && entry.path.length > 0 && entry.path.length <= 32768 && !entry.path.includes('\0')
				&& (entry.order === null || (typeof entry.order === 'number' && Number.isInteger(entry.order) && Math.abs(entry.order) <= 1e9)))) throw new Error('会话顺序参数无效');
		entries = entries.map((entry) => ({ ...entry, path: normalizeSessionPath(entry.path) }));
		await requireSessionOwners(entries.map((entry) => entry.path));
		await withSessionMeta(async (meta) => {
			for (const entry of entries) {
				if (entry.order === null) {
					if (meta[entry.path] === undefined) continue;
					const next = { ...meta[entry.path] };
					delete next.order;
					meta[entry.path] = next;
				} else {
					meta[entry.path] = { ...meta[entry.path], order: entry.order };
				}
			}
			await saveSessionMeta(meta);
		});
	});
	handleRendererInvoke(IPC_CHANNELS.agentListModels, (event) => agentFor(event).listModels());
	handleRendererInvoke(IPC_CHANNELS.agentListModelProviders, (event) => agentFor(event).listModelProviders());
	handleRendererInvoke(IPC_CHANNELS.agentDiscoverProviderModels, (event, request: Parameters<typeof agentService.discoverProviderModels>[0]) => {
		requireTrustedSender(event);
		return agentFor(event).discoverProviderModels(request);
	});
	handleRendererInvoke(IPC_CHANNELS.agentSaveCustomProvider, async (event, request: Parameters<typeof agentService.saveCustomProvider>[0]) => {
		await agentFor(event).saveCustomProvider(request);
		// Auto-sync mirrors cc-switch: every provider-database change re-uploads.
		cloudSync?.service.onProviderDatabaseChanged();
	});
	handleRendererInvoke(IPC_CHANNELS.agentRemoveCustomProvider, async (event, provider: string) => {
		await agentFor(event).removeCustomProvider(provider);
		cloudSync?.service.onProviderDatabaseChanged();
	});
	handleRendererInvoke(IPC_CHANNELS.agentSaveProviderModels, async (event, request: Parameters<typeof agentService.saveProviderModels>[0]) => {
		await agentFor(event).saveProviderModels(request);
		cloudSync?.service.onProviderDatabaseChanged();
	});
	handleRendererInvoke(IPC_CHANNELS.agentListSlashCommands, (event) => agentFor(event).listSlashCommands());
	handleRendererInvoke(IPC_CHANNELS.agentExecuteSlashCommand, (event, request: UiSlashCommandRequest) => {
		if (request?.name === 'reload') {
			requirePluginSender(event);
			return withPluginMutation(request.cwd, () => agentService.executeSlashCommand(request));
		}
		return agentFor(event).executeSlashCommand(request);
	});
	handleRendererInvoke(IPC_CHANNELS.agentSetModel, (event, provider: string, id: string) => agentFor(event).setModel(provider, id));
	handleRendererInvoke(IPC_CHANNELS.agentSetThinkingLevel, (event, level: UiThinkingLevel) => agentFor(event).setThinkingLevel(level));
	handleRendererInvoke(IPC_CHANNELS.agentListProviderAuth, (event) => agentFor(event).listProviderAuth());
	handleRendererInvoke(IPC_CHANNELS.agentSetProviderApiKey, async (event, provider: string, key: string) => {
		await agentFor(event).setProviderApiKey(provider, key);
		cloudSync?.service.onProviderDatabaseChanged();
	});
	handleRendererInvoke(IPC_CHANNELS.agentRemoveProviderCredential, async (event, provider: string) => {
		await agentFor(event).removeProviderCredential(provider);
		cloudSync?.service.onProviderDatabaseChanged();
	});
	handleRendererInvoke(IPC_CHANNELS.agentSetModelEnabled, async (event, provider: unknown, modelId: unknown, enabled: unknown) => {
		if (typeof provider !== 'string' || !provider.trim() || provider.length > 80 || /[\u0000]/u.test(provider)
			|| typeof modelId !== 'string' || !modelId.trim() || modelId.trim().length > 200 || /[\u0000]/u.test(modelId)
			|| typeof enabled !== 'boolean') throw new Error('模型启用参数无效');
		await agentFor(event).setModelEnabled(provider, modelId.trim(), enabled);
		cloudSync?.service.onProviderDatabaseChanged();
	});
	handleRendererInvoke(IPC_CHANNELS.agentListExtensions, (event) => agentFor(event).listExtensions());
	handleRendererInvoke(IPC_CHANNELS.agentSetExtensionEnabled, (event, path: string, enabled: boolean) => {
		requirePluginSender(event);
		return withPluginMutation(activeWorkspace, () => agentService.setExtensionEnabled(path, enabled));
	});

	handleRendererInvoke(IPC_CHANNELS.agentPrompt, async (event, text: string, behavior?: 'steer' | 'followUp', attachments?: UiAttachment[]) => {
		await agentFor(event).prompt(text, behavior, attachments);
	});

	handleRendererInvoke(IPC_CHANNELS.agentEditMessage, async (event, entryId: string, text: string, attachments?: UiAttachment[]) => {
		await agentFor(event).editUserMessage(entryId, text, attachments);
	});

	handleRendererInvoke(IPC_CHANNELS.agentForkMessage, async (event, entryId: string) => {
		if (typeof entryId !== 'string' || !entryId.trim() || entryId.length > 512 || entryId.includes('\0')) throw new Error('消息标识无效');
		await agentFor(event).forkAssistantMessage(entryId);
	});

	handleRendererInvoke(IPC_CHANNELS.agentUpdateQueuedMessage, async (event, id: string, action: 'edit' | 'remove' | 'steer', text?: string) => {
		if (typeof id !== 'string' || !id.trim() || id.length > 512 || id.includes('\0')) throw new Error('排队消息标识无效');
		if (action !== 'edit' && action !== 'remove' && action !== 'steer') throw new Error('排队消息操作无效');
		if (action === 'edit' && (typeof text !== 'string' || !text.trim() || text.length > 256 * 1024 || text.includes('\0'))) throw new Error('排队消息内容无效');
		await agentFor(event).updateQueuedMessage(id, action, action === 'edit' ? text : undefined);
	});

	handleRendererInvoke(IPC_CHANNELS.agentGenerateCommitMessage, (event, context: string) => {
		if (typeof context !== 'string' || !context.trim() || context.length > 256 * 1024) throw new Error('提交上下文无效或过长');
		return agentFor(event).generateCommitMessage(context);
	});

	handleRendererInvoke(IPC_CHANNELS.agentAbort, (event) => agentFor(event).abort());

	handleRendererInvoke(IPC_CHANNELS.agentNewSession, (_event, options?: unknown) => newConversation(options));
	handleRendererInvoke(IPC_CHANNELS.agentExtensionDialogPending, (event) => [...pendingDialogs.values()]
		.filter(({ owner }) => owner === invokingWindow(event)).map(({ request }) => request));
	handleRendererInvoke(IPC_CHANNELS.agentExtensionDialogResponse, (event, id: string, value: unknown) => {
		if (typeof id !== 'string') throw new Error('交互结果无效');
		const pending = pendingDialogs.get(id);
		if (pending && pending.owner.webContents === event.sender) pending.resolve(requireDialogResponse(pending.request, value));
	});
}

export function disposeServices(): Promise<void> {
	if (serviceShutdown) return serviceShutdown;
	disposingServices = true;
	updateService.stop();
	stopAppearanceWatch?.();
	keepAwake?.dispose();
	stopAppearanceWatch = null;
	destroyAppTray();
	for (const queue of startupNotifications.values()) queue.cleanup();
	for (const pending of pendingDialogs.values()) pending.resolve(null);
	if (automaticRecoveryTimer) clearTimeout(automaticRecoveryTimer);
	automaticRecoveryTimer = null;
	return serviceShutdown = (async () => {
		// Finish an accepted file move before terminating its host or exiting.
		await workspaceActivationQueue;
		await desktopSettingsQueue;
		await workspaceSettingsQueue;
		// A pending move may still need the agent to validate session ownership.
		await sessionGroupService?.flush();
		// Hosted pai windows and their agent hosts go first: their metadata may
		// still be queued on the shared session-meta pipeline below.
		await disposeAllPaiWindows();
		inputFeatures?.dispose();
		// Flush a pending auto-sync upload before the agent host goes away.
		await cloudSync?.dispose();
		cloudSync = null;
		await debugApi?.dispose();
		debugApi = null;
		const results = await Promise.allSettled([agentService.dispose(), workbenchService?.dispose(), workbenchFeatures?.dispose(), automationService?.dispose()]);
		// A failed service must not let app.quit interrupt another service's
		// cleanup or metadata that was queued by its final activity events.
		await sessionMetaQueue;
		await flushDiagnostics();
		const failure = results.find((result) => result.status === 'rejected');
		if (failure?.status === 'rejected') throw failure.reason;
	})();
}
