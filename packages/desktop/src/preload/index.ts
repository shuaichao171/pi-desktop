import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type AgentBridge, type AgentEventEnvelope, type UiExtensionDialogRequest, type UiUpdateState, type WindowChromeState, type WorkspaceCommandEvent } from '@pidesktop/shared';

/**
 * Exposes a typed, minimal bridge as `window.piDesktop`. The renderer never
 * sees ipcRenderer or Node APIs directly (contextIsolation stays on).
 */

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
	getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.appInfo),
	setAppLocale: (locale) => ipcRenderer.invoke(IPC_CHANNELS.appSetLocale, locale),
	getUpdateState: () => ipcRenderer.invoke(IPC_CHANNELS.updateState),
	checkForUpdates: () => ipcRenderer.invoke(IPC_CHANNELS.updateCheck),
	installUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.updateInstall),
	onUpdateStateChanged,
	getWindowChromeState: () => ipcRenderer.invoke(IPC_CHANNELS.windowChromeState),
	onWindowChromeStateChanged,
	minimizeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.windowMinimize),
	toggleMaximizeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.windowToggleMaximize),
	closeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.windowClose),
	pickWorkspace: () => ipcRenderer.invoke(IPC_CHANNELS.workspacePick),
	listWorkspaceEntries: (relativePath) => ipcRenderer.invoke(IPC_CHANNELS.workspaceListEntries, relativePath),
	readWorkspaceFile: (relativePath) => ipcRenderer.invoke(IPC_CHANNELS.workspaceReadFile, relativePath),
	getWorkspaceGitStatus: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceGitStatus),
	getWorkspaceGitDiff: (relativePath) => ipcRenderer.invoke(IPC_CHANNELS.workspaceGitDiff, relativePath),
	startWorkspaceCommand: (command) => ipcRenderer.invoke(IPC_CHANNELS.workspaceCommandStart, command),
	stopWorkspaceCommand: (id) => ipcRenderer.invoke(IPC_CHANNELS.workspaceCommandStop, id),
	onWorkspaceCommandEvent,
	initAgent: (cwd) => ipcRenderer.invoke(IPC_CHANNELS.agentInit, cwd),
	listWorkspaces: () => ipcRenderer.invoke(IPC_CHANNELS.agentListWorkspaces),
	switchWorkspace: (cwd) => ipcRenderer.invoke(IPC_CHANNELS.workspaceSwitch, cwd),
	getAgentSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.agentSnapshot),
	listSessions: (cwd) => ipcRenderer.invoke(IPC_CHANNELS.agentListSessions, cwd),
	switchSession: (path) => ipcRenderer.invoke(IPC_CHANNELS.agentSwitchSession, path),
	updateSessionMeta: (path, patch) => ipcRenderer.invoke(IPC_CHANNELS.agentUpdateSessionMeta, path, patch),
	listModels: () => ipcRenderer.invoke(IPC_CHANNELS.agentListModels),
	setModel: (provider, id) => ipcRenderer.invoke(IPC_CHANNELS.agentSetModel, provider, id),
	setThinkingLevel: (level) => ipcRenderer.invoke(IPC_CHANNELS.agentSetThinkingLevel, level),
	listProviderAuth: () => ipcRenderer.invoke(IPC_CHANNELS.agentListProviderAuth),
	setProviderApiKey: (provider, key) => ipcRenderer.invoke(IPC_CHANNELS.agentSetProviderApiKey, provider, key),
	removeProviderCredential: (provider) => ipcRenderer.invoke(IPC_CHANNELS.agentRemoveProviderCredential, provider),
	listExtensions: () => ipcRenderer.invoke(IPC_CHANNELS.agentListExtensions),
	setExtensionEnabled: (path, enabled) => ipcRenderer.invoke(IPC_CHANNELS.agentSetExtensionEnabled, path, enabled),
	prompt: (text, behavior, attachments) => ipcRenderer.invoke(IPC_CHANNELS.agentPrompt, text, behavior, attachments),
	abort: () => ipcRenderer.invoke(IPC_CHANNELS.agentAbort),
	newSession: () => ipcRenderer.invoke(IPC_CHANNELS.agentNewSession),
	onExtensionDialog,
	onExtensionDialogClosed,
	getPendingExtensionDialogs: () => ipcRenderer.invoke(IPC_CHANNELS.agentExtensionDialogPending),
	respondExtensionDialog: (id, value) => ipcRenderer.invoke(IPC_CHANNELS.agentExtensionDialogResponse, id, value),
	onAgentEvent,
};

contextBridge.exposeInMainWorld('piDesktop', bridge);
