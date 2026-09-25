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
  personalizationRead: 'personalization:read',
  personalizationSave: 'personalization:save',
  pluginCatalog: 'plugins:catalog',
  pluginMutate: 'plugins:mutate',
  pluginPreview: 'plugins:preview',
  pluginPickDirectory: 'plugins:pick-directory',
  pluginDiscover: 'plugins:discover',
  automationSnapshot: 'automation:snapshot',
  automationSave: 'automation:save',
  automationSetEnabled: 'automation:set-enabled',
  automationDelete: 'automation:delete',
  automationRun: 'automation:run',
  automationCancelRun: 'automation:cancel-run',
  automationChanged: 'automation:changed',
  rendererReady: 'window:renderer-ready',
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
  agentSearchSessions: 'agent:search-sessions',
  agentSwitchSession: 'agent:switch-session',
  agentListWorkspaces: 'agent:list-workspaces',
  agentUpdateSessionMeta: 'agent:update-session-meta',
  agentListSessionGroups: 'agent:list-session-groups',
  agentUpdateSessionGroups: 'agent:update-session-groups',
  agentExtensionDialog: 'agent:extension-dialog',
  agentExtensionDialogClosed: 'agent:extension-dialog-closed',
  agentExtensionDialogPending: 'agent:extension-dialog-pending',
  agentExtensionDialogResponse: 'agent:extension-dialog-response',
  agentListModels: 'agent:list-models',
  agentListModelProviders: 'agent:list-model-providers',
  agentDiscoverProviderModels: 'agent:discover-provider-models',
  agentSaveCustomProvider: 'agent:save-custom-provider',
  agentRemoveCustomProvider: 'agent:remove-custom-provider',
  agentSetModel: 'agent:set-model',
  agentSetThinkingLevel: 'agent:set-thinking-level',
  agentListSlashCommands: 'agent:list-slash-commands',
  agentExecuteSlashCommand: 'agent:execute-slash-command',
  agentListProviderAuth: 'agent:list-provider-auth',
  agentSetProviderApiKey: 'agent:set-provider-api-key',
  agentRemoveProviderCredential: 'agent:remove-provider-credential',
  agentListExtensions: 'agent:list-extensions',
  agentSetExtensionEnabled: 'agent:set-extension-enabled',
  workspacePick: 'workspace:pick',
  workspaceSwitch: 'workspace:switch',
  workspaceOpenFolder: 'workspace:open-folder',
  workspaceListEntries: 'workspace:list-entries',
  workspaceSearchFiles: 'workspace:search-files',
  workspaceReadFile: 'workspace:read-file',
  contextRead: 'context:read',
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

/** Weekly days use Sunday=0. Times are HH:mm in the automation's IANA time zone. */
export type UiAutomationSchedule =
  | { kind: 'interval'; minutes: number }
  | { kind: 'weekly'; days: number[]; time: string }
  | { kind: 'once'; at: string };

export interface UiAutomationInput {
  id?: string;
  name: string;
  prompt: string;
  cwd: string;
  model: { provider: string; id: string } | null;
  thinkingLevel: UiThinkingLevel | null;
  schedule: UiAutomationSchedule;
  timeZone: string;
  enabled: boolean;
}

export interface UiAutomation extends Omit<UiAutomationInput, 'id'> {
  id: string;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export interface UiAutomationRun {
  id: string;
  automationId: string;
  name: string;
  cwd: string;
  trigger: 'schedule' | 'manual';
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  startedAt: string;
  finishedAt: string | null;
  sessionId: string | null;
  sessionPath: string | null;
  summary: string;
  error: string | null;
}

export interface UiAutomationSnapshot {
  revision: number;
  automations: UiAutomation[];
  runs: UiAutomationRun[];
  /** Transient persistence failure; the scheduler pauses until it can write safely. */
  error?: string;
}

/** Pi's estimate for the active context, not cumulative session token usage. */
export interface UiContextUsage {
  /** Unknown immediately after compaction, until a new model response. */
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/** Safe model metadata. Never send the SDK Model object across IPC. */
export interface UiModelSummary {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  input: ('text' | 'image')[];
  contextWindow: number;
  maxTokens: number;
  thinkingLevels?: UiThinkingLevel[];
  thinkingLevelMap?: Partial<Record<UiThinkingLevel, string | null>>;
}

/** Protocols supported by the custom-provider settings editor. */
export type UiProviderApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai';

export interface UiCustomProviderModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ('text' | 'image')[];
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Partial<Record<UiThinkingLevel, string | null>>;
}

/** Null preserves a stored header without returning its value to the renderer. */
export type UiProviderHeaders = Record<string, string | null>;

export interface UiDiscoverProviderModelsRequest {
  provider?: string;
  /** Omit connection fields to use the saved provider. */
  baseUrl?: string;
  api?: UiProviderApi;
  apiKey?: string;
  headers?: UiProviderHeaders;
  useSystemProxy?: boolean;
}

export interface UiDiscoveredProviderModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: ('text' | 'image')[];
  /** Only present when advertised by the provider, never inferred from its name. */
  thinkingLevels?: UiThinkingLevel[];
}

export interface UiProviderModelDiscovery {
  models: UiDiscoveredProviderModel[];
  warnings: string[];
}

export interface UiSaveCustomProviderRequest {
  provider: string;
  name?: string;
  baseUrl: string;
  api: UiProviderApi;
  /** Omit to keep the existing credential; never returned by the host. */
  apiKey?: string;
  headers?: UiProviderHeaders;
  useSystemProxy?: boolean;
  models: UiCustomProviderModel[];
  mode?: 'create' | 'update';
}

/** Full settings catalog, including models without configured credentials. */
export interface UiModelProvider {
  provider: string;
  name: string;
  custom: boolean;
  editable: boolean;
  configured: boolean;
  baseUrl: string | null;
  api: string | null;
  headerNames?: string[];
  /** Undefined preserves the existing Pi network behavior until explicitly configured. */
  useSystemProxy?: boolean;
  models: UiModelSummary[];
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

export type UiPluginScope = 'user' | 'project';
export type UiPluginResourceKind = 'extensions' | 'skills' | 'prompts' | 'themes';
export interface UiPluginResource {
  path: string;
  kind: UiPluginResourceKind;
  name: string;
  description: string;
  enabled: boolean;
  loaded: boolean;
  canToggle: boolean;
  scope: UiPluginScope;
  source: string;
  origin: 'package' | 'top-level';
  error?: string;
}
export interface UiPluginPackage {
  source: string;
  scope: UiPluginScope;
  name: string;
  description: string;
  version: string | null;
  installed: boolean;
  path: string | null;
}
export interface UiPluginCatalog {
  cwd: string;
  projectTrusted: boolean;
  packages: UiPluginPackage[];
  resources: UiPluginResource[];
  warnings: string[];
}
export type UiPluginMutation =
  | { cwd: string; action: 'install' | 'remove' | 'update'; source: string; scope: UiPluginScope }
  | { cwd: string; action: 'set-enabled'; path: string; kind: UiPluginResourceKind; scope: UiPluginScope; enabled: boolean }
  | { cwd: string; action: 'reload' };
export interface UiPluginResourcePreview { path: string; text: string; truncated: boolean }
export interface UiPluginDiscoveryItem {
  name: string;
  description: string;
  version: string;
  source: string;
  author: string;
}
export interface UiPluginDiscovery { items: UiPluginDiscoveryItem[]; total: number }

export interface UiMessage {
  id: string;
  /** Stable position in the session timeline, shared with tool activities. */
  order: number;
  role: 'user' | 'assistant';
  /** Accumulated text (grows while streaming). */
  text: string;
  /** Only provider-exposed thinking text; signatures and redacted blocks stay in the SDK. */
  thinking?: string;
  thinkingStatus?: UiThinkingStatus;
  /** True when exposed thinking exceeded the renderer payload limit. */
  thinkingTruncated?: boolean;
  status: 'streaming' | 'done' | 'error';
  errorMessage?: string;
  attachments?: UiAttachment[];
}

export type UiThinkingStatus = 'streaming' | 'done' | 'interrupted' | 'error';

export interface UiThinkingOutput {
  thinking: string;
  thinkingStatus: UiThinkingStatus;
  thinkingTruncated: boolean;
}

/** Renderer-safe prompt attachments. Image data is base64 without a data URL prefix. */
export interface UiContextSource {
  kind: 'file' | 'directory' | 'session';
  workspace: string;
  path: string;
  truncated?: boolean;
}

export type UiContextRequest = Pick<UiContextSource, 'kind' | 'workspace' | 'path'>;

export interface UiSlashCommand {
  /** Invocation name without the leading slash. */
  name: string;
  description: string;
  source: 'builtin' | 'extension' | 'prompt' | 'skill';
  acceptsArguments: boolean;
  requiresIdle: boolean;
}

export interface UiSlashCommandRequest {
  cwd: string;
  sessionId: string;
  name: string;
  args?: string;
  behavior?: 'steer' | 'followUp';
  attachments?: UiAttachment[];
}

export type UiAttachment =
  | { kind: 'image'; name: string; mimeType: string; data: string }
  | { kind: 'text'; name: string; mimeType: string; text: string; source?: UiContextSource };

/** Queue previews never repeat large image or context payloads over IPC. */
export interface UiQueuedAttachment {
  kind: 'image' | 'text';
  name: string;
  mimeType: string;
}

export interface UiQueuedMessage {
  /** Stable for the lifetime of this accepted SDK queue entry. */
  id: string;
  text: string;
  behavior: 'steer' | 'followUp';
  attachments?: UiQueuedAttachment[];
}

/** Changes made during this session, relative to the file just before its first tool edit. */
export interface UiFileChange {
  path: string;
  kind: 'added' | 'modified' | 'deleted';
  additions: number | null;
  deletions: number | null;
  diff: string | null;
  preview?: 'binary' | 'too-large' | 'unavailable';
}

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
  status: 'running' | 'done' | 'error' | 'interrupted';
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
  | { type: 'ready'; model: string; modelName?: string | null; modelProvider: string; thinkingLevel: UiThinkingLevel; availableThinkingLevels: UiThinkingLevel[]; contextUsage: UiContextUsage | null; cwd: string; sessionId: string; sessionPath: string | null; messages: UiMessage[]; activities: UiToolActivity[]; fileChanges: UiFileChange[] }
  | { type: 'model'; model: string; modelName?: string | null; modelProvider: string; thinkingLevel: UiThinkingLevel; availableThinkingLevels: UiThinkingLevel[]; contextUsage: UiContextUsage | null }
  | { type: 'context-usage'; contextUsage: UiContextUsage | null }
  | { type: 'thinking-level'; level: UiThinkingLevel }
  | { type: 'user-message'; id: string; order: number; text: string; attachments?: UiAttachment[] }
  | { type: 'assistant-start'; id: string; order: number }
  | { type: 'assistant-delta'; id: string; delta: string }
  | ({ type: 'assistant-thinking'; id: string } & UiThinkingOutput)
  | ({ type: 'assistant-end'; id: string; text: string; aborted?: boolean; errorMessage?: string } & Partial<UiThinkingOutput>)
  | { type: 'tool'; activity: UiToolActivity }
  | { type: 'queue'; count: number; items: UiQueuedMessage[] }
  | { type: 'file-changes'; items: UiFileChange[] }
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
  /** Display name of the selected SDK model, independent of the loaded catalog. */
  modelName?: string | null;
  modelProvider: string;
  thinkingLevel: UiThinkingLevel;
  availableThinkingLevels: UiThinkingLevel[];
  contextUsage: UiContextUsage | null;
  cwd: string;
  sessionId: string | null;
  sessionPath: string | null;
  messages: UiMessage[];
  activities: UiToolActivity[];
  queuedCount: number;
  queuedMessages: UiQueuedMessage[];
  fileChanges: UiFileChange[];
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

/** Custom sidebar groups. Deleting a group never deletes its sessions. */
export interface UiSessionGroup {
  id: string;
  name: string;
  sessionPaths: string[];
}

export type UiSidebarGroupChange =
  | { type: 'create'; name: string }
  | { type: 'rename'; id: string; name: string }
  | { type: 'delete'; id: string }
  | { type: 'move-session'; sessionPath: string; groupId: string | null };

export interface UiSessionSearchResult extends UiSessionSummary {
  cwd: string;
  snippet?: string;
  /** The persisted entry id used by UiMessage in the visible session branch. */
  messageId?: string;
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

export type UiUpdatePhase = 'unavailable' | 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'up-to-date' | 'error';
export type UiUpdateUnavailableReason = 'development' | 'portable' | 'unsupported' | 'unconfigured' | 'invalid-feed';

export interface UiUpdateState {
  phase: UiUpdatePhase;
  unavailableReason?: UiUpdateUnavailableReason;
  currentVersion: string;
  availableVersion?: string;
  progressPercent?: number;
  installRequested?: boolean;
  error?: string;
}

export type AppLocale = 'zh-CN' | 'en-US';

export interface WindowChromeState {
  isMaximized: boolean;
}

/* ------------------------------------------------------------------ */
/* Renderer → host bridge (implemented in preload)                     */
/* ------------------------------------------------------------------ */

export interface UiInstructionDocument {
  id: 'user' | 'pi';
  path: string;
  exists: boolean;
  content: string;
  revision: string | null;
  error?: string;
}

export interface UiSaveInstructionRequest {
  id: UiInstructionDocument['id'];
  content: string;
  revision: string | null;
}

export interface UiSaveInstructionResult {
  status: 'saved' | 'conflict';
  document: UiInstructionDocument;
}

/**
 * The renderer never touches ipcRenderer directly; it programs against this
 * interface. Implemented by the preload script in @pidesktop/desktop and
 * exposed as `window.piDesktop`.
 */
export interface AgentBridge {
  getPersonalization(): Promise<UiInstructionDocument[]>;
  saveInstruction(request: UiSaveInstructionRequest): Promise<UiSaveInstructionResult>;
  getPluginCatalog(cwd: string): Promise<UiPluginCatalog>;
  mutatePlugin(input: UiPluginMutation): Promise<UiPluginCatalog>;
  previewPluginResource(request: { cwd: string; path: string; kind: UiPluginResourceKind; scope: UiPluginScope }): Promise<UiPluginResourcePreview>;
  pickPluginDirectory(): Promise<string | null>;
  discoverPlugins(query: string): Promise<UiPluginDiscovery>;
  getAutomationSnapshot(): Promise<UiAutomationSnapshot>;
  saveAutomation(input: UiAutomationInput): Promise<UiAutomationSnapshot>;
  setAutomationEnabled(id: string, enabled: boolean): Promise<UiAutomationSnapshot>;
  deleteAutomation(id: string): Promise<UiAutomationSnapshot>;
  runAutomation(id: string): Promise<UiAutomationSnapshot>;
  cancelAutomationRun(runId: string): Promise<UiAutomationSnapshot>;
  onAutomationChanged(listener: (snapshot: UiAutomationSnapshot) => void): () => void;
  listSlashCommands(): Promise<UiSlashCommand[]>;
  executeSlashCommand(request: UiSlashCommandRequest): Promise<void>;
  /** Read a validated context reference without switching the active session. */
  readContext(request: UiContextRequest): Promise<UiAttachment>;
  /** The restored conversation or a required startup dialog has been rendered. */
  notifyRendererReady(): Promise<void>;
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
  openWorkspaceFolder(cwd: string): Promise<void>;
  listWorkspaceEntries(relativePath?: string): Promise<WorkspaceEntry[]>;
  searchWorkspaceFiles(query: string, options?: { includeDirectories?: boolean }): Promise<{ files: WorkspaceEntry[]; truncated: boolean }>;
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
  searchSessions(query: string): Promise<{ sessions: UiSessionSearchResult[]; truncated: boolean }>;
  switchSession(path: string): Promise<void>;
  updateSessionMeta(path: string, patch: UiSessionMetaPatch): Promise<void>;
  listSessionGroups(): Promise<UiSessionGroup[]>;
  updateSessionGroups(change: UiSidebarGroupChange): Promise<UiSessionGroup[]>;
  listModels(): Promise<UiModelSummary[]>;
  listModelProviders(): Promise<UiModelProvider[]>;
  discoverProviderModels(request: UiDiscoverProviderModelsRequest): Promise<UiProviderModelDiscovery>;
  saveCustomProvider(request: UiSaveCustomProviderRequest): Promise<void>;
  removeCustomProvider(provider: string): Promise<void>;
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
