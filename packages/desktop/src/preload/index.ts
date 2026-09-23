import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type AgentBridge, type AgentEventEnvelope, type WindowChromeState } from '@pidesktop/shared';

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

const bridge: AgentBridge = {
	getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.appInfo),
	getWindowChromeState: () => ipcRenderer.invoke(IPC_CHANNELS.windowChromeState),
	onWindowChromeStateChanged,
	minimizeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.windowMinimize),
	toggleMaximizeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.windowToggleMaximize),
	closeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.windowClose),
	pickWorkspace: () => ipcRenderer.invoke(IPC_CHANNELS.workspacePick),
	initAgent: (cwd) => ipcRenderer.invoke(IPC_CHANNELS.agentInit, cwd),
	getAgentSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.agentSnapshot),
	listSessions: () => ipcRenderer.invoke(IPC_CHANNELS.agentListSessions),
	switchSession: (path) => ipcRenderer.invoke(IPC_CHANNELS.agentSwitchSession, path),
	listModels: () => ipcRenderer.invoke(IPC_CHANNELS.agentListModels),
	setModel: (provider, id) => ipcRenderer.invoke(IPC_CHANNELS.agentSetModel, provider, id),
	setThinkingLevel: (level) => ipcRenderer.invoke(IPC_CHANNELS.agentSetThinkingLevel, level),
	listProviderAuth: () => ipcRenderer.invoke(IPC_CHANNELS.agentListProviderAuth),
	setProviderApiKey: (provider, key) => ipcRenderer.invoke(IPC_CHANNELS.agentSetProviderApiKey, provider, key),
	removeProviderCredential: (provider) => ipcRenderer.invoke(IPC_CHANNELS.agentRemoveProviderCredential, provider),
	prompt: (text, behavior) => ipcRenderer.invoke(IPC_CHANNELS.agentPrompt, text, behavior),
	abort: () => ipcRenderer.invoke(IPC_CHANNELS.agentAbort),
	newSession: () => ipcRenderer.invoke(IPC_CHANNELS.agentNewSession),
	onAgentEvent,
};

contextBridge.exposeInMainWorld('piDesktop', bridge);
