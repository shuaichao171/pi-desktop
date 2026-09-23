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
import { IPC_CHANNELS, type AgentEventEnvelope, type AppLocale, type UiAttachment, type UiExtensionDialogRequest, type UiSessionMetaPatch, type UiThinkingLevel } from '@pidesktop/shared';
import { createIsolatedAgentService } from './agentClient';
import { getAppLocale, setAppLocale } from './appLocale';
import { updateService } from './updateService';
export { updateService } from './updateService';
import { registerWorkbenchIpc } from './workbenchIpc';
import type { WorkbenchService } from './workbenchService';
import { backupCorruptStateFile, backupCorruptStateFileAsync, CorruptStateFileError, readStateFile, readStateFileAsync, writeStateFile, writeStateFileAsync } from './stateFiles';

type PendingDialog = {
	request: UiExtensionDialogRequest;
	owner: BrowserWindow;
	resolve: (value: string | boolean | null) => void;
	cleanup: () => void;
};

const pendingDialogs = new Map<string, PendingDialog>();
let workbenchService: WorkbenchService | null = null;
let disposingServices = false;
let activeSessionPath: string | null = null;
const pendingUnreadPaths = new Set<string>();
let workspaceActivationQueue: Promise<void> = Promise.resolve();
let automaticRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
let automaticRecoveryPromise: Promise<void> | null = null;

function requestExtensionDialog(request: UiExtensionDialogRequest, signal?: AbortSignal): Promise<string | boolean | null> {
	const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());
	if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed()) return Promise.resolve(null);
	if (request.kind === 'notify') {
		owner.webContents.send(IPC_CHANNELS.agentExtensionDialog, request);
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
		if (disposingServices || activeWorkspace !== cwd) return;
		const recovery = agentService.init({ cwd }).then(async () => {
			if (sessionPath && (await agentService.listSessions(cwd)).some((session) => session.path === sessionPath)) {
				await agentService.switchSession(sessionPath);
			}
		}).catch((error: unknown) => {
			console.error('Pi agent recovery failed:', error);
		});
		automaticRecoveryPromise = recovery;
		void recovery.finally(() => {
			if (automaticRecoveryPromise === recovery) automaticRecoveryPromise = null;
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

function activateWorkspace(cwd: string, initialize: boolean): Promise<void> {
	const result = workspaceActivationQueue.then(() => performWorkspaceActivation(cwd, initialize));
	workspaceActivationQueue = result.catch(() => {});
	return result;
}

async function performWorkspaceActivation(cwd: string, initialize: boolean): Promise<void> {
	if (typeof cwd !== 'string') throw new Error('未知工作区');
	if (initialize && automaticRecoveryTimer) {
		clearTimeout(automaticRecoveryTimer);
		automaticRecoveryTimer = null;
	}
	if (initialize && automaticRecoveryPromise) await automaticRecoveryPromise;
	const saved = await readWorkspaceSettingsAsync();
	const known = [activeWorkspace, saved.cwd, ...(saved.workspaces ?? [])];
	if (!known.includes(cwd) && !pickedWorkspaces.has(cwd)) throw new Error('未知工作区');
	try { if (!(await stat(cwd)).isDirectory()) throw new Error('工作区目录无效'); }
	catch { throw new Error('工作区目录无效'); }
	if (cwd !== activeWorkspace) await workbenchService?.reset();
	const previous = activeWorkspace;
	activeWorkspace = cwd;
	try {
		if (initialize) await agentService.init({ cwd });
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

export function registerIpc(): void {
	workbenchService = registerWorkbenchIpc(() => activeWorkspace);
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
	ipcMain.handle(IPC_CHANNELS.workspaceSwitch, (_event, cwd: string) => activateWorkspace(cwd, false));
	ipcMain.handle(IPC_CHANNELS.agentInit, (_event, cwd: string) => activateWorkspace(cwd, true));
	ipcMain.handle(IPC_CHANNELS.agentSnapshot, () => agentService.getSnapshot());
	ipcMain.handle(IPC_CHANNELS.agentListSessions, async (_event, cwd?: string) => {
		const targetCwd = cwd ?? activeWorkspace;
		if (targetCwd && !(await listWorkspaces()).includes(targetCwd)) throw new Error('未知工作区');
		const sessions = await agentService.listSessions(targetCwd);
		for (const session of sessions) rememberSessionOwner(session.path, targetCwd);
		const meta = await withSessionMeta((value) => value);
		return sessions.map((session) => ({ ...session, ...meta[session.path] }));
	});
	ipcMain.handle(IPC_CHANNELS.agentSwitchSession, async (_event, path: string) => {
		await agentService.switchSession(path);
		await markSessionRead(path);
	});
	ipcMain.handle(IPC_CHANNELS.agentUpdateSessionMeta, async (_event, path: string, patch: UiSessionMetaPatch) => {
		if (!patch || typeof patch !== 'object') throw new Error('会话更新参数无效');
		const metaKeys = ['pinned', 'archived', 'unread'] as const;
		for (const key of metaKeys) {
			if (patch[key] !== undefined && typeof patch[key] !== 'boolean') throw new Error('会话状态无效');
		}
		let owner: string | undefined;
		const cached = sessionOwnerByPath.get(path);
		if (cached && (await agentService.listSessions(cached)).some((session) => session.path === path)) owner = cached;
		else sessionOwnerByPath.delete(path);
		if (!owner) {
			const workspaces = (await listWorkspaces()).filter((cwd) => cwd !== cached);
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
	ipcMain.handle(IPC_CHANNELS.agentSetModel, (_event, provider: string, id: string) => agentService.setModel(provider, id));
	ipcMain.handle(IPC_CHANNELS.agentSetThinkingLevel, (_event, level: UiThinkingLevel) => agentService.setThinkingLevel(level));
	ipcMain.handle(IPC_CHANNELS.agentListProviderAuth, () => agentService.listProviderAuth());
	ipcMain.handle(IPC_CHANNELS.agentSetProviderApiKey, (_event, provider: string, key: string) => agentService.setProviderApiKey(provider, key));
	ipcMain.handle(IPC_CHANNELS.agentRemoveProviderCredential, (_event, provider: string) => agentService.removeProviderCredential(provider));
	ipcMain.handle(IPC_CHANNELS.agentListExtensions, () => agentService.listExtensions());
	ipcMain.handle(IPC_CHANNELS.agentSetExtensionEnabled, (_event, path: string, enabled: boolean) => agentService.setExtensionEnabled(path, enabled));

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

export async function disposeServices(): Promise<void> {
	disposingServices = true;
	if (automaticRecoveryTimer) clearTimeout(automaticRecoveryTimer);
	automaticRecoveryTimer = null;
	await Promise.all([agentService.dispose(), workbenchService?.dispose()]);
	await sessionMetaQueue;
}
