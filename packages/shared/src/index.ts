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
  agentInit: 'agent:init',
  agentPrompt: 'agent:prompt',
  agentAbort: 'agent:abort',
  agentNewSession: 'agent:new-session',
  agentSnapshot: 'agent:snapshot',
  agentListSessions: 'agent:list-sessions',
  agentSwitchSession: 'agent:switch-session',
  agentListModels: 'agent:list-models',
  agentSetModel: 'agent:set-model',
  agentSetThinkingLevel: 'agent:set-thinking-level',
  agentListProviderAuth: 'agent:list-provider-auth',
  agentSetProviderApiKey: 'agent:set-provider-api-key',
  agentRemoveProviderCredential: 'agent:remove-provider-credential',
  workspacePick: 'workspace:pick',
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

export interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  /** Accumulated text (grows while streaming). */
  text: string;
  status: 'streaming' | 'done' | 'error';
  errorMessage?: string;
}

export interface UiToolActivity {
  /** pi toolCallId. */
  id: string;
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
  | { type: 'user-message'; id: string; text: string }
  | { type: 'assistant-start'; id: string }
  | { type: 'assistant-delta'; id: string; delta: string }
  | { type: 'assistant-end'; id: string; text: string; aborted?: boolean; errorMessage?: string }
  | { type: 'tool'; activity: UiToolActivity }
  | { type: 'queue'; count: number }
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
  /** Opens a native directory picker. Returns null when cancelled. */
  pickWorkspace(): Promise<string | null>;
  /** (Re-)creates the agent session bound to a working directory. */
  initAgent(cwd: string): Promise<void>;
  getAgentSnapshot(): Promise<AgentSnapshot>;
  listSessions(): Promise<UiSessionSummary[]>;
  switchSession(path: string): Promise<void>;
  listModels(): Promise<UiModelSummary[]>;
  setModel(provider: string, id: string): Promise<void>;
  setThinkingLevel(level: UiThinkingLevel): Promise<void>;
  listProviderAuth(): Promise<UiProviderAuthStatus[]>;
  /** Persist an API key using pi's credential store. The key is never returned. */
  setProviderApiKey(provider: string, key: string): Promise<void>;
  removeProviderCredential(provider: string): Promise<void>;
  prompt(text: string, behavior?: 'steer' | 'followUp'): Promise<void>;
  abort(): Promise<void>;
  newSession(): Promise<void>;
  /** Subscribe to the agent event stream. Returns an unsubscribe function. */
  onAgentEvent(listener: (envelope: AgentEventEnvelope) => void): () => void;
}
