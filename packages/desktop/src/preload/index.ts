import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type AgentBridge, type AgentEventEnvelope, type UiExtensionDialogRequest, type UiUpdateState, type WindowChromeState, type WorkspaceCommandEvent } from '@pidesktop/shared';
import { unwrapIpcError } from './ipcErrors';

/**
 * Exposes a typed, minimal bridge as `window.piDesktop`. The renderer never
 * sees ipcRenderer or Node APIs directly (contextIsolation stays on).
 */

async function invoke(channel: string, ...args: unknown[]) {
	try {
		return await ipcRenderer.invoke(channel, ...args);
	} catch (error) {
		throw unwrapIpcError(error, channel);
	}
}

const onAgentEvent: AgentBridge['onAgentEvent'] = (listener) => {
	const wrapped = (_e: Electron.IpcRendererEvent, event: AgentEventEnvelope): void => listener(event);
	ipcRenderer.on(IPC_CHANNELS.agentEvent, wrapped);
	return () => {
		ipcRenderer.removeListener(IPC_CHANNELS.agentEvent, wrapped);
	};
};

const onWindowChromeStateChanged: AgentBridge['onWindowChromeStateChanged'] = (listener) => {
	const wrapped = (_e: Electron.IpcRendererEvent, state: WindowChromeState): void => listener(state);
	ipcRenderer.on(IPC_CHANNELS.windowChromeStateChanged, wrapped);
	return () => {
		ipcRenderer.removeListener(IPC_CHANNELS.windowChromeStateChanged, wrapped);
	};
};

const onExtensionDialog: AgentBridge['onExtensionDialog'] = (listener) => {
	const wrapped = (_e: Electron.IpcRendererEvent, request: UiExtensionDialogRequest): void => listener(request);
	ipcRenderer.on(IPC_CHANNELS.agentExtensionDialog, wrapped);
	return () => ipcRenderer.removeListener(IPC_CHANNELS.agentExtensionDialog, wrapped);
};

const onExtensionDialogClosed: AgentBridge['onExtensionDialogClosed'] = (listener) => {
	const wrapped = (_e: Electron.IpcRendererEvent, id: string): void => listener(id);
	ipcRenderer.on(IPC_CHANNELS.agentExtensionDialogClosed, wrapped);
	return () => ipcRenderer.removeListener(IPC_CHANNELS.agentExtensionDialogClosed, wrapped);
};

const onWorkspaceCommandEvent: AgentBridge['onWorkspaceCommandEvent'] = (listener) => {
	const wrapped = (_e: Electron.IpcRendererEvent, event: WorkspaceCommandEvent): void => listener(event);
	ipcRenderer.on(IPC_CHANNELS.workspaceCommandEvent, wrapped);
	return () => ipcRenderer.removeListener(IPC_CHANNELS.workspaceCommandEvent, wrapped);
};

const onUpdateStateChanged: AgentBridge['onUpdateStateChanged'] = (listener) => {
	const wrapped = (_e: Electron.IpcRendererEvent, state: UiUpdateState): void => listener(state);
	ipcRenderer.on(IPC_CHANNELS.updateStateChanged, wrapped);
	return () => ipcRenderer.removeListener(IPC_CHANNELS.updateStateChanged, wrapped);
};

const bridge: AgentBridge = {
	getAppInfo: () => invoke(IPC_CHANNELS.appInfo),
	setAppLocale: (locale) => invoke(IPC_CHANNELS.appSetLocale, locale),
	getUpdateState: () => invoke(IPC_CHANNELS.updateState),
	checkForUpdates: () => invoke(IPC_CHANNELS.updateCheck),
	installUpdate: () => invoke(IPC_CHANNELS.updateInstall),
	onUpdateStateChanged,
	getWindowChromeState: () => invoke(IPC_CHANNELS.windowChromeState),
	onWindowChromeStateChanged,
	minimizeWindow: () => invoke(IPC_CHANNELS.windowMinimize),
	toggleMaximizeWindow: () => invoke(IPC_CHANNELS.windowToggleMaximize),
	closeWindow: () => invoke(IPC_CHANNELS.windowClose),
	pickWorkspace: () => invoke(IPC_CHANNELS.workspacePick),
	listWorkspaceEntries: (relativePath) => invoke(IPC_CHANNELS.workspaceListEntries, relativePath),
	readWorkspaceFile: (relativePath) => invoke(IPC_CHANNELS.workspaceReadFile, relativePath),
	getWorkspaceGitStatus: () => invoke(IPC_CHANNELS.workspaceGitStatus),
	getWorkspaceGitDiff: (relativePath) => invoke(IPC_CHANNELS.workspaceGitDiff, relativePath),
	startWorkspaceCommand: (command) => invoke(IPC_CHANNELS.workspaceCommandStart, command),
	stopWorkspaceCommand: (id) => invoke(IPC_CHANNELS.workspaceCommandStop, id),
	onWorkspaceCommandEvent,
	initAgent: (cwd) => invoke(IPC_CHANNELS.agentInit, cwd),
	listWorkspaces: () => invoke(IPC_CHANNELS.agentListWorkspaces),
	switchWorkspace: (cwd) => invoke(IPC_CHANNELS.workspaceSwitch, cwd),
	getAgentSnapshot: () => invoke(IPC_CHANNELS.agentSnapshot),
	listSessions: (cwd) => invoke(IPC_CHANNELS.agentListSessions, cwd),
	switchSession: (path) => invoke(IPC_CHANNELS.agentSwitchSession, path),
	updateSessionMeta: (path, patch) => invoke(IPC_CHANNELS.agentUpdateSessionMeta, path, patch),
	listModels: () => invoke(IPC_CHANNELS.agentListModels),
	setModel: (provider, id) => invoke(IPC_CHANNELS.agentSetModel, provider, id),
	setThinkingLevel: (level) => invoke(IPC_CHANNELS.agentSetThinkingLevel, level),
	listProviderAuth: () => invoke(IPC_CHANNELS.agentListProviderAuth),
	setProviderApiKey: (provider, key) => invoke(IPC_CHANNELS.agentSetProviderApiKey, provider, key),
	removeProviderCredential: (provider) => invoke(IPC_CHANNELS.agentRemoveProviderCredential, provider),
	listExtensions: () => invoke(IPC_CHANNELS.agentListExtensions),
	setExtensionEnabled: (path, enabled) => invoke(IPC_CHANNELS.agentSetExtensionEnabled, path, enabled),
	prompt: (text, behavior, attachments) => invoke(IPC_CHANNELS.agentPrompt, text, behavior, attachments),
	abort: () => invoke(IPC_CHANNELS.agentAbort),
	newSession: () => invoke(IPC_CHANNELS.agentNewSession),
	onExtensionDialog,
	onExtensionDialogClosed,
	getPendingExtensionDialogs: () => invoke(IPC_CHANNELS.agentExtensionDialogPending),
	respondExtensionDialog: (id, value) => invoke(IPC_CHANNELS.agentExtensionDialogResponse, id, value),
	onAgentEvent,
};

contextBridge.exposeInMainWorld('piDesktop', bridge);
