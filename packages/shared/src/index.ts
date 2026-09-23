/**
 * @pidesktop/shared — IPC contract shared between the Electron main process,
 * the preload bridge, and the React renderer.
 *
 * This is the single source of truth for channel names and the shape of the
 * agent event stream that flows main → renderer.
 */

/* ------------------------------------------------------------------ */
/* IPC channels                                                        */
/* ------------------------------------------------------------------ */

export const IPC_CHANNELS = {
  appInfo: 'app:info',
  appSetLocale: 'app:set-locale',
  updateState: 'update:state',
  updateStateChanged: 'update:state-changed',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  agentInit: 'agent:init',
  agentPrompt: 'agent:prompt',
  agentAbort: 'agent:abort',
  agentNewSession: 'agent:new-session',
  agentSnapshot: 'agent:snapshot',
  agentListSessions: 'agent:list-sessions',
  agentSwitchSession: 'agent:switch-session',
  agentListWorkspaces: 'agent:list-workspaces',
  agentUpdateSessionMeta: 'agent:update-session-meta',
  agentExtensionDialog: 'agent:extension-dialog',
  agentExtensionDialogClosed: 'agent:extension-dialog-closed',
  agentExtensionDialogPending: 'agent:extension-dialog-pending',
  agentExtensionDialogResponse: 'agent:extension-dialog-response',
  agentListModels: 'agent:list-models',
  agentSetModel: 'agent:set-model',
  agentSetThinkingLevel: 'agent:set-thinking-level',
  agentListProviderAuth: 'agent:list-provider-auth',
  agentSetProviderApiKey: 'agent:set-provider-api-key',
  agentRemoveProviderCredential: 'agent:remove-provider-credential',
  agentListExtensions: 'agent:list-extensions',
  agentSetExtensionEnabled: 'agent:set-extension-enabled',
  workspacePick: 'workspace:pick',
  workspaceSwitch: 'workspace:switch',
  workspaceListEntries: 'workspace:list-entries',
  workspaceReadFile: 'workspace:read-file',
  workspaceGitStatus: 'workspace:git-status',
  workspaceGitDiff: 'workspace:git-diff',
  workspaceCommandStart: 'workspace:command-start',
  workspaceCommandStop: 'workspace:command-stop',
  workspaceCommandEvent: 'workspace:command-event',
  windowChromeState: 'window:chrome-state',
  windowChromeStateChanged: 'window:chrome-state-changed',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  /** Push channel: main → renderer event stream. */
  agentEvent: 'agent:event',
} as const;

/* ------------------------------------------------------------------ */
/* Agent state & events                                                */
/* ------------------------------------------------------------------ */

export type AgentStatus =
  | 'uninitialized'
  | 'starting'
  | 'idle'
  | 'busy'
  | 'error';

/** The pi coding-agent levels, including off for models without reasoning. */
export type UiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Safe model metadata. Never send the SDK Model object across IPC. */
export interface UiModelSummary {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  input: ('text' | 'image')[];
  contextWindow: number;
  maxTokens: number;
}

export interface UiProviderAuthStatus {
  provider: string;
  configured: boolean;
  source?: 'stored' | 'runtime' | 'environment' | 'fallback' | 'models_json_key' | 'models_json_command';
  supportsApiKey: boolean;
}

export interface UiExtensionSummary {
  path: string;
  name: string;
  enabled: boolean;
  scope: 'user' | 'project';
  origin: 'package' | 'top-level';
  source: string;
}

export interface UiMessage {
  id: string;
  /** Stable position in the session timeline, shared with tool activities. */
  order: number;
  role: 'user' | 'assistant';
  /** Accumulated text (grows while streaming). */
  text: string;
  status: 'streaming' | 'done' | 'error';
  errorMessage?: string;
  attachments?: UiAttachment[];
}

/** Renderer-safe prompt attachments. Image data is base64 without a data URL prefix. */
export type UiAttachment =
  | { kind: 'image'; name: string; mimeType: string; data: string }
  | { kind: 'text'; name: string; mimeType: string; text: string };

export interface UiExtensionDialogRequest {
  id: string;
  kind: 'select' | 'confirm' | 'input' | 'editor' | 'notify';
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  defaultValue?: string;
  timeout?: number;
  notificationType?: 'info' | 'warning' | 'error';
}

export interface UiToolActivity {
  /** pi toolCallId. */
  id: string;
  order: number;
  /** Tool name, e.g. `bash`, `read`, `edit`. */
  tool: string;
  /** Short human-readable description of the call. */
  title: string;
  status: 'running' | 'done' | 'error';
  detail?: string;
  /** True when a very large tool result was capped before crossing IPC. */
  detailTruncated?: boolean;
}

/**
 * Normalized agent event stream. The @pidesktop/agent service maps pi SDK
 * session events into this renderer-friendly union.
 */
export type AgentUiEvent =
  | { type: 'reset'; cwd: string }
  | { type: 'status'; status: AgentStatus; message?: string }
  | { type: 'ready'; model: string; modelProvider: string; thinkingLevel: UiThinkingLevel; availableThinkingLevels: UiThinkingLevel[]; cwd: string; sessionId: string; sessionPath: string | null; messages: UiMessage[]; activities: UiToolActivity[] }
  | { type: 'model'; model: string; modelProvider: string; thinkingLevel: UiThinkingLevel; availableThinkingLevels: UiThinkingLevel[] }
  | { type: 'thinking-level'; level: UiThinkingLevel }
  | { type: 'user-message'; id: string; order: number; text: string; attachments?: UiAttachment[] }
  | { type: 'assistant-start'; id: string; order: number }
  | { type: 'assistant-delta'; id: string; delta: string }
  | { type: 'assistant-end'; id: string; text: string; aborted?: boolean; errorMessage?: string }
  | { type: 'tool'; activity: UiToolActivity }
  | { type: 'queue'; count: number }
  | { type: 'sessions-changed'; cwd: string }
  | { type: 'error'; message: string };

export interface AgentEventEnvelope {
  sequence: number;
  event: AgentUiEvent;
}

export interface AgentSnapshot {
  sequence: number;
  status: AgentStatus;
  statusMessage?: string;
  model: string;
  modelProvider: string;
  thinkingLevel: UiThinkingLevel;
  availableThinkingLevels: UiThinkingLevel[];
  cwd: string;
  sessionId: string | null;
  sessionPath: string | null;
  messages: UiMessage[];
  activities: UiToolActivity[];
  queuedCount: number;
  error: string | null;
}

export interface UiSessionSummary {
  path: string;
  id: string;
  name?: string;
  firstMessage: string;
  modified: string;
  messageCount: number;
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
}

export interface UiSessionMetaPatch {
  name?: string;
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
}

export interface WorkspaceEntry {
  name: string;
  /** Path relative to the active workspace. */
  path: string;
  kind: 'file' | 'directory';
  size?: number;
}

export interface WorkspaceGitChange {
  path: string;
  /** Git porcelain XY status, e.g. M, ??, A, D. */
  status: string;
}

export interface WorkspaceGitStatus {
  isRepository: boolean;
  branch: string | null;
  entries: WorkspaceGitChange[];
}

export interface WorkspaceCommandEvent {
  id: string;
  type: 'stdout' | 'stderr' | 'exit' | 'error';
  data?: string;
  code?: number | null;
}

/* ------------------------------------------------------------------ */
/* App info                                                            */
/* ------------------------------------------------------------------ */

export interface AppInfo {
  appVersion: string;
  nodeVersion: string;
  electronVersion: string;
  platform: string;
}

export type UiUpdatePhase = 'unavailable' | 'idle' | 'checking' | 'downloading' | 'ready' | 'up-to-date' | 'error';
export type UiUpdateUnavailableReason = 'development' | 'portable' | 'unsupported' | 'unconfigured' | 'invalid-feed';

export interface UiUpdateState {
  phase: UiUpdatePhase;
  unavailableReason?: UiUpdateUnavailableReason;
  currentVersion: string;
  availableVersion?: string;
  progressPercent?: number;
  error?: string;
}

export type AppLocale = 'zh-CN' | 'en-US';

export interface WindowChromeState {
  isMaximized: boolean;
}

/* ------------------------------------------------------------------ */
/* Renderer → host bridge (implemented in preload)                     */
/* ------------------------------------------------------------------ */

/**
 * The renderer never touches ipcRenderer directly; it programs against this
 * interface. Implemented by the preload script in @pidesktop/desktop and
 * exposed as `window.piDesktop`.
 */
export interface AgentBridge {
  getAppInfo(): Promise<AppInfo>;
  setAppLocale(locale: AppLocale): Promise<void>;
  getUpdateState(): Promise<UiUpdateState>;
  checkForUpdates(): Promise<UiUpdateState>;
  installUpdate(): Promise<void>;
  onUpdateStateChanged(listener: (state: UiUpdateState) => void): () => void;
  getWindowChromeState(): Promise<WindowChromeState>;
  onWindowChromeStateChanged(listener: (state: WindowChromeState) => void): () => void;
  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<void>;
  closeWindow(): Promise<void>;
  /** Opens a native directory picker. Returns null when cancelled. */
  pickWorkspace(): Promise<string | null>;
  listWorkspaceEntries(relativePath?: string): Promise<WorkspaceEntry[]>;
  readWorkspaceFile(relativePath: string): Promise<string>;
  getWorkspaceGitStatus(): Promise<WorkspaceGitStatus>;
  getWorkspaceGitDiff(relativePath: string): Promise<string>;
  startWorkspaceCommand(command: string): Promise<string>;
  stopWorkspaceCommand(id: string): Promise<void>;
  onWorkspaceCommandEvent(listener: (event: WorkspaceCommandEvent) => void): () => void;
  /** (Re-)creates the agent session bound to a working directory. */
  initAgent(cwd: string): Promise<void>;
  listWorkspaces(): Promise<string[]>;
  switchWorkspace(cwd: string): Promise<void>;
  getAgentSnapshot(): Promise<AgentSnapshot>;
  listSessions(cwd?: string): Promise<UiSessionSummary[]>;
  switchSession(path: string): Promise<void>;
  updateSessionMeta(path: string, patch: UiSessionMetaPatch): Promise<void>;
  listModels(): Promise<UiModelSummary[]>;
  setModel(provider: string, id: string): Promise<void>;
  setThinkingLevel(level: UiThinkingLevel): Promise<void>;
  listProviderAuth(): Promise<UiProviderAuthStatus[]>;
  /** Persist an API key using pi's credential store. The key is never returned. */
  setProviderApiKey(provider: string, key: string): Promise<void>;
  removeProviderCredential(provider: string): Promise<void>;
  listExtensions(): Promise<UiExtensionSummary[]>;
  setExtensionEnabled(path: string, enabled: boolean): Promise<void>;
  prompt(text: string, behavior?: 'steer' | 'followUp', attachments?: UiAttachment[]): Promise<void>;
  abort(): Promise<void>;
  newSession(): Promise<void>;
  onExtensionDialog(listener: (request: UiExtensionDialogRequest) => void): () => void;
  onExtensionDialogClosed(listener: (id: string) => void): () => void;
  getPendingExtensionDialogs(): Promise<UiExtensionDialogRequest[]>;
  respondExtensionDialog(id: string, value: string | boolean | null): Promise<void>;
  /** Subscribe to the agent event stream. Returns an unsubscribe function. */
  onAgentEvent(listener: (envelope: AgentEventEnvelope) => void): () => void;
}
