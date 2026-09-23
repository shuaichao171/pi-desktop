/**
 * IPC wiring: renderer ⇄ main ⇄ AgentService.
 *
 * All agent events fan out to every renderer window; every renderer→main call
 * is a typed invoke against the contract in @pidesktop/shared.
 */

import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IPC_CHANNELS, type AgentEventEnvelope, type AppLocale, type UiAttachment, type UiExtensionDialogRequest, type UiSessionMetaPatch, type UiThinkingLevel } from '@pidesktop/shared';
import { createIsolatedAgentService } from './agentClient';
import { getAppLocale, setAppLocale } from './appLocale';
import { registerWorkbenchIpc } from './workbenchIpc';
import type { WorkbenchService } from './workbenchService';

type PendingDialog = {
	request: UiExtensionDialogRequest;
	resolve: (value: string | boolean | null) => void;
	cleanup: () => void;
};

const pendingDialogs = new Map<string, PendingDialog>();
let workbenchService: WorkbenchService | null = null;
let disposingServices = false;
let activeSessionPath: string | null = null;

function requestExtensionDialog(request: UiExtensionDialogRequest, signal?: AbortSignal): Promise<string | boolean | null> {
	if (request.kind === 'notify') {
		for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC_CHANNELS.agentExtensionDialog, request);
		return Promise.resolve(null);
	}
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (value: string | boolean | null): void => {
			if (!pendingDialogs.has(request.id)) return;
			pendingDialogs.delete(request.id);
			cleanup();
			for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC_CHANNELS.agentExtensionDialogClosed, request.id);
			resolve(value);
		};
		const onAbort = (): void => finish(null);
		const cleanup = (): void => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
		};
		pendingDialogs.set(request.id, { request, resolve: finish, cleanup });
		if (signal?.aborted) { finish(null); return; }
		signal?.addEventListener('abort', onAbort, { once: true });
		if (request.timeout && request.timeout > 0) timer = setTimeout(() => finish(null), request.timeout);
		for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC_CHANNELS.agentExtensionDialog, request);
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
	const sessionPath = activeSessionPath;
	setTimeout(() => {
		if (disposingServices || !activeWorkspace) return;
		void agentService.init({ cwd: activeWorkspace }).then(async () => {
			if (sessionPath && (await agentService.listSessions(activeWorkspace)).some((session) => session.path === sessionPath)) {
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

function readWorkspaceSettings(): WorkspaceSettings {
	try { return JSON.parse(readFileSync(workspaceSettingsPath(), 'utf8')) as WorkspaceSettings; }
	catch { return {}; }
}

function workspaceSettingsPath(): string {
	return join(app.getPath('userData'), 'workspace.json');
}

export function defaultWorkspace(): string {
	try {
		const saved = readWorkspaceSettings();
		if (typeof saved.cwd === 'string' && statSync(saved.cwd).isDirectory()) {
			saveWorkspace(saved.cwd);
			activeWorkspace = saved.cwd;
			return saved.cwd;
		}
	} catch {
		// First launch or a workspace that no longer exists.
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
	mkdirSync(app.getPath('userData'), { recursive: true });
	writeFileSync(workspaceSettingsPath(), JSON.stringify({ cwd, workspaces }), 'utf8');
}

function listWorkspaces(): string[] {
	const saved = readWorkspaceSettings();
	return [...new Set([...(Array.isArray(saved.workspaces) ? saved.workspaces : []), saved.cwd, activeWorkspace]
		.filter((value): value is string => typeof value === 'string' && value.length > 0))]
		.filter((cwd) => { try { return statSync(cwd).isDirectory(); } catch { return false; } });
}

type SessionMeta = Omit<UiSessionMetaPatch, 'name'>;
function sessionMetaPath(): string { return join(app.getPath('userData'), 'sessions-meta.json'); }
function readSessionMeta(): Record<string, SessionMeta> {
	try { return JSON.parse(readFileSync(sessionMetaPath(), 'utf8')) as Record<string, SessionMeta>; }
	catch { return {}; }
}
function saveSessionMeta(meta: Record<string, SessionMeta>): void {
	mkdirSync(app.getPath('userData'), { recursive: true });
	writeFileSync(sessionMetaPath(), JSON.stringify(meta), 'utf8');
}

function markSessionRead(path: string | null): void {
	if (!path) return;
	const meta = readSessionMeta();
	if (!meta[path]?.unread) return;
	meta[path] = { ...meta[path], unread: false };
	saveSessionMeta(meta);
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
		const meta = readSessionMeta();
		meta[path] = { ...meta[path], unread: true };
		saveSessionMeta(meta);
	});

	ipcMain.handle(IPC_CHANNELS.appInfo, () => ({
		appVersion: app.getVersion(),
		nodeVersion: process.versions.node ?? 'unknown',
		electronVersion: process.versions.electron ?? 'unknown',
		platform: process.platform,
	}));
	ipcMain.handle(IPC_CHANNELS.appSetLocale, (_event, locale: AppLocale) => setAppLocale(locale));
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
		if (selected) pickedWorkspaces.add(selected);
		return selected;
	});
	ipcMain.handle(IPC_CHANNELS.agentListWorkspaces, () => listWorkspaces());
	ipcMain.handle(IPC_CHANNELS.workspaceSwitch, async (_event, cwd: string) => {
		if (typeof cwd !== 'string' || (!listWorkspaces().includes(cwd) && !pickedWorkspaces.has(cwd))) throw new Error('未知工作区');
		if (!statSync(cwd).isDirectory()) throw new Error('工作区目录无效');
		await workbenchService?.dispose();
		const previous = activeWorkspace;
		activeWorkspace = cwd;
		try {
			await agentService.switchWorkspace(cwd);
			saveWorkspace(cwd);
			pickedWorkspaces.delete(cwd);
			markSessionRead((await agentService.getSnapshot()).sessionPath);
		} catch (error) {
			activeWorkspace = previous;
			throw error;
		}
	});

	ipcMain.handle(IPC_CHANNELS.agentInit, async (_event, cwd: string) => {
		if (typeof cwd !== 'string' || (!listWorkspaces().includes(cwd) && !pickedWorkspaces.has(cwd))) throw new Error('未知工作区');
		if (!statSync(cwd).isDirectory()) throw new Error('工作区目录无效');
		await workbenchService?.dispose();
		const previous = activeWorkspace;
		activeWorkspace = cwd;
		try {
			await agentService.init({ cwd });
			saveWorkspace(cwd);
			pickedWorkspaces.delete(cwd);
			markSessionRead((await agentService.getSnapshot()).sessionPath);
		} catch (error) {
			activeWorkspace = previous;
			throw error;
		}
	});
	ipcMain.handle(IPC_CHANNELS.agentSnapshot, () => agentService.getSnapshot());
	ipcMain.handle(IPC_CHANNELS.agentListSessions, async (_event, cwd?: string) => {
		const targetCwd = cwd ?? activeWorkspace;
		if (targetCwd && !listWorkspaces().includes(targetCwd)) throw new Error('未知工作区');
		const sessions = await agentService.listSessions(targetCwd);
		for (const session of sessions) sessionOwnerByPath.set(session.path, targetCwd);
		const meta = readSessionMeta();
		return sessions.map((session) => ({ ...session, ...meta[session.path] }));
	});
	ipcMain.handle(IPC_CHANNELS.agentSwitchSession, async (_event, path: string) => {
		await agentService.switchSession(path);
		markSessionRead(path);
	});
	ipcMain.handle(IPC_CHANNELS.agentUpdateSessionMeta, async (_event, path: string, patch: UiSessionMetaPatch) => {
		if (!patch || typeof patch !== 'object') throw new Error('会话更新参数无效');
		let owner: string | undefined;
		const cached = sessionOwnerByPath.get(path);
		if (cached && (await agentService.listSessions(cached)).some((session) => session.path === path)) owner = cached;
		if (!owner) {
			const owners = await Promise.all(listWorkspaces().map(async (cwd) => ({ cwd, sessions: await agentService.listSessions(cwd) })));
			owner = owners.find(({ sessions }) => sessions.some((session) => session.path === path))?.cwd;
			if (owner) sessionOwnerByPath.set(path, owner);
		}
		if (!owner) throw new Error('未找到会话');
		if (patch.name !== undefined) await agentService.renameSession(path, patch.name, owner);
		const meta = readSessionMeta();
		const next: SessionMeta = { ...meta[path] };
		for (const key of ['pinned', 'archived', 'unread'] as const) {
			if (patch[key] !== undefined) {
				if (typeof patch[key] !== 'boolean') throw new Error('会话状态无效');
				next[key] = patch[key];
			}
		}
		meta[path] = next;
		saveSessionMeta(meta);
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
	ipcMain.handle(IPC_CHANNELS.agentExtensionDialogPending, () => [...pendingDialogs.values()].map(({ request }) => request));
	ipcMain.handle(IPC_CHANNELS.agentExtensionDialogResponse, (_event, id: string, value: string | boolean | null) => {
		if (typeof id !== 'string' || !['string', 'boolean'].includes(typeof value) && value !== null) throw new Error('交互结果无效');
		pendingDialogs.get(id)?.resolve(value);
	});
}

export async function disposeServices(): Promise<void> {
	disposingServices = true;
	await Promise.all([agentService.dispose(), workbenchService?.dispose()]);
}
