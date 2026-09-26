import { PLUGIN_UPDATE_CHANNELS } from '@pidesktop/shared/pluginUpdates';
import { MCP_FEATURE_CHANNELS } from '@pidesktop/shared/mcpFeatures';
import { MANAGEMENT_FEATURE_CHANNELS } from '@pidesktop/shared/managementFeatures';
import { WORKBENCH_FEATURE_CHANNELS } from '@pidesktop/shared/workbenchFeatures';
import { DATA_FEATURE_CHANNELS } from '@pidesktop/shared/dataFeatures';
import { INPUT_FEATURE_CHANNELS } from '@pidesktop/shared/inputFeatures';
import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type AgentBridge, type AgentEventEnvelope, type UiAppCommand, type UiAutomationSnapshot, type UiExtensionDialogRequest, type UiUpdateState, type WindowChromeState, type WorkspaceCommandEvent } from '@pidesktop/shared';
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

const onAppCommand: AgentBridge['onAppCommand'] = (listener) => {
	const wrapped = (_e: Electron.IpcRendererEvent, command: UiAppCommand): void => listener(command);
	ipcRenderer.on(IPC_CHANNELS.appCommand, wrapped);
	return () => ipcRenderer.removeListener(IPC_CHANNELS.appCommand, wrapped);
};

const onUpdateStateChanged: AgentBridge['onUpdateStateChanged'] = (listener) => {
	const wrapped = (_e: Electron.IpcRendererEvent, state: UiUpdateState): void => listener(state);
	ipcRenderer.on(IPC_CHANNELS.updateStateChanged, wrapped);
	return () => ipcRenderer.removeListener(IPC_CHANNELS.updateStateChanged, wrapped);
};

const bridge: AgentBridge = {
	getMcpSnapshot: (...args) => invoke(MCP_FEATURE_CHANNELS.getMcpSnapshot, ...args),
	saveMcpServer: (...args) => invoke(MCP_FEATURE_CHANNELS.saveMcpServer, ...args),
	removeMcpServer: (...args) => invoke(MCP_FEATURE_CHANNELS.removeMcpServer, ...args),
	connectMcpServer: (...args) => invoke(MCP_FEATURE_CHANNELS.connectMcpServer, ...args),
	disconnectMcpServer: (...args) => invoke(MCP_FEATURE_CHANNELS.disconnectMcpServer, ...args),
	testMcpServer: (...args) => invoke(MCP_FEATURE_CHANNELS.testMcpServer, ...args),
	checkPluginUpdate: (...args) => invoke(PLUGIN_UPDATE_CHANNELS.checkPluginUpdate, ...args),

	submitInput: (...args) => invoke(INPUT_FEATURE_CHANNELS.submitInput, ...args),
	getInputQueue: (...args) => invoke(INPUT_FEATURE_CHANNELS.getInputQueue, ...args),
	mutateInputQueue: (...args) => invoke(INPUT_FEATURE_CHANNELS.mutateInputQueue, ...args),
	putInputAttachment: (...args) => invoke(INPUT_FEATURE_CHANNELS.putInputAttachment, ...args),
	readInputAttachment: (...args) => invoke(INPUT_FEATURE_CHANNELS.readInputAttachment, ...args),
	getInputDraft: (...args) => invoke(INPUT_FEATURE_CHANNELS.getInputDraft, ...args),
	saveInputDraft: (...args) => invoke(INPUT_FEATURE_CHANNELS.saveInputDraft, ...args),
	processPdfInput: (...args) => invoke(INPUT_FEATURE_CHANNELS.processPdfInput, ...args),
	cancelPdfInput: (...args) => invoke(INPUT_FEATURE_CHANNELS.cancelPdfInput, ...args),
	listSessionTrash: (...args) => invoke(DATA_FEATURE_CHANNELS.listSessionTrash, ...args),
	restoreSessionTrash: (...args) => invoke(DATA_FEATURE_CHANNELS.restoreSessionTrash, ...args),
	cleanupSessionTrash: (...args) => invoke(DATA_FEATURE_CHANNELS.cleanupSessionTrash, ...args),
	setSessionTrashRetention: (...args) => invoke(DATA_FEATURE_CHANNELS.setSessionTrashRetention, ...args),
	searchSessionsPage: (...args) => invoke(DATA_FEATURE_CHANNELS.searchSessionsPage, ...args),
	searchProjectFiles: (...args) => invoke(DATA_FEATURE_CHANNELS.searchProjectFiles, ...args),
	rebuildSearchIndex: (...args) => invoke(DATA_FEATURE_CHANNELS.rebuildSearchIndex, ...args),
	cancelDataSearch: (...args) => invoke(DATA_FEATURE_CHANNELS.cancelDataSearch, ...args),
	getProjectSearchRules: (...args) => invoke(DATA_FEATURE_CHANNELS.getProjectSearchRules, ...args),
	setProjectSearchRules: (...args) => invoke(DATA_FEATURE_CHANNELS.setProjectSearchRules, ...args),
	importSessions: (...args) => invoke(DATA_FEATURE_CHANNELS.importSessions, ...args),
	exportSessionsBackup: (...args) => invoke(DATA_FEATURE_CHANNELS.exportSessionsBackup, ...args),
	getWorkspaceCommitPreview: (...args) => invoke(WORKBENCH_FEATURE_CHANNELS.getWorkspaceCommitPreview, ...args),
	commitWorkspacePreview: (...args) => invoke(WORKBENCH_FEATURE_CHANNELS.commitWorkspacePreview, ...args),
	createTaskWorktree: (...args) => invoke(WORKBENCH_FEATURE_CHANNELS.createTaskWorktree, ...args),
	listTaskWorktrees: (...args) => invoke(WORKBENCH_FEATURE_CHANNELS.listTaskWorktrees, ...args),
	bindTaskWorktree: (...args) => invoke(WORKBENCH_FEATURE_CHANNELS.bindTaskWorktree, ...args),
	getGitDeliveryPreview: (...args) => invoke(WORKBENCH_FEATURE_CHANNELS.getGitDeliveryPreview, ...args),
	pushWorkspaceBranch: (...args) => invoke(WORKBENCH_FEATURE_CHANNELS.pushWorkspaceBranch, ...args),
	createWorkspaceDraftPr: (...args) => invoke(WORKBENCH_FEATURE_CHANNELS.createWorkspaceDraftPr, ...args),
	openWorkspaceTerminal: (...args) => invoke(WORKBENCH_FEATURE_CHANNELS.openWorkspaceTerminal, ...args),
	getWorkspaceTerminal: (...args) => invoke(WORKBENCH_FEATURE_CHANNELS.getWorkspaceTerminal, ...args),
	writeWorkspaceTerminal: (...args) => invoke(WORKBENCH_FEATURE_CHANNELS.writeWorkspaceTerminal, ...args),
	resizeWorkspaceTerminal: (...args) => invoke(WORKBENCH_FEATURE_CHANNELS.resizeWorkspaceTerminal, ...args),
	acknowledgeWorkspaceTerminal: (...args) => invoke(WORKBENCH_FEATURE_CHANNELS.acknowledgeWorkspaceTerminal, ...args),
	closeWorkspaceTerminal: (...args) => invoke(WORKBENCH_FEATURE_CHANNELS.closeWorkspaceTerminal, ...args),
	onWorkspaceTerminalEvent: listener => { const handler = (_event: Electron.IpcRendererEvent, value: import('@pidesktop/shared').WorkspaceTerminalEvent) => listener(value); ipcRenderer.on(WORKBENCH_FEATURE_CHANNELS.onWorkspaceTerminalEvent, handler); return () => ipcRenderer.removeListener(WORKBENCH_FEATURE_CHANNELS.onWorkspaceTerminalEvent, handler); },
	getFileCheckpoint: (...args) => invoke(WORKBENCH_FEATURE_CHANNELS.getFileCheckpoint, ...args),
	rewindFileCheckpoint: (...args) => invoke(WORKBENCH_FEATURE_CHANNELS.rewindFileCheckpoint, ...args),
	testProviderModel: (...args) => invoke(MANAGEMENT_FEATURE_CHANNELS.testProviderModel, ...args),
	cancelProviderModelTest: (...args) => invoke(MANAGEMENT_FEATURE_CHANNELS.cancelProviderModelTest, ...args),
	getProjectDefaults: (...args) => invoke(MANAGEMENT_FEATURE_CHANNELS.getProjectDefaults, ...args),
	saveProjectDefaults: (...args) => invoke(MANAGEMENT_FEATURE_CHANNELS.saveProjectDefaults, ...args),
	exportDiagnostics: (...args) => invoke(MANAGEMENT_FEATURE_CHANNELS.exportDiagnostics, ...args),
	getUsageReport: (...args) => invoke(MANAGEMENT_FEATURE_CHANNELS.getUsageReport, ...args),
	cancelManagementOperation: (...args) => invoke(MANAGEMENT_FEATURE_CHANNELS.cancelManagementOperation, ...args),
	getStorageSnapshot: (...args) => invoke(MANAGEMENT_FEATURE_CHANNELS.getStorageSnapshot, ...args),
	previewStorageCleanup: (...args) => invoke(MANAGEMENT_FEATURE_CHANNELS.previewStorageCleanup, ...args),
	executeStorageCleanup: (...args) => invoke(MANAGEMENT_FEATURE_CHANNELS.executeStorageCleanup, ...args),

	getPersonalization: () => invoke(IPC_CHANNELS.personalizationRead),
	saveInstruction: (request) => invoke(IPC_CHANNELS.personalizationSave, request),
	getPluginCatalog: (cwd) => invoke(IPC_CHANNELS.pluginCatalog, cwd),
	mutatePlugin: (input) => invoke(IPC_CHANNELS.pluginMutate, input),
	previewPluginResource: (request) => invoke(IPC_CHANNELS.pluginPreview, request),
	pickPluginDirectory: () => invoke(IPC_CHANNELS.pluginPickDirectory),
	discoverPlugins: (query) => invoke(IPC_CHANNELS.pluginDiscover, query),
	getAutomationSnapshot: () => invoke(IPC_CHANNELS.automationSnapshot),
	saveAutomation: (input) => invoke(IPC_CHANNELS.automationSave, input),
	setAutomationEnabled: (id, enabled) => invoke(IPC_CHANNELS.automationSetEnabled, id, enabled),
	deleteAutomation: (id) => invoke(IPC_CHANNELS.automationDelete, id),
	runAutomation: (id) => invoke(IPC_CHANNELS.automationRun, id),
	cancelAutomationRun: (runId) => invoke(IPC_CHANNELS.automationCancelRun, runId),
	onAutomationChanged: (listener) => {
		const wrapped = (_event: Electron.IpcRendererEvent, snapshot: UiAutomationSnapshot) => listener(snapshot);
		ipcRenderer.on(IPC_CHANNELS.automationChanged, wrapped);
		return () => ipcRenderer.removeListener(IPC_CHANNELS.automationChanged, wrapped);
	},
	notifyRendererReady: () => invoke(IPC_CHANNELS.rendererReady),
	getAppInfo: () => invoke(IPC_CHANNELS.appInfo),
	setAppLocale: (locale) => invoke(IPC_CHANNELS.appSetLocale, locale),
	getUpdateState: () => invoke(IPC_CHANNELS.updateState),
	checkForUpdates: (autoInstall?: boolean) => invoke(IPC_CHANNELS.updateCheck, autoInstall === true),
	installUpdate: () => invoke(IPC_CHANNELS.updateInstall),
	onUpdateStateChanged,
	getDesktopSettings: () => invoke(IPC_CHANNELS.desktopSettingsGet),
	setDesktopSettings: (patch) => invoke(IPC_CHANNELS.desktopSettingsSet, patch),
	onAppCommand,
	getWindowChromeState: () => invoke(IPC_CHANNELS.windowChromeState),
	onWindowChromeStateChanged,
	minimizeWindow: () => invoke(IPC_CHANNELS.windowMinimize),
	toggleMaximizeWindow: () => invoke(IPC_CHANNELS.windowToggleMaximize),
	closeWindow: () => invoke(IPC_CHANNELS.windowClose),
	pickWorkspace: () => invoke(IPC_CHANNELS.workspacePick),
	openWorkspaceFolder: (cwd) => invoke(IPC_CHANNELS.workspaceOpenFolder, cwd),
	listWorkspaceEntries: (relativePath) => invoke(IPC_CHANNELS.workspaceListEntries, relativePath),
	searchWorkspaceFiles: (query, options) => invoke(IPC_CHANNELS.workspaceSearchFiles, query, options),
	readWorkspaceFile: (relativePath) => invoke(IPC_CHANNELS.workspaceReadFile, relativePath),
	readContext: (request) => invoke(IPC_CHANNELS.contextRead, request),
	getWorkspaceGitStatus: () => invoke(IPC_CHANNELS.workspaceGitStatus),
		getWorkspaceGitDiff: (relativePath, source) => invoke(IPC_CHANNELS.workspaceGitDiff, relativePath, source),
		getWorkspaceBranches: () => invoke(IPC_CHANNELS.workspaceBranches),
		checkoutWorkspaceBranch: (branch) => invoke(IPC_CHANNELS.workspaceCheckoutBranch, branch),
		setWorkspaceGitStaged: (paths, staged) => invoke(IPC_CHANNELS.workspaceGitSetStaged, paths, staged),
		discardWorkspaceGitChanges: (paths) => invoke(IPC_CHANNELS.workspaceGitDiscard, paths),
		getWorkspaceGitLog: (limit) => invoke(IPC_CHANNELS.workspaceGitLog, limit),
		createWorkspaceGitBranch: (name, checkout) => invoke(IPC_CHANNELS.workspaceGitCreateBranch, name, checkout),
		openWorkspacePathInEditor: (path, line, column) => invoke(IPC_CHANNELS.workspaceOpenPathInEditor, path, line, column),
		revealWorkspacePath: (path) => invoke(IPC_CHANNELS.workspaceRevealPath, path),
		openWorkspaceInVsCode: (cwd) => invoke(IPC_CHANNELS.workspaceOpenInVsCode, cwd),
		listWorkspaceOpeners: () => invoke(IPC_CHANNELS.workspaceOpeners),
		getWorkspaceCommitContext: () => invoke(IPC_CHANNELS.workspaceCommitContext),
		commitWorkspace: (message) => invoke(IPC_CHANNELS.workspaceCommit, message),
	startWorkspaceCommand: (command) => invoke(IPC_CHANNELS.workspaceCommandStart, command),
	stopWorkspaceCommand: (id) => invoke(IPC_CHANNELS.workspaceCommandStop, id),
	onWorkspaceCommandEvent,
	initAgent: (cwd) => invoke(IPC_CHANNELS.agentInit, cwd),
	listWorkspaces: () => invoke(IPC_CHANNELS.agentListWorkspaces),
	switchWorkspace: (cwd) => invoke(IPC_CHANNELS.workspaceSwitch, cwd),
		getDefaultWorkspace: () => invoke(IPC_CHANNELS.workspaceDefault),
		removeWorkspace: (cwd) => invoke(IPC_CHANNELS.workspaceRemove, cwd),
		listPinnedWorkspaces: () => invoke(IPC_CHANNELS.workspaceListPinned),
		setPinnedWorkspaces: (cwds) => invoke(IPC_CHANNELS.workspaceSetPinned, cwds),
	getAgentSnapshot: () => invoke(IPC_CHANNELS.agentSnapshot),
	getHistoryPage: (offset, limit) => invoke(IPC_CHANNELS.agentHistoryPage, offset, limit),
	getMessageAttachment: (sessionPath, messageId, index) => invoke(IPC_CHANNELS.agentMessageAttachment, sessionPath, messageId, index),
	getSessionStats: () => invoke(IPC_CHANNELS.agentSessionStats),
	exportSession: (format) => invoke(IPC_CHANNELS.agentExportSession, format),
	getSessionTree: () => invoke(IPC_CHANNELS.agentSessionTree),
	switchSessionBranch: (entryId) => invoke(IPC_CHANNELS.agentSwitchBranch, entryId),
	listSessions: (cwd) => invoke(IPC_CHANNELS.agentListSessions, cwd),
	searchSessions: (query) => invoke(IPC_CHANNELS.agentSearchSessions, query),
	switchSession: (path) => invoke(IPC_CHANNELS.agentSwitchSession, path),
	updateSessionMeta: (path, patch) => invoke(IPC_CHANNELS.agentUpdateSessionMeta, path, patch),
	deleteSession: (path) => invoke(IPC_CHANNELS.sessionDelete, path),
	listSessionGroups: () => invoke(IPC_CHANNELS.agentListSessionGroups),
	updateSessionGroups: (change) => invoke(IPC_CHANNELS.agentUpdateSessionGroups, change),
	updateSessionOrders: (entries) => invoke(IPC_CHANNELS.agentUpdateSessionOrders, entries),
	listModels: () => invoke(IPC_CHANNELS.agentListModels),
	listModelProviders: () => invoke(IPC_CHANNELS.agentListModelProviders),
	discoverProviderModels: (request) => invoke(IPC_CHANNELS.agentDiscoverProviderModels, request),
	saveCustomProvider: (request) => invoke(IPC_CHANNELS.agentSaveCustomProvider, request),
	removeCustomProvider: (provider) => invoke(IPC_CHANNELS.agentRemoveCustomProvider, provider),
	listSlashCommands: () => invoke(IPC_CHANNELS.agentListSlashCommands),
	executeSlashCommand: (request) => invoke(IPC_CHANNELS.agentExecuteSlashCommand, request),
	setModel: (provider, id) => invoke(IPC_CHANNELS.agentSetModel, provider, id),
	setThinkingLevel: (level) => invoke(IPC_CHANNELS.agentSetThinkingLevel, level),
	listProviderAuth: () => invoke(IPC_CHANNELS.agentListProviderAuth),
	setProviderApiKey: (provider, key) => invoke(IPC_CHANNELS.agentSetProviderApiKey, provider, key),
	removeProviderCredential: (provider) => invoke(IPC_CHANNELS.agentRemoveProviderCredential, provider),
	setModelEnabled: (provider, modelId, enabled) => invoke(IPC_CHANNELS.agentSetModelEnabled, provider, modelId, enabled),
	listExtensions: () => invoke(IPC_CHANNELS.agentListExtensions),
	setExtensionEnabled: (path, enabled) => invoke(IPC_CHANNELS.agentSetExtensionEnabled, path, enabled),
	prompt: (text, behavior, attachments) => invoke(IPC_CHANNELS.agentPrompt, text, behavior, attachments),
		editMessage: (entryId, text, attachments) => invoke(IPC_CHANNELS.agentEditMessage, entryId, text, attachments),
		forkAssistantMessage: (entryId) => invoke(IPC_CHANNELS.agentForkMessage, entryId),
		updateQueuedMessage: (id, action, text) => invoke(IPC_CHANNELS.agentUpdateQueuedMessage, id, action, text),
		generateCommitMessage: (context) => invoke(IPC_CHANNELS.agentGenerateCommitMessage, context),
	abort: () => invoke(IPC_CHANNELS.agentAbort),
	newSession: () => invoke(IPC_CHANNELS.agentNewSession),
	onExtensionDialog,
	onExtensionDialogClosed,
	getPendingExtensionDialogs: () => invoke(IPC_CHANNELS.agentExtensionDialogPending),
	respondExtensionDialog: (id, value) => invoke(IPC_CHANNELS.agentExtensionDialogResponse, id, value),
	onAgentEvent,
};

contextBridge.exposeInMainWorld('piDesktop', bridge);
