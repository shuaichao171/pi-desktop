/**
 * IPC wiring: renderer ⇄ main ⇄ AgentService.
 *
 * All agent events fan out to every renderer window; every renderer→main call
 * is a typed invoke against the contract in @pidesktop/shared.
 */

import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentService } from '@pidesktop/agent';
import { IPC_CHANNELS, type AgentEventEnvelope, type UiThinkingLevel } from '@pidesktop/shared';

export const agentService = new AgentService(async (cwd) => {
	const { response } = await dialog.showMessageBox({
		type: 'warning',
		buttons: ['不信任，继续打开', '仅本次信任', '始终信任'],
		defaultId: 0,
		cancelId: 0,
		noLink: true,
		title: '信任工作区',
		message: '是否信任此工作区？',
		detail: `${cwd}\n\n信任后，Pi 可以加载此文件夹中的设置、技能和扩展；扩展可能执行本机代码。不信任仍可打开文件夹，但会跳过这些项目资源。`,
	});
	return { trusted: response !== 0, remember: response === 2 };
});

function workspaceSettingsPath(): string {
	return join(app.getPath('userData'), 'workspace.json');
}

export function defaultWorkspace(): string {
	try {
		const saved = JSON.parse(readFileSync(workspaceSettingsPath(), 'utf8')) as { cwd?: unknown };
		if (typeof saved.cwd === 'string' && statSync(saved.cwd).isDirectory()) return saved.cwd;
	} catch {
		// First launch or a workspace that no longer exists.
	}
	return join(app.getPath('home'), 'PiDesktopWorkspace');
}

function saveWorkspace(cwd: string): void {
	mkdirSync(app.getPath('userData'), { recursive: true });
	writeFileSync(workspaceSettingsPath(), JSON.stringify({ cwd }), 'utf8');
}

export function registerIpc(): void {
	// Agent events → all renderer windows.
	agentService.onEvent((event: AgentEventEnvelope) => {
		for (const win of BrowserWindow.getAllWindows()) {
			win.webContents.send(IPC_CHANNELS.agentEvent, event);
		}
	});

	ipcMain.handle(IPC_CHANNELS.appInfo, () => ({
		appVersion: app.getVersion(),
		nodeVersion: process.versions.node ?? 'unknown',
		electronVersion: process.versions.electron ?? 'unknown',
		platform: process.platform,
	}));

	ipcMain.handle(IPC_CHANNELS.workspacePick, async () => {
		const result = await dialog.showOpenDialog({
			properties: ['openDirectory'],
			title: '选择 Pi 工作区',
		});
		if (result.canceled || result.filePaths.length === 0) return null;
		return result.filePaths[0] ?? null;
	});

	ipcMain.handle(IPC_CHANNELS.agentInit, async (_event, cwd: string) => {
		await agentService.init({ cwd });
		saveWorkspace(cwd);
	});
	ipcMain.handle(IPC_CHANNELS.agentSnapshot, () => agentService.getSnapshot());
	ipcMain.handle(IPC_CHANNELS.agentListSessions, () => agentService.listSessions());
	ipcMain.handle(IPC_CHANNELS.agentSwitchSession, (_event, path: string) => agentService.switchSession(path));
	ipcMain.handle(IPC_CHANNELS.agentListModels, () => agentService.listModels());
	ipcMain.handle(IPC_CHANNELS.agentSetModel, (_event, provider: string, id: string) => agentService.setModel(provider, id));
	ipcMain.handle(IPC_CHANNELS.agentSetThinkingLevel, (_event, level: UiThinkingLevel) => agentService.setThinkingLevel(level));
	ipcMain.handle(IPC_CHANNELS.agentListProviderAuth, () => agentService.listProviderAuth());
	ipcMain.handle(IPC_CHANNELS.agentSetProviderApiKey, (_event, provider: string, key: string) => agentService.setProviderApiKey(provider, key));
	ipcMain.handle(IPC_CHANNELS.agentRemoveProviderCredential, (_event, provider: string) => agentService.removeProviderCredential(provider));

	ipcMain.handle(IPC_CHANNELS.agentPrompt, async (_event, text: string, behavior?: 'steer' | 'followUp') => {
		await agentService.prompt(text, behavior);
	});

	ipcMain.handle(IPC_CHANNELS.agentAbort, () => agentService.abort());

	ipcMain.handle(IPC_CHANNELS.agentNewSession, () => agentService.newSession());
}
