/**
 * @pidesktop/shared — Remote mobile access contracts (wire protocol + desktop IPC).
 *
 * Inspired by T3 Code's decoupled Server–Client remote model:
 * - Desktop keeps all agent processes, files, git, and session state local.
 * - Clients connect over HTTP + WebSocket via LAN, Tailscale HTTPS, or Cloudflare Tunnel.
 * - Long-lived session tokens never appear in WebSocket URLs; clients mint short-lived
 *   single-use WebSocket tickets over authenticated HTTP first.
 * - Every RPC method declares and enforces a fine-grained scope on the server.
 */

import type {
  AgentEventEnvelope,
  AgentSnapshot,
  UiAttachment,
  UiExtensionDialogRequest,
  UiExtensionDialogResponse,
  UiFileDiff,
  UiFileDiffScope,
  UiHistoryPage,
  UiModelSummary,
  UiNewSessionReceipt,
  UiSessionListPage,
  UiSessionStats,
  UiSessionSummary,
  UiThinkingLevel,
  WorkspaceBranches,
  WorkspaceEntry,
  WorkspaceGitStatus,
} from './index.ts';
import type { UiAgentDescriptor, UiAgentStatus } from './agentRuntimes.ts';
import type { UiInputQueue, UiInputQueueScope } from './inputFeatures.ts';

export const REMOTE_PROTOCOL_VERSION = 1;
export const DEFAULT_REMOTE_ACCESS_PORT = 47910;
export const DEFAULT_TAILSCALE_SERVE_PORT = 443;
export const REMOTE_PAIRING_URL_SCHEME = 'pidesktop';
export const REMOTE_PAIRING_DEFAULT_TTL_MINUTES = 10;

export const REMOTE_ACCESS_CHANNELS = {
  getState: 'remote-access:get-state',
  setConfig: 'remote-access:set-config',
  createPairing: 'remote-access:create-pairing',
  revokePairing: 'remote-access:revoke-pairing',
  revokeSession: 'remote-access:revoke-session',
  revokeAllSessions: 'remote-access:revoke-all-sessions',
  installCloudflared: 'remote-access:install-cloudflared',
  refreshNetwork: 'remote-access:refresh-network',
  changed: 'remote-access:changed',
} as const;

/* ------------------------------------------------------------------ */
/* Permissions & Scopes                                               */
/* ------------------------------------------------------------------ */

export type RemoteAccessScope = 'chat:read' | 'chat:operate' | 'workspace:read';

export type RemoteAccessRole = 'full' | 'read-only';

export const REMOTE_ROLE_SCOPES: Record<RemoteAccessRole, readonly RemoteAccessScope[]> = {
  'read-only': ['chat:read', 'workspace:read'],
  full: ['chat:read', 'chat:operate', 'workspace:read'],
};

export function scopesForRemoteRole(role: RemoteAccessRole): RemoteAccessScope[] {
  return [...REMOTE_ROLE_SCOPES[role]];
}

/* ------------------------------------------------------------------ */
/* Advertised Endpoints & Environment Descriptor                      */
/* ------------------------------------------------------------------ */

export type RemoteEndpointKind = 'loopback' | 'lan' | 'tailscale' | 'cloudflare' | 'custom';

export interface RemoteAdvertisedEndpoint {
  readonly id: string;
  readonly kind: RemoteEndpointKind;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly isHttps: boolean;
  readonly isDefault?: boolean;
}

export interface RemoteCapabilities {
  readonly bearer: true;
  readonly wsTickets: true;
  readonly scopes: true;
  readonly directEndpoints: true;
  readonly fileBrowse: true;
  readonly gitDiff: true;
  readonly backgroundTasks: true;
}

export interface RemoteEnvironmentDescriptor {
  readonly environmentId: string;
  readonly label: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly protocolVersion: number;
  readonly capabilities: RemoteCapabilities;
  readonly directEndpoints: readonly RemoteAdvertisedEndpoint[];
}

/**
 * Unauthenticated probe answer (`GET /.well-known/pidesktop/environment`). It may be
 * reachable from the public internet through a tunnel, so it only proves "this is Pi
 * Desktop environment X speaking protocol N": machine label, app version, platform and
 * LAN/tailnet addresses are revealed only to authenticated sessions.
 */
export type RemotePublicEnvironmentDescriptor = Pick<RemoteEnvironmentDescriptor, 'environmentId' | 'protocolVersion' | 'capabilities'>;

export function toPublicEnvironmentDescriptor(descriptor: RemoteEnvironmentDescriptor): RemotePublicEnvironmentDescriptor {
  return {
    environmentId: descriptor.environmentId,
    protocolVersion: descriptor.protocolVersion,
    capabilities: descriptor.capabilities,
  };
}

/* ------------------------------------------------------------------ */
/* Pairing & Sessions                                                 */
/* ------------------------------------------------------------------ */

export interface RemotePairingGrant {
  readonly id: string;
  readonly label: string;
  readonly role: RemoteAccessRole;
  readonly scopes: readonly RemoteAccessScope[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
}

export interface RemotePairingCreated {
  readonly grant: RemotePairingGrant;
  /** Raw one-time secret; returned ONLY in the creation response and never stored in plaintext. */
  readonly code: string;
  readonly endpointUrl: string;
  /** Deep-link URI for QR scanning: pidesktop://pair?url=...&code=...&env=...&label=... */
  readonly pairingUrl: string;
}

export interface RemoteClientSession {
  readonly sessionId: string;
  readonly label: string;
  readonly deviceType: 'mobile' | 'tablet' | 'desktop' | 'unknown';
  readonly os: 'ios' | 'android' | 'macos' | 'windows' | 'linux' | 'unknown';
  readonly role: RemoteAccessRole;
  readonly scopes: readonly RemoteAccessScope[];
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
  readonly connected: boolean;
  readonly connectedAt: string | null;
  readonly remoteAddress: string | null;
}

export interface RemotePairExchangeRequest {
  readonly code: string;
  readonly clientLabel?: string;
  readonly deviceType?: RemoteClientSession['deviceType'];
  readonly os?: RemoteClientSession['os'];
}

export interface RemotePairExchangeResponse {
  readonly accessToken: string;
  readonly sessionId: string;
  readonly environmentId: string;
  readonly label: string;
  readonly role: RemoteAccessRole;
  readonly scopes: readonly RemoteAccessScope[];
  readonly expiresAt: string;
  readonly descriptor: RemoteEnvironmentDescriptor;
}

export interface RemoteSessionInfoResponse {
  readonly authenticated: true;
  readonly sessionId: string;
  readonly role: RemoteAccessRole;
  readonly scopes: readonly RemoteAccessScope[];
  readonly expiresAt: string;
  readonly descriptor: RemoteEnvironmentDescriptor;
}

export interface RemoteWsTicketResponse {
  readonly ticket: string;
  readonly expiresAt: string;
}

/* ------------------------------------------------------------------ */
/* Desktop Configuration & Status                                     */
/* ------------------------------------------------------------------ */

export type RemoteExposureMode = 'local-only' | 'lan';
export type RemoteCloudflareMode = 'off' | 'quick' | 'named';

export interface UiRemoteAccessConfig {
  readonly enabled: boolean;
  readonly port: number;
  readonly exposureMode: RemoteExposureMode;
  readonly machineLabel: string;
  readonly tailscaleServeEnabled: boolean;
  readonly tailscaleServePort: number;
  readonly cloudflareMode: RemoteCloudflareMode;
  /** Write-only when saving; always omitted in state snapshots. */
  readonly cloudflareTunnelToken?: string;
  readonly hasCloudflareTunnelToken?: boolean;
  readonly cloudflarePublicHostname: string;
}

export interface UiRemoteTailscaleStatus {
  readonly available: boolean;
  readonly running: boolean;
  readonly active: boolean;
  readonly magicDnsName: string | null;
  readonly tailnetIpv4: string | null;
  readonly httpsEnabled: boolean | null;
  readonly url: string | null;
  readonly error: string | null;
}

export interface UiRemoteCloudflareStatus {
  readonly mode: RemoteCloudflareMode;
  readonly status: 'off' | 'installing' | 'starting' | 'running' | 'error';
  readonly binaryPath: string | null;
  readonly binarySource: 'path' | 'managed' | null;
  readonly version: string | null;
  readonly protocol: string | null;
  readonly url: string | null;
  readonly error: string | null;
}

export interface UiRemoteAccessState {
  readonly config: UiRemoteAccessConfig;
  readonly environmentId: string;
  readonly running: boolean;
  readonly bindHost: string | null;
  readonly port: number | null;
  readonly endpoints: readonly RemoteAdvertisedEndpoint[];
  readonly tailscale: UiRemoteTailscaleStatus;
  readonly cloudflare: UiRemoteCloudflareStatus;
  readonly pairingGrants: readonly RemotePairingGrant[];
  readonly sessions: readonly RemoteClientSession[];
  readonly error: string | null;
}

export interface CreateRemotePairingInput {
  readonly label?: string;
  readonly role: RemoteAccessRole;
  readonly endpointUrl?: string;
  readonly expiresInMinutes?: number;
}

export interface RemoteAccessFeaturesBridge {
  getRemoteAccessState?(): Promise<UiRemoteAccessState>;
  setRemoteAccessConfig?(patch: Partial<UiRemoteAccessConfig>): Promise<UiRemoteAccessState>;
  createRemotePairing?(input: CreateRemotePairingInput): Promise<RemotePairingCreated>;
  revokeRemotePairing?(grantId: string): Promise<UiRemoteAccessState>;
  revokeRemoteSession?(sessionId: string): Promise<UiRemoteAccessState>;
  revokeAllRemoteSessions?(): Promise<UiRemoteAccessState>;
  installCloudflared?(): Promise<UiRemoteAccessState>;
  refreshRemoteNetwork?(): Promise<UiRemoteAccessState>;
  onRemoteAccessChanged?(listener: (state: UiRemoteAccessState) => void): () => void;
}

/* ------------------------------------------------------------------ */
/* WebSocket RPC Protocol                                             */
/* ------------------------------------------------------------------ */

export interface RemoteRpcMethodMap {
  'environment.getDescriptor': { params: void; result: RemoteEnvironmentDescriptor };
  'agent.getSnapshot': { params: void; result: AgentSnapshot };
  'agent.getHistoryPage': { params: { offset: number; limit: number }; result: UiHistoryPage };
  'agent.listWorkspaces': { params: void; result: string[] };
  'agent.listConversationWorkspaces': { params: void; result: string[] };
  'agent.listSessions': { params: { cwd?: string } | void; result: UiSessionSummary[] };
  'agent.listSessionsPage': { params: { cwd: string; offset: number; limit: number }; result: UiSessionListPage };
  'agent.listModels': { params: void; result: UiModelSummary[] };
  'agent.listAgents': { params: void; result: UiAgentStatus[] };
  'agent.getInputQueue': { params: { scope: UiInputQueueScope }; result: UiInputQueue };
  'agent.getPendingExtensionDialogs': { params: void; result: UiExtensionDialogRequest[] };
  'agent.getFileChangeDiffs': { params: { scope: UiFileDiffScope }; result: UiFileDiff[] };
  'agent.getSessionStats': { params: void; result: UiSessionStats };
  'agent.getMessageAttachment': { params: { sessionPath: string; messageId: string; index: number }; result: UiAttachment };
  'agent.getToolResultImage': { params: { sessionPath: string; toolCallId: string; index: number }; result: UiAttachment };

  'agent.prompt': { params: { text: string; behavior?: 'steer' | 'followUp'; attachments?: UiAttachment[] }; result: { ok: true } };
  'agent.abort': { params: void; result: { ok: true } };
  'agent.newSession': { params: { cwd?: string } | void; result: UiNewSessionReceipt | null };
  'agent.switchWorkspace': { params: { cwd: string; fresh?: boolean }; result: { ok: true } };
  'agent.switchSession': { params: { path: string }; result: { ok: true } };
  'agent.setModel': { params: { provider: string; id: string }; result: { ok: true } };
  'agent.setThinkingLevel': { params: { level: UiThinkingLevel }; result: { ok: true } };
  'agent.setSessionAgent': { params: { agentId: string }; result: { ok: true; agent?: UiAgentDescriptor } };
  'agent.setAgentOption': { params: { optionId: string; value: string }; result: { ok: true } };
  'agent.updateQueuedMessage': { params: { id: string; action: 'edit' | 'remove' | 'steer'; text?: string }; result: { ok: true } };
  'agent.interruptShellTools': { params: { toolCallId?: string } | void; result: { interrupted: number } };
  'agent.stopBackgroundTask': { params: { taskId: string }; result: { stopped: boolean } };
  'agent.respondExtensionDialog': { params: { id: string; value: UiExtensionDialogResponse }; result: { ok: true } };

  'workspace.listEntries': { params: { relativePath?: string } | void; result: WorkspaceEntry[] };
  'workspace.readFile': { params: { relativePath: string }; result: { path: string; content: string } };
  'workspace.gitStatus': { params: void; result: WorkspaceGitStatus };
  'workspace.gitDiff': { params: { relativePath: string; source?: 'staged' | 'unstaged' | 'all' }; result: { path: string; diff: string } };
  'workspace.branches': { params: void; result: WorkspaceBranches };
}

export type RemoteRpcMethod = keyof RemoteRpcMethodMap;

/** Static per-RPC scope table — authoritative on the server. */
export const REMOTE_RPC_REQUIRED_SCOPE: Record<RemoteRpcMethod, RemoteAccessScope> = {
  'environment.getDescriptor': 'chat:read',
  'agent.getSnapshot': 'chat:read',
  'agent.getHistoryPage': 'chat:read',
  'agent.listWorkspaces': 'chat:read',
  'agent.listConversationWorkspaces': 'chat:read',
  'agent.listSessions': 'chat:read',
  'agent.listSessionsPage': 'chat:read',
  'agent.listModels': 'chat:read',
  'agent.listAgents': 'chat:read',
  'agent.getInputQueue': 'chat:read',
  'agent.getPendingExtensionDialogs': 'chat:read',
  'agent.getFileChangeDiffs': 'chat:read',
  'agent.getSessionStats': 'chat:read',
  'agent.getMessageAttachment': 'chat:read',
  'agent.getToolResultImage': 'chat:read',

  'agent.prompt': 'chat:operate',
  'agent.abort': 'chat:operate',
  'agent.newSession': 'chat:operate',
  'agent.switchWorkspace': 'chat:operate',
  'agent.switchSession': 'chat:operate',
  'agent.setModel': 'chat:operate',
  'agent.setThinkingLevel': 'chat:operate',
  'agent.setSessionAgent': 'chat:operate',
  'agent.setAgentOption': 'chat:operate',
  'agent.updateQueuedMessage': 'chat:operate',
  'agent.interruptShellTools': 'chat:operate',
  'agent.stopBackgroundTask': 'chat:operate',
  'agent.respondExtensionDialog': 'chat:operate',

  'workspace.listEntries': 'workspace:read',
  'workspace.readFile': 'workspace:read',
  'workspace.gitStatus': 'workspace:read',
  'workspace.gitDiff': 'workspace:read',
  'workspace.branches': 'workspace:read',
};

export type RemoteRpcErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'unknown_method'
  | 'invalid_params'
  | 'internal';

export interface RemoteRpcErrorPayload {
  readonly code: RemoteRpcErrorCode;
  readonly message: string;
  readonly requiredScope?: RemoteAccessScope;
}

export type RemoteWsClientMessage =
  | { readonly type: 'rpc'; readonly id: string; readonly method: RemoteRpcMethod; readonly params?: unknown }
  | { readonly type: 'ping'; readonly ts: number };

export type RemoteWsPushEvent =
  | { readonly channel: 'agent-event'; readonly payload: AgentEventEnvelope }
  | { readonly channel: 'extension-dialog'; readonly payload: UiExtensionDialogRequest }
  | { readonly channel: 'extension-dialog-closed'; readonly payload: { readonly id: string } }
  | { readonly channel: 'endpoints-changed'; readonly payload: { readonly directEndpoints: readonly RemoteAdvertisedEndpoint[] } };

export type RemoteWsServerMessage =
  | {
      readonly type: 'hello';
      readonly protocolVersion: number;
      readonly environmentId: string;
      readonly label: string;
      readonly sessionId: string;
      readonly role: RemoteAccessRole;
      readonly scopes: readonly RemoteAccessScope[];
      readonly descriptor: RemoteEnvironmentDescriptor;
      readonly snapshot: AgentSnapshot;
      readonly pendingDialogs: readonly UiExtensionDialogRequest[];
    }
  | { readonly type: 'rpc-result'; readonly id: string; readonly ok: true; readonly result: unknown }
  | { readonly type: 'rpc-result'; readonly id: string; readonly ok: false; readonly error: RemoteRpcErrorPayload }
  | ({ readonly type: 'event' } & RemoteWsPushEvent)
  | { readonly type: 'pong'; readonly ts: number };

/* ------------------------------------------------------------------ */
/* Pairing URL helpers                                                */
/* ------------------------------------------------------------------ */

export interface ParsedRemotePairingUrl {
  readonly endpointUrl: string;
  readonly code: string;
  readonly environmentId?: string;
  readonly label?: string;
}

export function buildRemotePairingUrl(input: {
  readonly endpointUrl: string;
  readonly code: string;
  readonly environmentId: string;
  readonly label?: string;
}): string {
  const params = new URLSearchParams();
  params.set('url', input.endpointUrl.replace(/\/+$/, ''));
  params.set('code', input.code);
  params.set('env', input.environmentId);
  if (input.label && input.label.trim()) {
    params.set('label', input.label.trim());
  }
  return `${REMOTE_PAIRING_URL_SCHEME}://pair?${params.toString()}`;
}

export function parseRemotePairingUrl(raw: string): ParsedRemotePairingUrl | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol === `${REMOTE_PAIRING_URL_SCHEME}:`) {
    const endpointUrl = parsed.searchParams.get('url')?.trim() ?? '';
    const code = parsed.searchParams.get('code')?.trim() ?? '';
    if (!endpointUrl || !code) return null;
    try {
      const target = new URL(endpointUrl);
      if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
    } catch {
      return null;
    }
    const environmentId = parsed.searchParams.get('env')?.trim() || undefined;
    const label = parsed.searchParams.get('label')?.trim() || undefined;
    return {
      endpointUrl: endpointUrl.replace(/\/+$/, ''),
      code,
      ...(environmentId ? { environmentId } : {}),
      ...(label ? { label } : {}),
    };
  }
  // Also accept direct http(s)://host:port/#code=<code>, #pair=<code>, or ?code=<code>
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ''));
    const code =
      hashParams.get('code')?.trim() ||
      hashParams.get('pair')?.trim() ||
      parsed.searchParams.get('code')?.trim() ||
      '';
    if (!code) return null;
    const environmentId = hashParams.get('env')?.trim() || parsed.searchParams.get('env')?.trim() || undefined;
    const label = hashParams.get('label')?.trim() || parsed.searchParams.get('label')?.trim() || undefined;
    return {
      endpointUrl: parsed.origin,
      code,
      ...(environmentId ? { environmentId } : {}),
      ...(label ? { label } : {}),
    };
  }
  return null;
}

export function httpToWsUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported HTTP endpoint protocol: ${url.protocol}`);
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.origin;
}
