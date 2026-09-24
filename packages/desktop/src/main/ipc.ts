/**
 * IPC wiring: renderer ⇄ main ⇄ AgentService.
 *
 * All agent events fan out to every renderer window; every renderer→main call
 * is a typed invoke against the contract in @pidesktop/shared.
 */

import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { IPC_CHANNELS, type AgentEventEnvelope, type AppLocale, type UiAttachment, type UiExtensionDialogRequest, type UiSessionMetaPatch, type UiSidebarGroupChange, type UiSlashCommandRequest, type UiThinkingLevel } from '@pidesktop/shared';
import { createIsolatedAgentService } from './agentClient';
import { getAppLocale, setAppLocale } from './appLocale';
import { updateService } from './updateService';
export { updateService } from './updateService';
import { registerWorkbenchIpc } from './workbenchIpc';
import type { WorkbenchService } from './workbenchService';
import { backupCorruptStateFile, backupCorruptStateFileAsync, CorruptStateFileError, readStateFile, readStateFileAsync, writeStateFile, writeStateFileAsync } from './stateFiles';
import { SessionGroupService } from './sessionGroups';
import { readWorkspaceContext, validateContextRequest } from './contextService';
import { createAutomationService } from './automationService';
import { createAutomationExecutor } from './automationExecutor';
import { createPluginDiscovery } from './pluginDiscovery';
import type { UiPluginMutation, UiPluginResourceKind, UiPluginScope } from '@pidesktop/shared';

type PendingDialog = {
	request: UiExtensionDialogRequest;
	owner: BrowserWindow;
	resolve: (value: string | boolean | null) => void;
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
let workbenchService: WorkbenchService | null = null;
let disposingServices = false;
let serviceShutdown: Promise<void> | null = null;
let activeSessionPath: string | null = null;
const pendingUnreadPaths = new Set<string>();
let workspaceActivationQueue: Promise<void> = Promise.resolve();
let automaticRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
let sessionSearchRequest = 0;
let sessionGroupService: SessionGroupService | null = null;
let automationService: ReturnType<typeof createAutomationService> | null = null;
let pluginMutationActive = false;
const discoverPlugins = createPluginDiscovery();
const automationExecutor = createAutomationExecutor({ withSessionSetup: (action) => queueWorkspaceActivation(action) });

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

function requestExtensionDialog(request: UiExtensionDialogRequest, signal?: AbortSignal): Promise<string | boolean | null> {
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
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (value: string | boolean | null): void => {
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
	});
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
			const excluded = automationExecutor.sessionPaths(cwd);
			await agentService.init(excluded.length ? { cwd, excludeSessionPaths: excluded } : { cwd });
			if (sessionPath && (await agentService.listSessions(cwd)).some((session) => session.path === sessionPath)) {
				await agentService.switchSession(sessionPath);
			}
		}).catch((error: unknown) => {
			console.error('Pi agent recovery failed:', error);
		});
	}, 250);
} });

interface WorkspaceSettings { cwd?: string; workspaces?: string[] }
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
		&& (value.workspaces === undefined || (Array.isArray(value.workspaces) && value.workspaces.every((cwd) => typeof cwd === 'string')));
}

function readWorkspaceSettings(): WorkspaceSettings {
	return readStateFile(workspaceSettingsPath(), () => ({}), isWorkspaceSettings);
}

function readWorkspaceSettingsAsync(): Promise<WorkspaceSettings> {
	return readStateFileAsync(workspaceSettingsPath(), () => ({}), isWorkspaceSettings);
}

function workspaceSettingsPath(): string {
	return join(app.getPath('userData'), 'workspace.json');
}

export function defaultWorkspace(): string {
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
	const cwd = join(app.getPath('home'), 'PiDesktopWorkspace');
	saveWorkspace(cwd);
	activeWorkspace = cwd;
	return cwd;
}

function saveWorkspace(cwd: string): void {
	const previous = readWorkspaceSettings();
	const workspaces = [...new Set([...(Array.isArray(previous.workspaces) ? previous.workspaces : []), previous.cwd, cwd]
		.filter((value): value is string => typeof value === 'string' && value.length > 0))];
	writeStateFile(workspaceSettingsPath(), { cwd, workspaces });
}

async function saveWorkspaceAsync(cwd: string): Promise<void> {
	const previous = await readWorkspaceSettingsAsync();
	const workspaces = [...new Set([...(Array.isArray(previous.workspaces) ? previous.workspaces : []), previous.cwd, cwd]
		.filter((value): value is string => typeof value === 'string' && value.length > 0))];
	await writeStateFileAsync(workspaceSettingsPath(), { cwd, workspaces });
}

async function listWorkspaces(): Promise<string[]> {
	const saved = await readWorkspaceSettingsAsync();
	const candidates = [...new Set([...(Array.isArray(saved.workspaces) ? saved.workspaces : []), saved.cwd, activeWorkspace]
		.filter((value): value is string => typeof value === 'string' && value.length > 0))];
	const existing = await Promise.all(candidates.map(async (cwd) => {
		try { return (await stat(cwd)).isDirectory(); }
		catch { return false; }
	}));
	return candidates.filter((_, index) => existing[index]);
}

type SessionMeta = Omit<UiSessionMetaPatch, 'name'>;
function sessionMetaPath(): string { return join(app.getPath('userData'), 'sessions-meta.json'); }
function isSessionMeta(value: unknown): value is Record<string, SessionMeta> {
	return isRecord(value) && Object.values(value).every((entry) => isRecord(entry)
		&& ['pinned', 'archived', 'unread'].every((key) => entry[key] === undefined || typeof entry[key] === 'boolean'));
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
	if (typeof path !== 'string' || path.length === 0) throw new Error('会话路径无效');
	if (automationExecutor.isSessionRunning(path)) throw new Error('自动化仍在运行，请结束后再打开会话');
	// Only explicit naming may materialize a currently loaded, unsaved session.
	// Snapshot identity is trusted host state; the agent rechecks its runtime path.
	const current = allowCurrentDraft ? await agentService.getSnapshot() : null;
	const knownWorkspaces = await listWorkspaces();
	if (current?.sessionId && current.sessionPath === path && knownWorkspaces.includes(current.cwd)) return current.cwd;
	let owner: string | undefined;
	const cached = sessionOwnerByPath.get(path);
	if (cached && knownWorkspaces.includes(cached)
		&& (await agentService.listSessions(cached)).some((session) => session.path === path)) owner = cached;
	else sessionOwnerByPath.delete(path);
	if (!owner) {
		const workspaces = knownWorkspaces.filter((cwd) => cwd !== cached);
		const likely = likelySessionOwners(path, workspaces);
		for (const cwd of likely) {
			if ((await agentService.listSessions(cwd)).some((session) => session.path === path)) { owner = cwd; break; }
		}
		if (!owner) {
			const remaining = workspaces.filter((cwd) => !likely.includes(cwd));
			const owners = await Promise.all(remaining.map(async (cwd) => ({ cwd, sessions: await agentService.listSessions(cwd) })));
			owner = owners.find(({ sessions }) => sessions.some((session) => session.path === path))?.cwd;
		}
		if (owner) rememberSessionOwner(path, owner);
	}
	if (!owner) throw new Error('未找到会话');
	return owner;
}

function activateWorkspace(cwd: string, initialize: boolean): Promise<void> {
	if (pluginMutationActive) return Promise.reject(new Error('插件正在更新，请完成后再切换项目'));
	if (automaticRecoveryTimer) clearTimeout(automaticRecoveryTimer);
	automaticRecoveryTimer = null;
	return queueWorkspaceActivation(() => performWorkspaceActivation(cwd, initialize));
}

function queueWorkspaceActivation(action: () => Promise<void>): Promise<void> {
	const result = workspaceActivationQueue.then(() => {
		if (disposingServices) throw new Error('Pi agent is shutting down');
		return action();
	});
	workspaceActivationQueue = result.catch(() => {});
	return result;
}

async function performWorkspaceActivation(cwd: string, initialize: boolean): Promise<void> {
	if (typeof cwd !== 'string') throw new Error('未知工作区');
	const saved = await readWorkspaceSettingsAsync();
	const known = [activeWorkspace, saved.cwd, ...(saved.workspaces ?? [])];
	if (!known.includes(cwd) && !pickedWorkspaces.has(cwd)) throw new Error('未知工作区');
	try { if (!(await stat(cwd)).isDirectory()) throw new Error('工作区目录无效'); }
	catch { throw new Error('工作区目录无效'); }
	if (cwd !== activeWorkspace) await workbenchService?.reset();
	const previous = activeWorkspace;
	activeWorkspace = cwd;
	try {
		const excludeSessionPaths = automationExecutor.sessionPaths(cwd);
		if (initialize) await agentService.init(excludeSessionPaths.length ? { cwd, excludeSessionPaths } : { cwd });
		else if (excludeSessionPaths.length) await agentService.switchWorkspace(cwd, excludeSessionPaths);
		else await agentService.switchWorkspace(cwd);
	} catch (error) {
		activeWorkspace = previous;
		throw error;
	}
	await saveWorkspaceAsync(cwd);
	pickedWorkspaces.delete(cwd);
	await markSessionRead((await agentService.getSnapshot()).sessionPath);
}

async function markSessionRead(path: string | null): Promise<void> {
	if (!path) return;
	await withSessionMeta(async (meta) => {
		if (!meta[path]?.unread) return;
		meta[path] = { ...meta[path], unread: false };
		await saveSessionMeta(meta);
	});
}

function invokingWindow(event: IpcMainInvokeEvent): BrowserWindow {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (!win || win.isDestroyed()) throw new Error('The requesting window is no longer available.');
	return win;
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

export function registerIpc(options: {
	onRendererReady?(win: BrowserWindow): void;
	getDialogWindow?(): BrowserWindow | undefined;
} = {}): void {
	getDialogWindow = options.getDialogWindow ?? (() => undefined);
	workbenchService = registerWorkbenchIpc(() => activeWorkspace);
	const automations = createAutomationService({
		filePath: join(app.getPath('userData'), 'automations.json'),
		execute: (task, signal) => automationExecutor.execute(task, signal),
		canRun: () => pluginMutationActive ? false : automationExecutor.hasUnreleasedWorkers()
			? '上次自动化执行进程尚未退出，请重启应用后重试' : true,
		validateWorkspace: async (cwd) => {
			if (!(await listWorkspaces()).includes(cwd)) throw new Error('未知工作区，请先在侧栏打开项目');
		},
		onChanged: (snapshot) => {
			const win = getDialogWindow();
			if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(IPC_CHANNELS.automationChanged, snapshot);
		},
		onError: (error) => console.error('Automation scheduler failed:', error),
	});
	automationService = automations;
	ipcMain.handle(IPC_CHANNELS.pluginCatalog, (event, cwd: unknown) => {
		requirePluginSender(event); requirePluginWorkspace(cwd);
		return agentService.getPluginCatalog(cwd);
	});
	ipcMain.handle(IPC_CHANNELS.pluginMutate, (event, input: UiPluginMutation) => {
		requirePluginSender(event);
		if (!isRecord(input)) throw new Error('插件操作参数无效');
		requirePluginWorkspace(input.cwd);
		return withPluginMutation(input.cwd, () => agentService.mutatePlugin(input));
	});
	ipcMain.handle(IPC_CHANNELS.pluginPreview, (event, request: { cwd: string; path: string; kind: UiPluginResourceKind; scope: UiPluginScope }) => {
		requirePluginSender(event);
		if (!isRecord(request)) throw new Error('插件预览参数无效');
		requirePluginWorkspace(request.cwd);
		return agentService.previewPluginResource(request);
	});
	ipcMain.handle(IPC_CHANNELS.pluginPickDirectory, async (event) => {
		const owner = requirePluginSender(event);
		const selected = await dialog.showOpenDialog(owner, {
			properties: ['openDirectory'], title: getAppLocale() === 'en-US' ? 'Choose a Pi plugin directory' : '选择 Pi 插件目录',
		});
		return selected.canceled ? null : selected.filePaths[0] ?? null;
	});
	ipcMain.handle(IPC_CHANNELS.pluginDiscover, (event, query: unknown) => {
		requirePluginSender(event);
		return discoverPlugins(query);
	});
	const automationHandler = (action: (...args: any[]) => unknown) => (event: IpcMainInvokeEvent, ...args: unknown[]) => {
		const owner = getDialogWindow();
		if (disposingServices || !owner || owner.isDestroyed() || owner.webContents.isDestroyed()
			|| event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame) throw new Error('Invalid automation sender');
		return action(...args);
	};
	ipcMain.handle(IPC_CHANNELS.automationSnapshot, automationHandler(() => automations.snapshot()));
	ipcMain.handle(IPC_CHANNELS.automationSave, automationHandler((input) => automations.save(input)));
	ipcMain.handle(IPC_CHANNELS.automationSetEnabled, automationHandler((id, enabled) => automations.setEnabled(id, enabled)));
	ipcMain.handle(IPC_CHANNELS.automationDelete, automationHandler((id) => automations.delete(id)));
	ipcMain.handle(IPC_CHANNELS.automationRun, automationHandler((id) => automations.run(id)));
	ipcMain.handle(IPC_CHANNELS.automationCancelRun, automationHandler((runId) => automations.cancelRun(runId)));
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
	ipcMain.handle(IPC_CHANNELS.rendererReady, (event) => {
		const win = invokingWindow(event);
		if (event.senderFrame !== win.webContents.mainFrame) throw new Error('Invalid renderer-ready sender');
		options.onRendererReady?.(win);
		void automations.start().catch((error: unknown) => {
			if (!disposingServices) console.error('Automation scheduler failed to start:', error);
		});
		if (!win.isDestroyed() && !notificationReadyWindows.has(win)) {
			const queue = notificationsFor(win);
			queue.rendererReady = true;
			queue.flush();
		}
	});
	// Agent events → all renderer windows.
	agentService.onEvent((event: AgentEventEnvelope) => {
		if (event.event.type === 'ready') activeSessionPath = event.event.sessionPath;
		for (const win of BrowserWindow.getAllWindows()) {
			win.webContents.send(IPC_CHANNELS.agentEvent, event);
		}
	});
	agentService.onBackgroundActivity((_, path) => {
		if (pendingUnreadPaths.has(path)) return;
		pendingUnreadPaths.add(path);
		void withSessionMeta(async (meta) => {
			if (meta[path]?.unread) return;
			meta[path] = { ...meta[path], unread: true };
			await saveSessionMeta(meta);
		}).catch((error: unknown) => {
			console.error('Failed to save session activity metadata:', error);
		}).finally(() => pendingUnreadPaths.delete(path));
	});

	ipcMain.handle(IPC_CHANNELS.appInfo, () => ({
		appVersion: app.getVersion(),
		nodeVersion: process.versions.node ?? 'unknown',
		electronVersion: process.versions.electron ?? 'unknown',
		platform: process.platform,
	}));
	ipcMain.handle(IPC_CHANNELS.appSetLocale, (_event, locale: AppLocale) => setAppLocale(locale));
	ipcMain.handle(IPC_CHANNELS.updateState, () => updateService.getState());
	ipcMain.handle(IPC_CHANNELS.updateCheck, () => updateService.check());
	ipcMain.handle(IPC_CHANNELS.updateInstall, () => updateService.install());
	ipcMain.handle(IPC_CHANNELS.windowChromeState, (event) => ({
		isMaximized: invokingWindow(event).isMaximized(),
	}));
	ipcMain.handle(IPC_CHANNELS.windowMinimize, (event) => {
		invokingWindow(event).minimize();
	});
	ipcMain.handle(IPC_CHANNELS.windowToggleMaximize, (event) => {
		const win = invokingWindow(event);
		if (win.isMaximized()) win.unmaximize();
		else win.maximize();
	});
	ipcMain.handle(IPC_CHANNELS.windowClose, (event) => {
		invokingWindow(event).close();
	});

	ipcMain.handle(IPC_CHANNELS.workspacePick, async () => {
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
	ipcMain.handle(IPC_CHANNELS.agentListWorkspaces, () => listWorkspaces());
	ipcMain.handle(IPC_CHANNELS.agentListSessionGroups, () => groups.list());
	ipcMain.handle(IPC_CHANNELS.agentUpdateSessionGroups, (_event, change: UiSidebarGroupChange) => groups.update(change));
	ipcMain.handle(IPC_CHANNELS.workspaceSwitch, (_event, cwd: string) => activateWorkspace(cwd, false));
	ipcMain.handle(IPC_CHANNELS.agentInit, (_event, cwd: string) => activateWorkspace(cwd, true));
	ipcMain.handle(IPC_CHANNELS.agentSnapshot, () => agentService.getSnapshot());
	ipcMain.handle(IPC_CHANNELS.agentListSessions, async (_event, cwd?: string) => {
		const targetCwd = cwd ?? activeWorkspace;
		if (targetCwd && !(await listWorkspaces()).includes(targetCwd)) throw new Error('未知工作区');
		const sessions = (await agentService.listSessions(targetCwd)).filter((session) => !automationExecutor.isSessionRunning(session.path));
		for (const session of sessions) rememberSessionOwner(session.path, targetCwd);
		const meta = await withSessionMeta((value) => value);
		return sessions.map((session) => ({ ...session, ...meta[session.path] }));
	});
	ipcMain.handle(IPC_CHANNELS.agentSearchSessions, async (_event, query: string) => {
		const request = ++sessionSearchRequest;
		const workspaces = await listWorkspaces();
		if (request !== sessionSearchRequest) return { sessions: [], truncated: true };
		const result = await agentService.searchSessions(workspaces, query);
		const meta = await withSessionMeta((value) => value);
		for (const session of result.sessions) rememberSessionOwner(session.path, session.cwd);
		return { ...result, sessions: result.sessions.filter((session) => !automationExecutor.isSessionRunning(session.path)).map((session) => ({ ...session, ...meta[session.path] })) };
	});
	ipcMain.handle(IPC_CHANNELS.workspaceSearchFiles, (_event, query: string, options?: { includeDirectories?: boolean }) => agentService.searchWorkspaceFiles(activeWorkspace, query, options));
	ipcMain.handle(IPC_CHANNELS.contextRead, async (_event, request: unknown) => {
		validateContextRequest(request);
		if (!(await listWorkspaces()).includes(request.workspace)) throw new Error('未知工作区');
		if (request.kind !== 'session') return readWorkspaceContext(request);
		if (await requireSessionOwner(request.path) !== request.workspace) throw new Error('会话不属于此工作区');
		return agentService.readSessionContext(request.workspace, request.path);
	});
	ipcMain.handle(IPC_CHANNELS.agentSwitchSession, async (_event, path: string) => {
		if (automationExecutor.isSessionRunning(path)) throw new Error('自动化仍在运行，请结束后再打开会话');
		await agentService.switchSession(path);
		await markSessionRead(path);
	});
	ipcMain.handle(IPC_CHANNELS.agentUpdateSessionMeta, async (_event, path: string, patch: UiSessionMetaPatch) => {
		if (!patch || typeof patch !== 'object') throw new Error('会话更新参数无效');
		const metaKeys = ['pinned', 'archived', 'unread'] as const;
		for (const key of metaKeys) {
			if (patch[key] !== undefined && typeof patch[key] !== 'boolean') throw new Error('会话状态无效');
		}
		const owner = await requireSessionOwner(path, patch.name !== undefined);
		if (patch.name !== undefined) await agentService.renameSession(path, patch.name, owner);
		if (!metaKeys.some((key) => patch[key] !== undefined)) return;
		await withSessionMeta(async (meta) => {
			const next: SessionMeta = { ...meta[path] };
			for (const key of metaKeys) {
				if (patch[key] !== undefined) {
					next[key] = patch[key];
				}
			}
			meta[path] = next;
			await saveSessionMeta(meta);
		});
	});
	ipcMain.handle(IPC_CHANNELS.agentListModels, () => agentService.listModels());
	ipcMain.handle(IPC_CHANNELS.agentListModelProviders, () => agentService.listModelProviders());
	ipcMain.handle(IPC_CHANNELS.agentSaveCustomProvider, (_event, request: unknown) => agentService.saveCustomProvider(request));
	ipcMain.handle(IPC_CHANNELS.agentRemoveCustomProvider, (_event, provider: string) => agentService.removeCustomProvider(provider));
	ipcMain.handle(IPC_CHANNELS.agentListSlashCommands, () => agentService.listSlashCommands());
	ipcMain.handle(IPC_CHANNELS.agentExecuteSlashCommand, (event, request: UiSlashCommandRequest) => {
		if (request?.name === 'reload') {
			requirePluginSender(event);
			return withPluginMutation(request.cwd, () => agentService.executeSlashCommand(request));
		}
		return agentService.executeSlashCommand(request);
	});
	ipcMain.handle(IPC_CHANNELS.agentSetModel, (_event, provider: string, id: string) => agentService.setModel(provider, id));
	ipcMain.handle(IPC_CHANNELS.agentSetThinkingLevel, (_event, level: UiThinkingLevel) => agentService.setThinkingLevel(level));
	ipcMain.handle(IPC_CHANNELS.agentListProviderAuth, () => agentService.listProviderAuth());
	ipcMain.handle(IPC_CHANNELS.agentSetProviderApiKey, (_event, provider: string, key: string) => agentService.setProviderApiKey(provider, key));
	ipcMain.handle(IPC_CHANNELS.agentRemoveProviderCredential, (_event, provider: string) => agentService.removeProviderCredential(provider));
	ipcMain.handle(IPC_CHANNELS.agentListExtensions, () => agentService.listExtensions());
	ipcMain.handle(IPC_CHANNELS.agentSetExtensionEnabled, (event, path: string, enabled: boolean) => {
		requirePluginSender(event);
		return withPluginMutation(activeWorkspace, () => agentService.setExtensionEnabled(path, enabled));
	});

	ipcMain.handle(IPC_CHANNELS.agentPrompt, async (_event, text: string, behavior?: 'steer' | 'followUp', attachments?: UiAttachment[]) => {
		await agentService.prompt(text, behavior, attachments);
	});

	ipcMain.handle(IPC_CHANNELS.agentAbort, () => agentService.abort());

	ipcMain.handle(IPC_CHANNELS.agentNewSession, () => agentService.newSession());
	ipcMain.handle(IPC_CHANNELS.agentExtensionDialogPending, (event) => [...pendingDialogs.values()]
		.filter(({ owner }) => owner === invokingWindow(event)).map(({ request }) => request));
	ipcMain.handle(IPC_CHANNELS.agentExtensionDialogResponse, (event, id: string, value: string | boolean | null) => {
		if (typeof id !== 'string' || (!['string', 'boolean'].includes(typeof value) && value !== null)) throw new Error('交互结果无效');
		const pending = pendingDialogs.get(id);
		if (pending && pending.owner.webContents === event.sender) pending.resolve(value);
	});
}

export function disposeServices(): Promise<void> {
	if (serviceShutdown) return serviceShutdown;
	disposingServices = true;
	for (const queue of startupNotifications.values()) queue.cleanup();
	for (const pending of pendingDialogs.values()) pending.resolve(null);
	if (automaticRecoveryTimer) clearTimeout(automaticRecoveryTimer);
	automaticRecoveryTimer = null;
	return serviceShutdown = (async () => {
		// A pending move may still need the agent to validate session ownership.
		await sessionGroupService?.flush();
		const results = await Promise.allSettled([agentService.dispose(), workbenchService?.dispose(), automationService?.dispose()]);
		// A failed service must not let app.quit interrupt another service's
		// cleanup or metadata that was queued by its final activity events.
		await sessionMetaQueue;
		const failure = results.find((result) => result.status === 'rejected');
		if (failure?.status === 'rejected') throw failure.reason;
	})();
}
