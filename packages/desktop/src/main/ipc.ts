import { MCP_FEATURE_CHANNELS, PLUGIN_UPDATE_CHANNELS } from '@pidesktop/shared';
import { registerManagementIpc } from './managementIpc';
/**
 * IPC wiring: renderer ⇄ main ⇄ AgentService.
 *
 * All agent events fan out to every renderer window; every renderer→main call
 * is a typed invoke against the contract in @pidesktop/shared.
 */

import { app, BrowserWindow, dialog, type IpcMainInvokeEvent } from 'electron';
import { mkdirSync, statSync } from 'node:fs';
import { lstat, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { IPC_CHANNELS, type AgentEventEnvelope, type AppLocale, type UiAppCommand, type UiAttachment, type UiExtensionDialogRequest, type UiSessionMetaPatch, type UiSidebarGroupChange, type UiSlashCommandRequest, type UiThinkingLevel } from '@pidesktop/shared';
import { createIsolatedAgentService } from './agentClient';
import { getAppLocale, setAppLocale } from './appLocale';
import { destroyAppTray, invalidateAppTrayData, updateAppTrayMenu } from './tray';
import { updateService } from './updateService';
export { updateService } from './updateService';
import { registerWorkbenchIpc } from './workbenchIpc';
import type { WorkbenchService } from './workbenchService';
import { backupCorruptStateFile, backupCorruptStateFileAsync, CorruptStateFileError, readStateFile, readStateFileAsync, writeStateFile, writeStateFileAsync } from './stateFiles';
import { SessionGroupService } from './sessionGroups';
import { createSessionTrash } from './sessionTrash';
import { broadcastToRenderers, handleRendererInvoke, requireRendererSender } from './rendererIpc';
import { normalizeSessionPath, pruneMissingSessionMeta } from './sessionPaths';
import { createDesktopNotifier } from './notifications';
import { readDesktopSettings, writeDesktopSettings, type DesktopSettings } from './desktopSettings';
import { readWorkspaceContext, validateContextRequest } from './contextService';
import { createAutomationService } from './automationService';
import { createAutomationExecutor } from './automationExecutor';
import { createPluginDiscovery } from './pluginDiscovery';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { registerWorkbenchFeatureIpc } from './workbenchFeatureIpc';
import { registerInputAttachmentIpc } from './inputAttachmentIpc';
import { inputScopeKey } from '../../../agent/src/attachmentStore.ts';
import { registerDataFeaturesIpc } from './dataFeaturesIpc';
import { INPUT_FEATURE_CHANNELS, WORKBENCH_FEATURE_CHANNELS, MANAGEMENT_FEATURE_CHANNELS, requireInputQueueScope, type RecoverableSessionMetadata } from '@pidesktop/shared';
import type { UiPluginMutation, UiPluginResourceKind, UiPluginScope, UiSaveInstructionRequest } from '@pidesktop/shared';

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
let workbenchFeatures: ReturnType<typeof registerWorkbenchFeatureIpc> | null = null;
let managementFeatures: ReturnType<typeof registerManagementIpc> | null = null;
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
const automationExecutor = createAutomationExecutor({ withSessionSetup: (action) => queueWorkspaceActivation(action), onSessionCreated: async (path, task) => { await managementFeatures?.rememberAutomation(path, task.id); } });

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

interface WorkspaceSettings { cwd?: string; workspaces?: string[]; pinnedWorkspaces?: string[] }
function workspaceKey(cwd: string): string {
	const key = resolve(cwd);
	return process.platform === 'win32' ? key.toLowerCase() : key;
}
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
		&& (value.pinnedWorkspaces === undefined || (Array.isArray(value.pinnedWorkspaces) && value.pinnedWorkspaces.every((cwd) => typeof cwd === 'string')));
}

function readWorkspaceSettings(): WorkspaceSettings {
	return readStateFile(workspaceSettingsPath(), () => ({}), isWorkspaceSettings);
}

function readWorkspaceSettingsAsync(): Promise<WorkspaceSettings> {
	return readStateFileAsync(workspaceSettingsPath(), () => ({}), isWorkspaceSettings);
}

let workspaceSettingsQueue: Promise<void> = Promise.resolve();
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
	return readDesktopSettings(desktopSettingsPath());
}

/** Persists a close-policy choice made from the close dialog (4.2). */
export function saveCloseBehavior(behavior: DesktopSettings['closeBehavior']): void {
	const current = readDesktopSettings(desktopSettingsPath());
	writeDesktopSettings(desktopSettingsPath(), { ...current, closeBehavior: behavior });
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
	writeStateFile(workspaceSettingsPath(), { cwd, workspaces, pinnedWorkspaces: previous.pinnedWorkspaces ?? [] });
}

async function saveWorkspaceAsync(cwd: string): Promise<void> {
	await withWorkspaceSettings(async (previous) => {
		const workspaces = [...new Set([...(Array.isArray(previous.workspaces) ? previous.workspaces : []), previous.cwd, cwd]
			.filter((value): value is string => typeof value === 'string' && value.length > 0))];
		await writeStateFileAsync(workspaceSettingsPath(), { cwd, workspaces, pinnedWorkspaces: previous.pinnedWorkspaces ?? [] });
	});
}

async function listWorkspaces(): Promise<string[]> {
	await workspaceSettingsQueue;
	const saved = await readWorkspaceSettingsAsync();
	const candidates = [...new Set([...(Array.isArray(saved.workspaces) ? saved.workspaces : []), saved.cwd, activeWorkspace]
		.filter((value): value is string => typeof value === 'string' && value.length > 0))];
	const existing = await Promise.all(candidates.map(async (cwd) => {
		try { return (await stat(cwd)).isDirectory(); }
		catch { return false; }
	}));
	return candidates.filter((_, index) => existing[index]);
}

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

type SessionMeta = Omit<UiSessionMetaPatch, 'name'>;
function sessionMetaPath(): string { return join(app.getPath('userData'), 'sessions-meta.json'); }
function isSessionMeta(value: unknown): value is Record<string, SessionMeta> {
	return isRecord(value) && Object.values(value).every((entry) => isRecord(entry)
		&& ['pinned', 'archived', 'unread'].every((key) => entry[key] === undefined || typeof entry[key] === 'boolean')
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

async function requireSessionOwners(paths: string[], allowCurrentDraft = false): Promise<Map<string, string>> {
	const targets = [...new Set(paths.map(normalizeSessionPath))];
	if (targets.some((path) => automationExecutor.isSessionRunning(path))) throw new Error('自动化仍在运行，请结束后再打开会话');
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
		if (!owner) throw new Error('未找到会话');
		result.set(path, owner);
	}
	return result;
}

function activateWorkspace(cwd: string, initialize: boolean): Promise<void> {
	if (pluginMutationActive) return Promise.reject(new Error('插件正在更新，请完成后再切换项目'));
	if (automaticRecoveryTimer) clearTimeout(automaticRecoveryTimer);
	automaticRecoveryTimer = null;
	return queueWorkspaceActivation(() => performWorkspaceActivation(cwd, initialize));
}

function queueWorkspaceActivation<T>(action: () => Promise<T>): Promise<T> {
	const result = workspaceActivationQueue.then(() => {
		if (disposingServices) throw new Error('Pi agent is shutting down');
		return action();
	});
	workspaceActivationQueue = result.then(() => undefined, () => undefined);
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

export function registerIpc(options: {
	onRendererReady?(win: BrowserWindow): void;
	getDialogWindow?(): BrowserWindow | undefined;
} = {}): void {
	getDialogWindow = options.getDialogWindow ?? (() => undefined);
	const notifier = createDesktopNotifier({
		settingsPath: desktopSettingsPath,
		getMainWindow: () => getDialogWindow() ?? null,
		revealSession: (path, cwd) => sendAppCommand({ type: 'switch-session', path, cwd }),
	});
		handleRendererInvoke(MCP_FEATURE_CHANNELS.getMcpSnapshot, () => agentService.getMcpSnapshot());
	handleRendererInvoke(MCP_FEATURE_CHANNELS.saveMcpServer, (_event, request: Parameters<typeof agentService.saveMcpServer>[0]) => agentService.saveMcpServer(request));
	handleRendererInvoke(MCP_FEATURE_CHANNELS.removeMcpServer, (_event, request: Parameters<typeof agentService.removeMcpServer>[0]) => agentService.removeMcpServer(request));
	handleRendererInvoke(MCP_FEATURE_CHANNELS.connectMcpServer, (_event, request: Parameters<typeof agentService.connectMcpServer>[0]) => agentService.connectMcpServer(request));
	handleRendererInvoke(MCP_FEATURE_CHANNELS.disconnectMcpServer, (_event, request: Parameters<typeof agentService.disconnectMcpServer>[0]) => agentService.disconnectMcpServer(request));
	handleRendererInvoke(MCP_FEATURE_CHANNELS.testMcpServer, (_event, request: Parameters<typeof agentService.testMcpServer>[0]) => agentService.testMcpServer(request));
	workbenchService = registerWorkbenchIpc(() => activeWorkspace);
	workbenchFeatures = registerWorkbenchFeatureIpc(() => activeWorkspace, app.getPath('userData'));
	inputFeatures = registerInputAttachmentIpc(() => ({ cwd: activeWorkspace, sessionPath: activeSessionPath }));
	handleRendererInvoke(INPUT_FEATURE_CHANNELS.submitInput, (_event, request: Parameters<typeof agentService.submitInput>[0]) => agentService.submitInput(request));
	handleRendererInvoke(INPUT_FEATURE_CHANNELS.getInputQueue, (_event, scope: Parameters<typeof agentService.getInputQueue>[0]) => agentService.getInputQueue(requireInputQueueScope(scope)));
	handleRendererInvoke(INPUT_FEATURE_CHANNELS.mutateInputQueue, (_event, request: Parameters<typeof agentService.mutateInputQueue>[0]) => {
		requireInputQueueScope(request?.scope); return agentService.mutateInputQueue(request);
	});
	handleRendererInvoke(WORKBENCH_FEATURE_CHANNELS.getFileCheckpoint, () => agentService.getFileCheckpoint());
	handleRendererInvoke(WORKBENCH_FEATURE_CHANNELS.rewindFileCheckpoint, (_event, request: Parameters<typeof agentService.rewindFileCheckpoint>[0]) => agentService.rewindFileCheckpoint(request));
	handleRendererInvoke(MANAGEMENT_FEATURE_CHANNELS.testProviderModel, (_event, request: Parameters<typeof agentService.testProviderModel>[0]) => agentService.testProviderModel(request));
	handleRendererInvoke(MANAGEMENT_FEATURE_CHANNELS.cancelProviderModelTest, (_event, id: string) => agentService.cancelProviderModelTest(id));
	handleRendererInvoke(MANAGEMENT_FEATURE_CHANNELS.getProjectDefaults, () => agentService.getProjectDefaults());
	handleRendererInvoke(MANAGEMENT_FEATURE_CHANNELS.saveProjectDefaults, (_event, request: Parameters<typeof agentService.saveProjectDefaults>[0]) => agentService.saveProjectDefaults(request));
	handleRendererInvoke(IPC_CHANNELS.personalizationRead, (event) => {
		requirePluginSender(event);
		return agentService.getPersonalization();
	});
	handleRendererInvoke(IPC_CHANNELS.personalizationSave, (event, request: UiSaveInstructionRequest) => {
		requirePluginSender(event);
		return agentService.saveInstruction(request);
	});
	managementFeatures = registerManagementIpc(agentService, listWorkspaces);
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
		},
		onError: (error) => console.error('Automation scheduler failed:', error),
		onRunFinished: (entry, task) => { notifier.handleAutomationRun(entry, task.name, task.cwd); if (entry.sessionPath) void managementFeatures?.rememberAutomation(entry.sessionPath, entry.id).catch(error => console.error('Usage identity persistence failed', error)); },
	});
	handleRendererInvoke(IPC_CHANNELS.desktopSettingsGet, () => readDesktopSettings(desktopSettingsPath()));
	handleRendererInvoke(IPC_CHANNELS.desktopSettingsSet, (event, patch: unknown) => {
		const win = invokingWindow(event);
		if (event.senderFrame !== win.webContents.mainFrame) throw new Error('Invalid desktop-settings sender');
		if (!isRecord(patch)) throw new Error('设置参数无效');
		const current = readDesktopSettings(desktopSettingsPath());
		const next: DesktopSettings = {
			notificationsEnabled: typeof patch.notificationsEnabled === 'boolean' ? patch.notificationsEnabled : current.notificationsEnabled,
			closeBehavior: patch.closeBehavior === 'tray' || patch.closeBehavior === 'quit' ? patch.closeBehavior : current.closeBehavior,
		};
		writeDesktopSettings(desktopSettingsPath(), next);
		return next;
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
		if (event.event.type === 'ready' || event.event.type === 'status' || event.event.type === 'sessions-changed') invalidateAppTrayData();
		notifier.handleAgentEvent(event, activeSessionPath, agentService.cwd || activeWorkspace);
		broadcastToRenderers(IPC_CHANNELS.agentEvent, event);
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

	handleRendererInvoke(IPC_CHANNELS.appInfo, () => ({
		appVersion: app.getVersion(),
		nodeVersion: process.versions.node ?? 'unknown',
		electronVersion: process.versions.electron ?? 'unknown',
		platform: process.platform,
	}));
	handleRendererInvoke(IPC_CHANNELS.appSetLocale, (_event, locale: AppLocale) => {
		setAppLocale(locale);
		updateAppTrayMenu();
	});
	handleRendererInvoke(IPC_CHANNELS.updateState, () => updateService.getState());
	handleRendererInvoke(IPC_CHANNELS.updateCheck, (_event, autoInstall?: unknown) => updateService.check(autoInstall === true));
	handleRendererInvoke(IPC_CHANNELS.updateInstall, () => updateService.install());
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
	handleRendererInvoke(IPC_CHANNELS.workspaceListPinned, () => listPinnedWorkspaces());
	handleRendererInvoke(IPC_CHANNELS.workspaceSetPinned, (_event, cwds: unknown) => setPinnedWorkspaces(cwds));
	handleRendererInvoke(IPC_CHANNELS.agentListSessionGroups, () => groups.list());
	handleRendererInvoke(IPC_CHANNELS.agentUpdateSessionGroups, (_event, change: UiSidebarGroupChange) => groups.update(change));
	handleRendererInvoke(IPC_CHANNELS.workspaceSwitch, (_event, cwd: string) => activateWorkspace(cwd, false));
	handleRendererInvoke(IPC_CHANNELS.workspaceDefault, () => {
		// The detach target is always the home workspace, not the last-saved cwd
		// that defaultWorkspace() restores.
		const home = join(app.getPath('home'), 'PiDesktopWorkspace');
		mkdirSync(home, { recursive: true });
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
			const home = join(app.getPath('home'), 'PiDesktopWorkspace');
			await writeStateFileAsync(workspaceSettingsPath(), { cwd: previous.cwd && workspaceKey(previous.cwd) === target ? home : previous.cwd, workspaces, pinnedWorkspaces });
		});
		for (const picked of [...pickedWorkspaces]) if (workspaceKey(picked) === target) pickedWorkspaces.delete(picked);
		for (const [path, owner] of sessionOwnerByPath) if (workspaceKey(owner) === target) sessionOwnerByPath.delete(path);
	}));
	handleRendererInvoke(IPC_CHANNELS.agentInit, (_event, cwd: string) => activateWorkspace(cwd, true));
	handleRendererInvoke(IPC_CHANNELS.agentSnapshot, () => agentService.getSnapshot());
	handleRendererInvoke(IPC_CHANNELS.agentHistoryPage, (_event, offset: unknown, limit: unknown) => {
		const pageOffset = typeof offset === 'number' ? offset : Number.NaN;
		const pageLimit = typeof limit === 'number' ? limit : Number.NaN;
		if (!Number.isInteger(pageOffset) || !Number.isInteger(pageLimit) || pageOffset < 0 || pageLimit < 1 || pageLimit > 500) throw new Error('历史分页参数无效');
		return agentService.getHistoryPage(pageOffset, pageLimit);
	});
	handleRendererInvoke(IPC_CHANNELS.agentSessionStats, () => agentService.getSessionStats());
	handleRendererInvoke(IPC_CHANNELS.agentMessageAttachment, (_event, sessionPath: unknown, messageId: unknown, index: unknown) => {
		if (typeof sessionPath !== 'string' || !sessionPath || sessionPath.length > 32768 || typeof messageId !== 'string' || !messageId || messageId.length > 256 || typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 999) throw new Error('附件参数无效');
		return agentService.getMessageAttachment(sessionPath, messageId, index);
	});
	handleRendererInvoke(IPC_CHANNELS.agentExportSession, async (event, format: unknown) => {
		const kind = format === 'html' ? 'html' : format === 'jsonl' ? 'jsonl' : null;
		if (!kind) throw new Error('导出格式无效');
		const win = invokingWindow(event);
		if (event.senderFrame !== win.webContents.mainFrame) throw new Error('Invalid export sender');
		const snapshot = await agentService.getSnapshot();
		const baseName = (snapshot.sessionPath ? basename(snapshot.sessionPath).replace(/\.jsonl$/i, '') : snapshot.sessionId ?? 'session').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'session';
		const filters = [{ name: kind.toUpperCase(), extensions: [kind] }];
		const choice = await dialog.showSaveDialog(win, { defaultPath: `${baseName}.${kind}`, filters });
		if (choice.canceled || !choice.filePath) return null;
		return agentService.exportSession(choice.filePath, kind);
	});
	handleRendererInvoke(IPC_CHANNELS.agentSessionTree, () => agentService.getSessionTree());
	handleRendererInvoke(IPC_CHANNELS.agentSwitchBranch, (_event, entryId: unknown) => {
		if (typeof entryId !== 'string' || !entryId.trim()) throw new Error('目标条目无效');
		return agentService.switchSessionBranch(entryId);
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
	handleRendererInvoke(IPC_CHANNELS.workspaceSearchFiles, async (_event, query: string, options?: { includeDirectories?: boolean }) => { await dataFeatures.applyProjectRules(activeWorkspace); return agentService.searchWorkspaceFiles(activeWorkspace, query, options); });
	handleRendererInvoke(IPC_CHANNELS.contextRead, async (_event, request: unknown) => {
		validateContextRequest(request);
		if (!(await listWorkspaces()).includes(request.workspace)) throw new Error('未知工作区');
		if (request.kind !== 'session') return readWorkspaceContext(request);
		if (await requireSessionOwner(request.path) !== request.workspace) throw new Error('会话不属于此工作区');
		return agentService.readSessionContext(request.workspace, request.path);
	});
	handleRendererInvoke(IPC_CHANNELS.agentSwitchSession, (_event, path: string) => queueWorkspaceActivation(async () => {
		path = normalizeSessionPath(path);
		if (automationExecutor.isSessionRunning(path)) throw new Error('自动化仍在运行，请结束后再打开会话');
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
		const owner = await requireSessionOwner(path, patch.name !== undefined);
		if (patch.name !== undefined) await agentService.renameSession(path, patch.name, owner);
		if (!metaKeys.some((key) => patch[key] !== undefined) && patch.order === undefined) return;
		await withSessionMeta(async (meta) => {
			const next: SessionMeta = { ...meta[path] };
			for (const key of metaKeys) {
				if (patch[key] !== undefined) {
					next[key] = patch[key];
				}
			}
			if (patch.order === null) delete next.order;
			else if (patch.order !== undefined) next.order = patch.order;
			meta[path] = next;
			await saveSessionMeta(meta);
		});
	}));
	const sessionTrash = createSessionTrash(() => join(app.getPath('userData'), 'session-trash'));
	async function recoverableMetadata(path: string): Promise<RecoverableSessionMetadata> {
		const meta = await withSessionMeta(value => ({ ...value[path] }));
		const group = (await groups.list()).find(item => item.sessionPaths.includes(path));
		return { ...meta, order: meta.order ?? undefined, ...(group ? { group: { id: group.id, name: group.name, index: group.sessionPaths.indexOf(path) } } : {}) };
	}
	const dataFeatures = registerDataFeaturesIpc({
		userData: app.getPath('userData'), sessionsRoot: join(getAgentDir(), 'sessions'), trash: sessionTrash,
		getWorkspace: () => activeWorkspace, getWorkspaces: listWorkspaces,
		listSources: async () => {
      const runtimeSnapshot = await agentService.getSnapshot();
      const runningPaths = new Set(runtimeSnapshot.sessionRuntimes?.filter(item => !['idle', 'failed'].includes(item.runtime.phase)).map(item => item.path) ?? []);
      if (runtimeSnapshot.sessionPath && !['idle', 'error', 'uninitialized'].includes(runtimeSnapshot.status)) runningPaths.add(runtimeSnapshot.sessionPath);
			const sources = [];
			for (const cwd of await listWorkspaces()) for (const session of await agentService.listSessions(cwd)) {
				if (automationExecutor.isSessionRunning(session.path) || runningPaths.has(session.path)) throw new Error('请等待会话运行结束后再创建完整备份');
				sources.push({ path: session.path, cwd, metadata: await recoverableMetadata(session.path) });
			}
			return sources;
		},
		applyMetadata: async items => {
			for (const item of items) {
				const { group, ...flags } = item.metadata ?? {};
				await withSessionMeta(async meta => { meta[item.path] = { ...meta[item.path], ...flags }; await saveSessionMeta(meta); });
				if (group) {
					let collection = await groups.list();
					let target = collection.find(value => value.id === group.id || value.name.toLowerCase() === group.name.toLowerCase());
					if (!target) { collection = await groups.update({ type: 'create', name: group.name }); target = collection.find(value => value.name === group.name)!; }
					await groups.update({ type: 'move-session', sessionPath: item.path, groupId: target.id, index: group.index });
				}
			}
		},
		removeMetadata: async paths => {
			await withSessionMeta(async meta => { for (const path of paths) delete meta[path]; await saveSessionMeta(meta); });
			for (const path of paths) await groups.removeSession(path);
		},
		isSessionRunning: async path => {
			if (automationExecutor.isSessionRunning(path)) return true;
			const snapshot = await agentService.getSnapshot();
			return snapshot.sessionPath === path || Boolean(snapshot.sessionRuntimes?.some(runtime => runtime.path === path && !['idle', 'failed'].includes(runtime.runtime.phase)));
		},
		releaseSessionInputs: async entry => {
			if (!entry.cwd || !entry.originalPath) return;
			// A failed cross-volume move can leave both copies. Its live source still owns inputs.
			try { await lstat(entry.originalPath); return; }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
			if (!inputFeatures) throw new Error('输入存储尚未就绪，请重试清理');
			const scope = { cwd: entry.cwd, sessionPath: entry.originalPath };
			inputFeatures.storage.releaseScope(scope);
			await rm(join(getAgentDir(), 'desktop-inputs', 'queues', `${inputScopeKey(scope)}.json`), { force: true });
		},
		searchSessions: async request => {
			const workspaces = await listWorkspaces();
			const result = await agentService.searchSessionsPage(workspaces, request, await withSessionMeta(value => Object.fromEntries(Object.entries(value).map(([path, meta]) => [path, { ...meta, order: meta.order ?? undefined }]))), workspaces.flatMap(cwd => automationExecutor.sessionPaths(cwd)));
			for (const session of result.sessions) rememberSessionOwner(session.path, session.cwd);
			return result;
		},
		searchFiles: (cwd, request) => agentService.searchProjectFiles(cwd, request),
		rebuildIndex: async () => agentService.rebuildSearchIndex(await listWorkspaces()),
		cancelSearch: id => agentService.cancelDataSearch(id),
		getSearchRules: cwd => agentService.getProjectSearchRules(cwd),
		setSearchRules: (cwd, rules) => agentService.setProjectSearchRules(cwd, rules),
		onChanged: async () => { lastSessionMetaPrune = 0; invalidateAppTrayData(); },
	});
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
			const session = (await agentService.listSessions(owner)).find(item => item.path === target);
			const trashed = await sessionTrash.trashSession(target, { cwd: owner, sessionId: session?.id, name: session?.name, metadata: await recoverableMetadata(target) });
			sessionOwnerByPath.delete(target);
			await withSessionMeta(async (meta) => {
				delete meta[target];
				await saveSessionMeta(meta);
			});
			await sessionGroupService?.removeSession(target);
			return trashed;
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
	handleRendererInvoke(IPC_CHANNELS.agentListModels, () => agentService.listModels());
	handleRendererInvoke(IPC_CHANNELS.agentListModelProviders, () => agentService.listModelProviders());
	handleRendererInvoke(IPC_CHANNELS.agentDiscoverProviderModels, (event, request: Parameters<typeof agentService.discoverProviderModels>[0]) => {
		requirePluginSender(event);
		return agentService.discoverProviderModels(request);
	});
	handleRendererInvoke(IPC_CHANNELS.agentSaveCustomProvider, (_event, request: Parameters<typeof agentService.saveCustomProvider>[0]) => agentService.saveCustomProvider(request));
	handleRendererInvoke(IPC_CHANNELS.agentRemoveCustomProvider, (_event, provider: string) => agentService.removeCustomProvider(provider));
	handleRendererInvoke(IPC_CHANNELS.agentListSlashCommands, () => agentService.listSlashCommands());
	handleRendererInvoke(IPC_CHANNELS.agentExecuteSlashCommand, (event, request: UiSlashCommandRequest) => {
		if (request?.name === 'reload') {
			requirePluginSender(event);
			return withPluginMutation(request.cwd, () => agentService.executeSlashCommand(request));
		}
		return agentService.executeSlashCommand(request);
	});
	handleRendererInvoke(IPC_CHANNELS.agentSetModel, (_event, provider: string, id: string) => agentService.setModel(provider, id));
	handleRendererInvoke(IPC_CHANNELS.agentSetThinkingLevel, (_event, level: UiThinkingLevel) => agentService.setThinkingLevel(level));
	handleRendererInvoke(IPC_CHANNELS.agentListProviderAuth, () => agentService.listProviderAuth());
	handleRendererInvoke(IPC_CHANNELS.agentSetProviderApiKey, (_event, provider: string, key: string) => agentService.setProviderApiKey(provider, key));
	handleRendererInvoke(IPC_CHANNELS.agentRemoveProviderCredential, (_event, provider: string) => agentService.removeProviderCredential(provider));
	handleRendererInvoke(IPC_CHANNELS.agentSetModelEnabled, (_event, provider: unknown, modelId: unknown, enabled: unknown) => {
		if (typeof provider !== 'string' || !provider.trim() || provider.length > 80 || /[\u0000]/u.test(provider)
			|| typeof modelId !== 'string' || !modelId.trim() || modelId.trim().length > 200 || /[\u0000]/u.test(modelId)
			|| typeof enabled !== 'boolean') throw new Error('模型启用参数无效');
		return agentService.setModelEnabled(provider, modelId.trim(), enabled);
	});
	handleRendererInvoke(IPC_CHANNELS.agentListExtensions, () => agentService.listExtensions());
	handleRendererInvoke(IPC_CHANNELS.agentSetExtensionEnabled, (event, path: string, enabled: boolean) => {
		requirePluginSender(event);
		return withPluginMutation(activeWorkspace, () => agentService.setExtensionEnabled(path, enabled));
	});

	handleRendererInvoke(IPC_CHANNELS.agentPrompt, async (_event, text: string, behavior?: 'steer' | 'followUp', attachments?: UiAttachment[]) => {
		await agentService.prompt(text, behavior, attachments);
	});

	handleRendererInvoke(IPC_CHANNELS.agentEditMessage, async (_event, entryId: string, text: string, attachments?: UiAttachment[]) => {
		await agentService.editUserMessage(entryId, text, attachments);
	});

	handleRendererInvoke(IPC_CHANNELS.agentForkMessage, async (_event, entryId: string) => {
		if (typeof entryId !== 'string' || !entryId.trim() || entryId.length > 512 || entryId.includes('\0')) throw new Error('消息标识无效');
		await agentService.forkAssistantMessage(entryId);
	});

	handleRendererInvoke(IPC_CHANNELS.agentUpdateQueuedMessage, async (_event, id: string, action: 'edit' | 'remove' | 'steer', text?: string) => {
		if (typeof id !== 'string' || !id.trim() || id.length > 512 || id.includes('\0')) throw new Error('排队消息标识无效');
		if (action !== 'edit' && action !== 'remove' && action !== 'steer') throw new Error('排队消息操作无效');
		if (action === 'edit' && (typeof text !== 'string' || !text.trim() || text.length > 256 * 1024 || text.includes('\0'))) throw new Error('排队消息内容无效');
		await agentService.updateQueuedMessage(id, action, action === 'edit' ? text : undefined);
	});

	handleRendererInvoke(IPC_CHANNELS.agentGenerateCommitMessage, (_event, context: string) => {
		if (typeof context !== 'string' || !context.trim() || context.length > 256 * 1024) throw new Error('提交上下文无效或过长');
		return agentService.generateCommitMessage(context);
	});

	handleRendererInvoke(IPC_CHANNELS.agentAbort, () => agentService.abort());

	handleRendererInvoke(IPC_CHANNELS.agentNewSession, () => queueWorkspaceActivation(() => agentService.newSession()));
	handleRendererInvoke(IPC_CHANNELS.agentExtensionDialogPending, (event) => [...pendingDialogs.values()]
		.filter(({ owner }) => owner === invokingWindow(event)).map(({ request }) => request));
	handleRendererInvoke(IPC_CHANNELS.agentExtensionDialogResponse, (event, id: string, value: string | boolean | null) => {
		if (typeof id !== 'string' || (!['string', 'boolean'].includes(typeof value) && value !== null)) throw new Error('交互结果无效');
		const pending = pendingDialogs.get(id);
		if (pending && pending.owner.webContents === event.sender) pending.resolve(value);
	});
}

export function disposeServices(): Promise<void> {
	if (serviceShutdown) return serviceShutdown;
	disposingServices = true;
	updateService.stop();
	destroyAppTray();
	for (const queue of startupNotifications.values()) queue.cleanup();
	for (const pending of pendingDialogs.values()) pending.resolve(null);
	if (automaticRecoveryTimer) clearTimeout(automaticRecoveryTimer);
	automaticRecoveryTimer = null;
	return serviceShutdown = (async () => {
		// Finish an accepted file move before terminating its host or exiting.
		await workspaceActivationQueue;
		// A pending move may still need the agent to validate session ownership.
		await sessionGroupService?.flush();
		inputFeatures?.dispose();
		const results = await Promise.allSettled([agentService.dispose(), workbenchService?.dispose(), workbenchFeatures?.dispose(), automationService?.dispose()]);
		// A failed service must not let app.quit interrupt another service's
		// cleanup or metadata that was queued by its final activity events.
		await sessionMetaQueue;
		await managementFeatures?.dispose();
		const failure = results.find((result) => result.status === 'rejected');
		if (failure?.status === 'rejected') throw failure.reason;
	})();
}
