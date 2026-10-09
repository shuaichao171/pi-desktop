import type { ManagementFeaturesBridge } from './managementFeatures';
import type { UiDiagnosticEvent } from './uiDiagnostics';
export * from './uiDiagnostics.ts';
import type { UiAgentError } from './agentErrors';
export * from './agentErrors.ts';
import type { UiApprovalDetails, UiExtensionDialogResponse } from './approval';
export * from './approval.ts';
import type { PluginUpdatesBridge } from './pluginUpdates';
import type { McpFeaturesBridge } from './mcpFeatures';
import type { ResultFilesBridge } from './resultFiles';
export * from './resultFiles.ts';
export * from './pluginUpdates.ts';
export * from './mcpFeatures.ts';
export * from './managementFeatures.ts';
import type { InputFeatureBridge, UiInputScope } from './inputFeatures';
import type { DataFeaturesBridge } from './dataFeatures';
import type { WorkbenchFeaturesBridge } from './workbenchFeatures';
export * from './inputFeatures.ts';
export * from './dataFeatures.ts';
export * from './workbenchFeatures.ts';
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
  agentEditMessage: 'agent:edit-message',
  agentForkMessage: 'agent:fork-message',
  agentUpdateQueuedMessage: 'agent:update-queued-message',
  agentGenerateCommitMessage: 'agent:generate-commit-message',
  agentAbort: 'agent:abort',
  agentNewSession: 'agent:new-session',
  agentSnapshot: 'agent:snapshot',
  agentResidentSnapshot: 'agent:resident-snapshot',
  agentActivateResident: 'agent:activate-resident',
  uiDiagnostic: 'app:ui-diagnostic',
  agentHistoryPage: 'agent:history-page',
  agentMessageAttachment: 'agent:message-attachment',
  agentSessionStats: 'agent:session-stats',
  agentExportSession: 'agent:export-session',
  agentSessionTree: 'agent:session-tree',
  agentSwitchBranch: 'agent:switch-branch',
  agentListSessions: 'agent:list-sessions',
  agentSearchSessions: 'agent:search-sessions',
  agentSwitchSession: 'agent:switch-session',
  sessionRevealFile: 'session:reveal-file',
  agentListWorkspaces: 'agent:list-workspaces',
  workspaceListConversations: 'workspace:list-conversations',
  conversationStoragePick: 'conversation-storage:pick',
  agentUpdateSessionMeta: 'agent:update-session-meta',
  sessionDelete: 'session:delete',
  appCommand: 'app:command',
  desktopSettingsGet: 'desktop-settings:get',
  desktopSettingsSet: 'desktop-settings:set',
  piEngineProbe: 'pi-engine:probe',
  piEngineStatus: 'pi-engine:status',
  piEnginePickDirectory: 'pi-engine:pick-directory',
  appRelaunch: 'app:relaunch',
  appearanceGet: 'appearance:get',
  appearanceSet: 'appearance:set',
  agentListSessionGroups: 'agent:list-session-groups',
  agentUpdateSessionGroups: 'agent:update-session-groups',
  agentUpdateSessionOrders: 'agent:update-session-orders',
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
  agentSetModelEnabled: 'agent:set-model-enabled',
  agentListExtensions: 'agent:list-extensions',
  agentSetExtensionEnabled: 'agent:set-extension-enabled',
  workspacePick: 'workspace:pick',
  workspaceProjectsDirectory: 'workspace:projects-directory',
  workspaceCreateProject: 'workspace:create-project',
  workspaceAddDropped: 'workspace:add-dropped',
  workspaceSwitch: 'workspace:switch',
  workspaceDefault: 'workspace:default',
  workspaceRemove: 'workspace:remove',
  workspaceListPinned: 'workspace:list-pinned',
  workspaceSetPinned: 'workspace:set-pinned',
  workspaceOpenFolder: 'workspace:open-folder',
  workspaceListEntries: 'workspace:list-entries',
  workspaceSearchFiles: 'workspace:search-files',
  workspaceReadFile: 'workspace:read-file',
  workspaceCreateEntry: 'workspace:create-entry',
  workspaceRenameEntry: 'workspace:rename-entry',
  workspaceDeleteEntry: 'workspace:delete-entry',
  resultFileOpen: 'result-file:open',
  resultFileReveal: 'result-file:reveal',
  resultFilePreview: 'result-file:preview',
  contextRead: 'context:read',
  workspaceGitStatus: 'workspace:git-status',
  workspaceGitDiff: 'workspace:git-diff',
  workspaceBranches: 'workspace:branches',
  workspaceCheckoutBranch: 'workspace:checkout-branch',
  workspaceGitSetStaged: 'workspace:git-set-staged',
  workspaceGitDiscard: 'workspace:git-discard',
  workspaceGitLog: 'workspace:git-log',
  workspaceGitGraph: 'workspace:git-graph',
  workspaceGitSync: 'workspace:git-sync',
  workspaceGitCreateBranch: 'workspace:git-create-branch',
  workspaceOpenPathInEditor: 'workspace:open-path-in-editor',
  workspaceRevealPath: 'workspace:reveal-path',
  workspaceOpenInVsCode: 'workspace:open-in-vscode',
  workspaceOpenWith: 'workspace:open-with',
  workspaceOpeners: 'workspace:openers',
  workspaceCommitContext: 'workspace:commit-context',
  workspaceCommit: 'workspace:commit',
  workspaceCommandStart: 'workspace:command-start',
  workspaceCommandStop: 'workspace:command-stop',
  workspaceCommandEvent: 'workspace:command-event',
  workspaceWatch: 'workspace:watch',
  workspaceChanged: 'workspace:changed',
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
  /** Missing fields preserve the original coalesced catch-up/unlimited behavior. */
  misfireGraceMinutes?: number | null;
  maxScheduledRuns?: number | null;
  dispatchRetryLimit?: number;
}

export interface UiAutomation extends Omit<UiAutomationInput, 'id'> {
  id: string;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  scheduledRunCount?: number;
  completedAt?: string | null;
}

export interface UiAutomationRun {
  id: string;
  automationId: string;
  name: string;
  cwd: string;
  trigger: 'schedule' | 'manual';
  status: 'running' | 'retrying' | 'skipped' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  startedAt: string;
  finishedAt: string | null;
  sessionId: string | null;
  sessionPath: string | null;
  summary: string;
  error: string | null;
  scheduledAt?: string;
  attempts?: number;
  retryAt?: string | null;
  dispatchState?: 'not-started' | 'dispatching' | 'accepted';
  counted?: boolean;
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
  /** Present when advertised by the provider, or filled from builtin rules (see inferred). */
  thinkingLevels?: UiThinkingLevel[];
  /** True when reasoning/thinkingLevels were filled by builtin rules, not advertised by the provider. */
  inferred?: boolean;
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
  /** Model ids hidden from pickers via desktop model preferences. */
  disabledModels?: string[];
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
  | { cwd: string; action: 'update-target'; scope: UiPluginScope; previewId: string }
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

/** One complete user request, including preflight, model/tool turns and retries. */
export interface UiConversationRun {
  id: string;
  /** Recorded lifecycle boundaries in epoch milliseconds; never inferred from message timestamps. */
  startedAt: number;
  /** Null while running or when a crash/legacy record has no observed completion. */
  finishedAt: number | null;
  status: 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
}

export interface UiMessage {
  id: string;
  runId?: string;
  /** Stable position in the session timeline, shared with tool activities. */
  order: number;
  role: 'user' | 'assistant' | 'system';
  /** System-row flavor: compaction/branch summaries and extension notices (role 'system' only). */
  systemKind?: 'compaction' | 'branch-summary' | 'custom' | 'extension-notice';
  /** Extension-notice flavor: info/warning/error styling (systemKind 'extension-notice' only). */
  notificationType?: 'info' | 'warning' | 'error';
  /** Accumulated text (grows while streaming). */
  text: string;
  /** Only provider-exposed thinking text; signatures and redacted blocks stay in the SDK. */
  thinking?: string;
  thinkingStatus?: UiThinkingStatus;
  /** True when older exposed thinking was omitted to keep the latest text within the renderer payload limit. */
  thinkingTruncated?: boolean;
  status: 'streaming' | 'done' | 'error';
  errorMessage?: string;
  error?: UiAgentError;
  attachments?: UiAttachment[];
  /** Historical attachments omitted from this transport payload; persisted content is retained. */
  attachmentsOmitted?: number;
  /** Metadata for omitted payloads; index addresses the persisted attachment array. */
  attachmentReferences?: UiAttachmentReference[];
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

export interface UiAttachmentReference { index: number; kind: 'image' | 'text'; name: string; mimeType: string; size: number }

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

/** Changes made during one conversation turn (run) or the whole session,
 * relative to the file just before its first tool edit in that scope.
 * The diff itself is computed on demand via getFileChangeDiffs (lazy loading). */
export interface UiFileChange {
  path: string;
  kind: 'added' | 'modified' | 'deleted';
  additions: number | null;
  deletions: number | null;
  preview?: 'binary' | 'too-large' | 'unavailable';
}

/** Lazily computed diff for one changed file within a scope. */
export interface UiFileDiff {
  path: string;
  diff: string | null;
  preview?: 'binary' | 'too-large' | 'unavailable';
}

/** Files changed within one conversation run; runId null groups changes
 * recorded before run tracking existed (legacy sessions). */
export interface UiFileChangeTurn {
  runId: string | null;
  items: UiFileChange[];
}

/** Scope for lazy diff loading: the whole session or one run's turn. */
export type UiFileDiffScope =
  | { kind: 'conversation' }
  | { kind: 'turn'; runId: string };

/** Full change view published with every file-changes update. */
export interface UiFileChangesView {
  items: UiFileChange[];
  turns: UiFileChangeTurn[];
  activeRunId: string | null;
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
  approval?: UiApprovalDetails;
}

export interface UiToolActivity {
  /** pi toolCallId. */
  id: string;
  runId?: string;
  order: number;
  /** Tool name, e.g. `bash`, `read`, `edit`. */
  tool: string;
  /** Short human-readable description of the call. */
  title: string;
  status: 'running' | 'done' | 'error' | 'interrupted';
  detail?: string;
  /** True when a very large tool result was capped before crossing IPC. */
  detailTruncated?: boolean;
  /** Wall-clock start in epoch milliseconds. Null when unknown, e.g. legacy history. */
  startedAt?: number | null;
  /** Wall-clock end in epoch milliseconds. Null while running or unknown. */
  endedAt?: number | null;
  /** Shell exit status. Zero on success; non-zero failures keep Pi's error text in `detail`. */
  exitCode?: number | null;
  /** Workspace-relative paths the call read or touched, when known. */
  files?: string[] | null;
  /** Shell command line, when the tool runs one. */
  command?: string | null;
  /** Pi edit-tool diff text (`+3 added` / `-2 removed` / ` 1 context` rows). */
  diff?: string | null;
}

/**
 * Normalized agent event stream. The @pidesktop/agent service maps pi SDK
 * session events into this renderer-friendly union.
 */
export type AgentUiEvent =
  | { type: 'reset'; cwd: string }
  | { type: 'status'; status: AgentStatus; message?: string; attempt?: number; maxAttempts?: number }
  | { type: 'ready'; resumeKind?: 'cold' | 'warm'; model: string; modelName?: string | null; modelProvider: string; thinkingLevel: UiThinkingLevel; availableThinkingLevels: UiThinkingLevel[]; contextUsage: UiContextUsage | null; cwd: string; sessionId: string; sessionPath: string | null; messages: UiMessage[]; activities: UiToolActivity[]; fileChanges: UiFileChange[]; fileChangeTurns?: UiFileChangeTurn[]; fileChangeActiveRunId?: string | null; historyTotal?: number; runs?: UiConversationRun[] }
  | { type: 'model'; model: string; modelName?: string | null; modelProvider: string; thinkingLevel: UiThinkingLevel; availableThinkingLevels: UiThinkingLevel[]; contextUsage: UiContextUsage | null }
  | { type: 'context-usage'; contextUsage: UiContextUsage | null }
  | { type: 'thinking-level'; level: UiThinkingLevel }
  | { type: 'user-message'; id: string; order: number; text: string; attachments?: UiAttachment[]; attachmentsOmitted?: number; attachmentReferences?: UiAttachmentReference[]; runId?: string }
  | { type: 'assistant-start'; id: string; order: number; runId?: string }
  | { type: 'run'; run: UiConversationRun }
  | { type: 'assistant-delta'; id: string; delta: string }
  | ({ type: 'assistant-thinking'; id: string } & UiThinkingOutput)
  | ({ type: 'assistant-end'; id: string; text: string; aborted?: boolean; errorMessage?: string; error?: UiAgentError } & Partial<UiThinkingOutput>)
  | { type: 'tool'; activity: UiToolActivity }
  | { type: 'queue'; count: number; items: UiQueuedMessage[] }
  | { type: 'file-changes'; items: UiFileChange[]; turns: UiFileChangeTurn[]; activeRunId: string | null }
  | { type: 'sessions-changed'; cwd: string }
  | { type: 'session-runtime'; cwd: string; path: string; runtime: UiSessionRuntimeState }
  | { type: 'error'; message: string; error?: UiAgentError };

export interface AgentEventEnvelope {
  sequence: number;
  event: AgentUiEvent;
}

export interface AgentSnapshot {
  sequence: number;
  /** Independent runtime states, including conversations running in the background. */
  sessionRuntimes?: UiSessionRuntimeSummary[];
  status: AgentStatus;
  statusMessage?: string;
  /** Auto-retry progress while the agent retries a failed model call (4.4). */
  retryAttempt?: number;
  retryMaxAttempts?: number;
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
  runs?: UiConversationRun[];
  queuedCount: number;
  queuedMessages: UiQueuedMessage[];
  fileChanges: UiFileChange[];
  /** Per-turn change groups for turn-level settlement cards (runId null = legacy). */
  fileChangeTurns: UiFileChangeTurn[];
  /** The run whose changes are accumulating while the agent is busy. */
  fileChangeActiveRunId: string | null;
  /** Full timeline entry count of the loaded branch; absent or equal to messages+activities means no older pages. */
  historyTotal?: number;
  error: string | null;
  errorInfo?: UiAgentError | null;
}

/** One slice of a session branch's timeline, ordered oldest-first by `order`. */
export interface UiHistoryPage {
  /** Timeline index of the first returned entry. */
  offset: number;
  /** Number of requested entries (the page may be shorter at the start of the branch). */
  limit: number;
  /** Total timeline entries in the branch. */
  total: number;
  messages: UiMessage[];
  activities: UiToolActivity[];
  runs?: UiConversationRun[];
}

/** Aggregate usage of the active session, matching Pi CLI /session. */
export interface UiSessionStats {
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  /** Observed task durations on the full selected branch; absent for older hosts. */
  timing?: {
    sampledAt: number;
    /** Sum of task time, excluding idle gaps; null if any history lacks timing. */
    durationMs: number | null;
    running: boolean;
    latestRun: { id: string; durationMs: number | null; outputTokens: number; running: boolean } | null;
  };
}

/** One node of the session entry tree; branches appear as children. */
export interface UiSessionTreeNode {
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'compaction' | 'branch-summary' | 'custom' | 'other';
  label: string;
  /** Entry ids of direct children (branches) below this node. */
  childCount: number;
  children: UiSessionTreeNode[];
  /** True when this entry lies on the current visible branch. */
  active: boolean;
  timestamp?: string;
}

export interface UiSessionRuntimeState {
  phase: 'idle' | 'running' | 'waiting-input' | 'waiting-approval' | 'failed';
  message?: string;
}

export interface UiSessionRuntimeSummary {
  cwd: string;
  path: string;
  runtime: UiSessionRuntimeState;
}

export interface UiSessionSummary {
  path: string;
  id: string;
  name?: string;
  firstMessage: string;
  modified: string;
  /** Session creation time (header timestamp). Stable key for the running tier — unlike modified it never advances while a turn streams (zcode createdAt semantics). */
  created?: string;
  messageCount: number;
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
  /** Strictly increasing unread watermark (epoch ms). Present only while unread; used for compare-and-swap clears (zcode unread_at semantics). */
  unreadAt?: number;
  /** Live runtime state; independent of persisted unread metadata. */
  runtime?: UiSessionRuntimeState;
  /** Manual sidebar position. Undefined entries keep their time-based sort. */
  order?: number;
}

export interface UiSessionMetaPatch {
  name?: string;
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
  /** Persisted unread watermark; written by the main process on every background settle, never by the renderer. */
  unreadAt?: number;
  /** Request-only CAS precondition for unread=false clears: skip the clear when the persisted watermark is newer (a fresher background unread arrived). Not persisted. */
  expectedUnreadAt?: number;
  /** Manual sidebar position; null clears it back to time-based sorting. */
  order?: number | null;
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
  | { type: 'move-session'; sessionPath: string; groupId: string | null; index?: number }
  | { type: 'reorder-groups'; ids: string[] };

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
  /** More changes exist beyond the bounded status preview. */
  truncated?: boolean;
  /** Upstream tracking ref (e.g. origin/main); null when the branch has none. */
  upstream?: string | null;
  /** Local commits not on the upstream. */
  ahead?: number;
  /** Upstream commits not yet merged locally. */
  behind?: number;
  /** At least one remote is configured, so a first push can set the upstream. */
  hasRemote?: boolean;
}

/** Network Git actions from the workbench (ZCode git action menu). */
export type WorkspaceGitSyncAction = 'fetch' | 'pull' | 'push';

/** Structured result for a branch switch. Known worktree blockers stay in-band so the UI can offer a safe recovery flow. */
export interface WorkspaceGitCheckoutIssue { code: 'dirty' | 'branch-in-use' | 'conflict' | 'unknown'; message: string; paths: string[] }
export type WorkspaceGitCheckoutResult =
  | { ok: true; branch: string; previous: string | null; didChange: boolean }
  | { ok: false; branch: string; previous: string | null; issue: WorkspaceGitCheckoutIssue };

/** One commit in the workbench git history (4.5). */
export interface WorkspaceGitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  /** ISO-8601 author date. */
  date: string;
  subject: string;
}

/** Debounced signal that the watched workspace changed on disk (no paths or contents). */
export interface WorkspaceChangeEvent {
  cwd: string;
  /** The file tree may differ. */
  files: boolean;
  /** Git status, refs or HEAD may differ. */
  git: boolean;
}

/** One commit in the git graph, with topology and local refs (4.5 graph). */
export interface WorkspaceGitGraphCommit {
  hash: string;
  shortHash: string;
  author: string;
  /** ISO-8601 author date. */
  date: string;
  subject: string;
  /** Parent hashes, newest-first order matches git log output. */
  parents: string[];
  /** Local branch names and HEAD pointing at this commit. */
  refs: string[];
}


export interface WorkspaceOpener {
  id: 'explorer' | 'vscode' | (string & {});
  /** Display name for detected apps (the file manager uses a localized label). */
  name?: string;
  kind?: 'file-manager' | 'editor' | 'terminal';
  /** Extracted editor icon as a data URL, when the executable was found. */
  icon?: string;
}
export interface WorkspaceBranches {
  isRepository: boolean;
  current: string | null;
  detached: boolean;
  branches: string[];
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
  windowMode?: 'full' | 'pai';
}

// 'available' = an update was found but nothing downloads until the user consents.
export type UiUpdatePhase = 'unavailable' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'up-to-date' | 'error';
export type UiUpdateUnavailableReason = 'development' | 'portable' | 'unsupported' | 'unconfigured' | 'invalid-feed';

export interface UiUpdateState {
  phase: UiUpdatePhase;
  unavailableReason?: UiUpdateUnavailableReason;
  currentVersion: string;
  availableVersion?: string;
  progressPercent?: number;
  releaseNotes?: string;
  releaseDate?: string;
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
/** Desktop-level preferences stored by the main process (4.1/4.2). */
export interface UiDesktopSettings {
  notificationsEnabled: boolean;
  closeBehavior: 'tray' | 'quit';
  /** Keep the OS awake (powerSaveBlocker) while a task or automation run is active. */
  keepAwakeWhileRunning: boolean;
  /** Periodic update checks download and install automatically (updates page toggle). */
  autoInstallUpdates: boolean;
  conversationStorageDirectory: string;
  /** Which Pi engine drives the agent host (restart to apply). */
  piEngine: UiPiEngineSelection;
}

/** Which Pi engine the agent host should load: the bundled SDK or a user-managed install. */
export type UiPiEngineSelection = { mode: 'builtin' } | { mode: 'custom'; path: string };

/** Structural validation result for a user-selected engine directory. */
export interface UiPiEngineProbe {
  ok: boolean;
  /** Normalized package directory (valid even when ok is false, when detectable). */
  packageDir: string | null;
  version: string | null;
  problems: string[];
  warnings: string[];
}

/** Engine selection plus what the running agent host actually loaded. */
export interface UiPiEngineStatus {
  builtinVersion: string | null;
  /** Effective selection from desktop settings; version is probed when custom. */
  selection: UiPiEngineSelection & { version: string | null };
  /** Engine snapshot captured when the agent host process was forked; null before the first fork. */
  active: (UiPiEngineSelection & { version: string | null }) | null;
  pendingRestart: boolean;
}

/** Main → renderer commands (tray menu, notification clicks). */
/** Look-and-feel shared by every window, including pai chat windows. */
export interface UiAppearanceState {
  theme: 'system' | 'dark' | 'light';
  colors: { light: { preset: string; accent: string; surface: string; ink: string; contrast: number }; dark: { preset: string; accent: string; surface: string; ink: string; contrast: number } };
}

/** Main → renderer commands (tray menu, notification clicks). */
export type UiAppCommand = { type: 'new-session' } | { type: 'switch-session'; path: string; cwd?: string } | { type: 'open-settings' } | { type: 'appearance-changed'; appearance: UiAppearanceState };

export interface AgentBridge extends InputFeatureBridge, DataFeaturesBridge, WorkbenchFeaturesBridge, ManagementFeaturesBridge, PluginUpdatesBridge, McpFeaturesBridge, ResultFilesBridge {
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
  checkForUpdates(autoInstall?: boolean): Promise<UiUpdateState>;
  installUpdate(): Promise<void>;
  onUpdateStateChanged(listener: (state: UiUpdateState) => void): () => void;
  getDesktopSettings(): Promise<UiDesktopSettings>;
  setDesktopSettings(patch: Partial<UiDesktopSettings>): Promise<UiDesktopSettings>;
  probePiEngine(path: string): Promise<UiPiEngineProbe>;
  getPiEngineStatus(): Promise<UiPiEngineStatus>;
  pickPiEngineDirectory(): Promise<string | null>;
  /** Quit and start the app again so a changed Pi engine takes effect; false when the user cancels. */
  relaunchApp(): Promise<boolean>;
  /** Shared appearance state; null when nothing has been saved yet. */
  getAppearance(): Promise<UiAppearanceState | null>;
  setAppearance(state: UiAppearanceState): Promise<void>;
  onAppCommand(listener: (command: UiAppCommand) => void): () => void;
  getWindowChromeState(): Promise<WindowChromeState>;
  onWindowChromeStateChanged(listener: (state: WindowChromeState) => void): () => void;
  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<void>;
  closeWindow(): Promise<void>;
  /** Opens a native directory picker. Returns null when cancelled. */
  pickWorkspace(): Promise<string | null>;
  /** Picks a standalone-conversation storage folder without registering a project. */
  pickConversationStorageDirectory(): Promise<string | null>;
  /** Default parent directory for projects created by name. */
  getProjectsDirectory(): Promise<string>;
  /** Creates and registers a project directory without switching conversations. */
  createProject(name: string): Promise<string>;
  /** Accepts native File objects; registers their directories without switching conversations. Regular files are ignored. */
  addDroppedWorkspaces(files: unknown[]): Promise<string[]>;
  openWorkspaceFolder(cwd: string): Promise<void>;
  listWorkspaceEntries(relativePath?: string): Promise<WorkspaceEntry[]>;
  searchWorkspaceFiles(query: string, options?: { includeDirectories?: boolean }): Promise<{ files: WorkspaceEntry[]; truncated: boolean; skipped?: number; ignoredDirectories?: string[] }>;
  readWorkspaceFile(relativePath: string): Promise<string>;
  /** Creates an empty file or folder inside a workspace directory (4.6). */
  createWorkspaceEntry(parentPath: string, name: string, kind: 'file' | 'directory'): Promise<void>;
  /** Renames a file or folder within its directory (4.6). */
  renameWorkspaceEntry(path: string, newName: string): Promise<void>;
  /** Moves a file or folder to the OS trash (4.6). */
  deleteWorkspaceEntry(path: string): Promise<void>;
  getWorkspaceGitStatus(): Promise<WorkspaceGitStatus>;
  getWorkspaceGitDiff(relativePath: string, source?: 'staged' | 'unstaged' | 'all'): Promise<string>;
  /** Local branch list and current ref for the composer branch picker. */
  getWorkspaceBranches(): Promise<WorkspaceBranches>;
  /** Checks out an existing local branch in the active workspace. */
  checkoutWorkspaceBranch(branch: string): Promise<WorkspaceGitCheckoutResult>;
  /** Stages or unstages specific paths (4.5). */
  setWorkspaceGitStaged(paths: string[], staged: boolean): Promise<void>;
  /** Discards worktree changes; the caller confirms with the real diff first (4.5). */
  discardWorkspaceGitChanges(paths: string[]): Promise<void>;
  /** Recent commit history for the git pane (4.5). */
  getWorkspaceGitLog(limit?: number): Promise<WorkspaceGitLogEntry[]>;
  /** Commit history with parents and refs for the git graph (4.5). */
  getWorkspaceGitGraph(limit?: number): Promise<WorkspaceGitGraphCommit[]>;
  /** Fetch, fast-forward pull or push the current branch (sets the upstream on a first push). */
  syncWorkspaceGit(action: WorkspaceGitSyncAction): Promise<void>;
  /** Creates a local branch, optionally switching to it (4.5). */
  createWorkspaceGitBranch(name: string, checkout: boolean): Promise<void>;
  /** Opens a workspace file in VS Code, optionally at a line (4.7). */
  /** Opens a workspace file at an optional line in `editorId` (an opener id), falling back to VS Code. */
  openWorkspacePathInEditor(path: string, line?: number, column?: number, editorId?: string): Promise<void>;
  /** Reveals a workspace file in the OS file manager (4.7). */
  revealWorkspacePath(path: string): Promise<void>;
  /** Opens the workspace folder in VS Code (zcode-style editor launch). */
  openWorkspaceInVsCode(cwd: string): Promise<void>;
  /** Opens the workspace root with a detected editor or terminal from listWorkspaceOpeners. */
  openWorkspaceWith(cwd: string, openerId: string): Promise<void>;
  /** Lists apps able to open the workspace for the open-with picker. */
  listWorkspaceOpeners(): Promise<WorkspaceOpener[]>;
  /** Assembles the diff/status context used to generate a commit message. */
  getWorkspaceCommitContext(): Promise<string>;
  /** Stages all changes and commits them; returns the short commit hash. */
  commitWorkspace(message: string): Promise<string>;
  /** Asks the current model to write a commit message for the given context. */
  generateCommitMessage(context: string): Promise<string>;
  startWorkspaceCommand(command: string): Promise<string>;
  stopWorkspaceCommand(id: string): Promise<void>;
  onWorkspaceCommandEvent(listener: (event: WorkspaceCommandEvent) => void): () => void;
  /** Watches the active workspace for file/Git changes (null stops); events arrive via onWorkspaceChanged. */
  watchWorkspace(cwd: string | null): Promise<void>;
  onWorkspaceChanged(listener: (event: WorkspaceChangeEvent) => void): () => void;
  /** (Re-)creates the agent session bound to a working directory. */
  initAgent(cwd: string): Promise<void>;
  listWorkspaces(): Promise<string[]>;
  /** Internal conversation folders and storage roots, excluded from visible projects. */
  listConversationWorkspaces(): Promise<string[]>;
  /** Restores the workspace's last session, or opens a fresh conversation when requested. */
  switchWorkspace(cwd: string, options?: { fresh?: boolean }): Promise<void>;
  getDefaultWorkspace(): Promise<string>;
  /** Removes a project from the saved workspace list (sessions stay on disk). */
  removeWorkspace(cwd: string): Promise<void>;
  /** Project pins are desktop UI metadata persisted beside the workspace list. */
  listPinnedWorkspaces(): Promise<string[]>;
  setPinnedWorkspaces(cwds: string[]): Promise<string[]>;
  getAgentSnapshot(): Promise<AgentSnapshot>;
  /** Reads a loaded background conversation without changing input ownership. */
  getResidentSessionSnapshot(scope: { cwd: string; sessionId: string; sessionPath: string | null }): Promise<AgentSnapshot | null>;
  activateResidentSession(scope: { cwd: string; sessionId: string; sessionPath: string | null }): Promise<boolean>;
  recordUiDiagnostic(event: UiDiagnosticEvent): Promise<void>;
  /** Loads an older slice of the active session's timeline for long conversations. */
  getHistoryPage(offset: number, limit: number): Promise<UiHistoryPage>;
  /** Reads one attachment on the active branch; capped at 20 MiB encoded payload. */
  getMessageAttachment(sessionPath: string, messageId: string, index: number): Promise<UiAttachment>;
  /** Aggregate stats for the active session (message counts, tokens, cost). */
  getSessionStats(): Promise<UiSessionStats>;
  /** Writes the active session to a chosen file; the main process shows the save dialog. */
  exportSession(format: 'html' | 'jsonl'): Promise<string | null>;
  /** Entry tree of the active session with branch structure and the current path. */
  getSessionTree(): Promise<UiSessionTreeNode[]>;
  /** Moves the visible branch leaf onto another entry (zcode-style branch switch). */
  switchSessionBranch(entryId: string): Promise<void>;
  listSessions(cwd?: string): Promise<UiSessionSummary[]>;
  searchSessions(query: string): Promise<{ sessions: UiSessionSearchResult[]; truncated: boolean; skipped?: number }>;
  switchSession(path: string): Promise<void>;
  /** Reveals a conversation file in the OS file manager (zcode session context menu). */
  revealSessionFile(path: string): Promise<void>;
  updateSessionMeta(path: string, patch: UiSessionMetaPatch): Promise<void>;
  /** Permanently deletes a conversation file (native pi semantics) and clears its desktop metadata. */
  deleteSession(path: string): Promise<void>;
  listSessionGroups(): Promise<UiSessionGroup[]>;
  updateSessionGroups(change: UiSidebarGroupChange): Promise<UiSessionGroup[]>;
  /** Persist manual sidebar positions for many sessions in one write. */
  updateSessionOrders(entries: { path: string; order: number | null }[]): Promise<void>;
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
  /** Toggle a model's visibility in pickers; persisted in desktop model preferences. */
  setModelEnabled(provider: string, modelId: string, enabled: boolean): Promise<void>;
  listExtensions(): Promise<UiExtensionSummary[]>;
  setExtensionEnabled(path: string, enabled: boolean): Promise<void>;
  prompt(text: string, behavior?: 'steer' | 'followUp', attachments?: UiAttachment[]): Promise<void>;
  /** Rewind to a sent user message and resend the edited text (zcode-style edit).
   * fileMode 'rewind' also restores files touched by later rounds before resending. */
  editMessage(entryId: string, text: string, attachments?: UiAttachment[], fileMode?: 'keep' | 'rewind'): Promise<void>;
  /** Fork the conversation at an assistant message: the visible branch rewinds to it and the next prompt grows a new branch (zcode-style fork). */
  forkAssistantMessage(entryId: string): Promise<void>;
  /** Edit, remove, or steer-early a queued instruction while the agent is busy (Codex-style queue management). */
  updateQueuedMessage(id: string, action: 'edit' | 'remove' | 'steer', text?: string): Promise<void>;
  abort(): Promise<void>;
  /** Omitted cwd creates an independent folder. The returned scope remains valid for draft persistence after navigation. */
  newSession(options?: { cwd?: string }): Promise<UiInputScope | void>;
  onExtensionDialog(listener: (request: UiExtensionDialogRequest) => void): () => void;
  onExtensionDialogClosed(listener: (id: string) => void): () => void;
  getPendingExtensionDialogs(): Promise<UiExtensionDialogRequest[]>;
  respondExtensionDialog(id: string, value: UiExtensionDialogResponse): Promise<void>;
  /** Subscribe to the agent event stream. Returns an unsubscribe function. */
  onAgentEvent(listener: (envelope: AgentEventEnvelope) => void): () => void;
}
