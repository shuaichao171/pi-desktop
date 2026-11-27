/**
 * @pidesktop/shared — Platform-agnostic remote client runtime (used by apps/mobile
 * and E2E tests).
 *
 * Implements T3 Code's key mobile connection invariants:
 * - Multi-route ordering (LAN > Tailscale HTTPS > Cloudflare Tunnel > custom)
 * - Automatic route learning from server descriptor.directEndpoints
 * - Environment ID verification before sending credentials to any direct route
 * - Never downgrades an HTTPS-paired credential to a plain HTTP route
 * - Short-lived single-use WebSocket ticket exchange before /ws upgrade
 * - Single reconnect supervisor with jittered exponential backoff + periodic
 *   higher-priority route promotion (automatically switches back to LAN at home)
 */

import {
  REMOTE_PROTOCOL_VERSION,
  httpToWsUrl,
  parseRemotePairingUrl,
  type RemoteAccessRole,
  type RemoteAccessScope,
  type RemoteAdvertisedEndpoint,
  type RemoteClientSession,
  type RemoteEndpointKind,
  type RemoteEnvironmentDescriptor,
  type RemotePublicEnvironmentDescriptor,
  type RemotePairExchangeResponse,
  type RemoteRpcErrorPayload,
  type RemoteRpcMethod,
  type RemoteRpcMethodMap,
  type RemoteWsClientMessage,
  type RemoteWsPushEvent,
  type RemoteWsServerMessage,
  type RemoteWsTicketResponse,
} from './remoteAccess.ts';
import type { AgentSnapshot, UiExtensionDialogRequest, UiSessionSummary } from './index.ts';

export interface SavedRemoteRoute {
  readonly id: string;
  readonly kind: RemoteEndpointKind;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly learned: boolean;
}

export interface SavedRemoteEnvironment {
  readonly environmentId: string;
  readonly label: string;
  readonly accessToken: string;
  readonly sessionId: string;
  readonly role: RemoteAccessRole;
  readonly scopes: readonly RemoteAccessScope[];
  readonly pairedOverHttps: boolean;
  readonly expiresAt: string;
  readonly routes: readonly SavedRemoteRoute[];
  readonly addedAt: string;
  readonly lastConnectedAt: string | null;
}

export type RemoteConnectionPhase =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'auth-error';

export interface RemoteConnectionState {
  readonly phase: RemoteConnectionPhase;
  readonly environmentId: string | null;
  readonly activeRoute: SavedRemoteRoute | null;
  readonly descriptor: RemoteEnvironmentDescriptor | null;
  readonly role: RemoteAccessRole | null;
  readonly scopes: readonly RemoteAccessScope[];
  readonly error: string | null;
  readonly attempt: number;
}

export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface RemoteFetchRequestInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface RemoteFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type WebSocketFactory = (url: string) => WebSocketLike;
export type FetchLike = (input: string, init?: RemoteFetchRequestInit) => Promise<RemoteFetchResponse>;

export interface RemoteClientTransport {
  readonly fetch: FetchLike;
  readonly createWebSocket: WebSocketFactory;
}

export class RemoteRpcCallError extends Error {
  readonly code: RemoteRpcErrorPayload['code'];
  readonly requiredScope?: RemoteAccessScope;

  constructor(payload: RemoteRpcErrorPayload) {
    super(payload.message);
    this.name = 'RemoteRpcCallError';
    this.code = payload.code;
    this.requiredScope = payload.requiredScope;
  }
}

export class RemoteAuthRevokedError extends Error {
  constructor(message = 'Session expired or revoked. Pair this device again.') {
    super(message);
    this.name = 'RemoteAuthRevokedError';
  }
}

const ROUTE_PRIORITY: Record<RemoteEndpointKind, number> = {
  loopback: 0,
  lan: 1,
  tailscale: 2,
  custom: 3,
  cloudflare: 4,
};

export function classifyEndpointKind(httpBaseUrl: string): RemoteEndpointKind {
  try {
    const url = new URL(httpBaseUrl);
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return 'loopback';
    if (host.endsWith('.ts.net')) return 'tailscale';
    if (host.endsWith('.trycloudflare.com')) return 'cloudflare';
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(host)) return 'tailscale';
    if (
      /^10\.\d+\.\d+\.\d+$/.test(host) ||
      /^192\.168\.\d+\.\d+$/.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host)
    ) {
      return 'lan';
    }
    return 'custom';
  } catch {
    return 'custom';
  }
}

export function sortRemoteRoutes(routes: readonly SavedRemoteRoute[]): SavedRemoteRoute[] {
  return [...routes].sort((a, b) => {
    const diff = ROUTE_PRIORITY[a.kind] - ROUTE_PRIORITY[b.kind];
    if (diff !== 0) return diff;
    if (a.learned !== b.learned) return a.learned ? 1 : -1;
    return a.httpBaseUrl.localeCompare(b.httpBaseUrl);
  });
}

function normalizeOrigin(url: string): string {
  return new URL(url).origin;
}

/**
 * Merges server-advertised direct endpoints into a saved environment's route list:
 * - Never adopts loopback endpoints (loopback names the phone itself).
 * - Never sends an HTTPS-paired token over plain HTTP LAN (only Tailscale/HTTPS).
 * - Updates existing learned routes when the desktop's LAN IP changes.
 */
export function mergeLearnedRemoteRoutes(
  env: SavedRemoteEnvironment,
  reported: readonly RemoteAdvertisedEndpoint[],
): SavedRemoteRoute[] {
  const manualRoutes = env.routes.filter((route) => !route.learned);
  const manualOrigins = new Set(manualRoutes.map((route) => normalizeOrigin(route.httpBaseUrl)));
  const learned: SavedRemoteRoute[] = [];

  for (const endpoint of reported) {
    if (endpoint.kind === 'loopback') continue;
    let origin: string;
    try {
      origin = normalizeOrigin(endpoint.httpBaseUrl);
    } catch {
      continue;
    }
    if (manualOrigins.has(origin)) continue;
    // Security invariant (matches T3 Code): never downgrade an HTTPS-paired token to plain HTTP
    if (env.pairedOverHttps && (!endpoint.isHttps || !origin.startsWith('https://'))) continue;
    learned.push({
      id: `learned:${endpoint.kind}:${origin}`,
      kind: endpoint.kind,
      label: endpoint.label,
      httpBaseUrl: origin,
      wsBaseUrl: httpToWsUrl(origin),
      learned: true,
    });
  }

  return sortRemoteRoutes([...manualRoutes, ...learned]);
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RemoteFetchRequestInit | undefined,
  timeoutMs: number,
): Promise<RemoteFetchResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchEnvironmentDescriptor(
  transport: Pick<RemoteClientTransport, 'fetch'>,
  httpBaseUrl: string,
  timeoutMs = 3_000,
): Promise<RemotePublicEnvironmentDescriptor> {
  const origin = normalizeOrigin(httpBaseUrl);
  const response = await fetchWithTimeout(
    transport.fetch,
    `${origin}/.well-known/pidesktop/environment`,
    { method: 'GET', headers: { accept: 'application/json' } },
    timeoutMs,
  );
  if (!response.ok) {
    throw new Error(`Environment probe failed (${response.status})`);
  }
  const payload = (await response.json()) as RemotePublicEnvironmentDescriptor;
  if (!payload || typeof payload.environmentId !== 'string' || !payload.environmentId) {
    throw new Error('Invalid environment descriptor');
  }
  return payload;
}

export async function pairWithDesktop(input: {
  readonly transport: Pick<RemoteClientTransport, 'fetch'>;
  readonly pairingUrlOrAddress: string;
  readonly code?: string;
  readonly clientLabel: string;
  readonly deviceType: RemoteClientSession['deviceType'];
  readonly os: RemoteClientSession['os'];
}): Promise<SavedRemoteEnvironment> {
  const trimmedInput = input.pairingUrlOrAddress.trim();
  const parsed = parseRemotePairingUrl(trimmedInput);
  if (!parsed && /^pidesktop:/i.test(trimmedInput)) {
    throw new Error('Invalid pairing URL or code');
  }
  const endpointUrl = parsed?.endpointUrl ?? trimmedInput.replace(/\/+$/, '');
  const code = parsed?.code ?? input.code?.trim() ?? '';
  if (!endpointUrl || !code) {
    throw new Error('Invalid pairing URL or code');
  }
  const normalizedUrl = /^https?:\/\//i.test(endpointUrl) ? endpointUrl : `http://${endpointUrl}`;
  const origin = normalizeOrigin(normalizedUrl);

  // Verify the host answers as Pi Desktop (and matches expected environmentId if encoded in QR)
  const descriptor = await fetchEnvironmentDescriptor(input.transport, origin, 8_000);
  if (parsed?.environmentId && descriptor.environmentId !== parsed.environmentId) {
    throw new Error('Environment ID mismatch — the server at this address does not match the pairing code');
  }
  if (descriptor.protocolVersion > REMOTE_PROTOCOL_VERSION) {
    throw new Error(`Unsupported desktop protocol version ${descriptor.protocolVersion}`);
  }

  const response = await fetchWithTimeout(
    input.transport.fetch,
    `${origin}/api/auth/pair`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        code,
        clientLabel: input.clientLabel,
        deviceType: input.deviceType,
        os: input.os,
      }),
    },
    10_000,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `Pairing failed (${response.status})`);
  }
  const exchanged = (await response.json()) as RemotePairExchangeResponse;
  const kind = classifyEndpointKind(origin);
  const pairedOverHttps = origin.startsWith('https://');
  const primaryRoute: SavedRemoteRoute = {
    id: `manual:${kind}:${origin}`,
    kind,
    label: kind === 'lan' ? 'LAN' : kind === 'tailscale' ? 'Tailscale HTTPS' : kind === 'cloudflare' ? 'Cloudflare Tunnel' : new URL(origin).host,
    httpBaseUrl: origin,
    wsBaseUrl: httpToWsUrl(origin),
    learned: false,
  };
  const baseEnv: SavedRemoteEnvironment = {
    environmentId: exchanged.environmentId,
    label: exchanged.label || exchanged.descriptor.label,
    accessToken: exchanged.accessToken,
    sessionId: exchanged.sessionId,
    role: exchanged.role,
    scopes: exchanged.scopes,
    pairedOverHttps,
    expiresAt: exchanged.expiresAt,
    routes: [primaryRoute],
    addedAt: new Date().toISOString(),
    lastConnectedAt: new Date().toISOString(),
  };
  return {
    ...baseEnv,
    routes: mergeLearnedRemoteRoutes(baseEnv, exchanged.descriptor.directEndpoints),
  };
}

export interface RemoteConnectionCallbacks {
  onStateChange?: (state: RemoteConnectionState) => void;
  onHello?: (hello: Extract<RemoteWsServerMessage, { type: 'hello' }>) => void;
  onEvent?: (event: RemoteWsPushEvent) => void;
  onEnvironmentUpdated?: (env: SavedRemoteEnvironment) => void;
}

/**
 * Single connection supervisor for one desktop environment:
 * - Resolves the best reachable route (verifying environmentId before sending tokens)
 * - Exchanges Bearer token for a single-use short-lived wsTicket
 * - Maintains JSON-RPC request/response correlation and heartbeat ping/pong
 * - Automatically probes higher-priority routes (e.g. LAN) while connected via Tunnel
 * - Reconnects with jittered exponential backoff unless explicitly disconnected or revoked
 */
export class RemoteConnectionClient {
  private readonly transport: RemoteClientTransport;
  private readonly callbacks: RemoteConnectionCallbacks;
  private env: SavedRemoteEnvironment | null = null;
  private socket: WebSocketLike | null = null;
  private state: RemoteConnectionState = {
    phase: 'disconnected',
    environmentId: null,
    activeRoute: null,
    descriptor: null,
    role: null,
    scopes: [],
    error: null,
    attempt: 0,
  };
  private desired = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private betterRouteTimer: ReturnType<typeof setInterval> | null = null;
  private connectGeneration = 0;
  private checkingBetterRoute = false;
  private rpcSeq = 0;
  private readonly pendingRpcs = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private lastPongAt = 0;
  private readonly heartbeatIntervalMs: number;
  private readonly betterRouteCheckIntervalMs: number;

  constructor(
    transport: RemoteClientTransport,
    callbacks: RemoteConnectionCallbacks = {},
    options?: { readonly heartbeatIntervalMs?: number; readonly betterRouteCheckIntervalMs?: number },
  ) {
    this.transport = transport;
    this.callbacks = callbacks;
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? 25_000;
    this.betterRouteCheckIntervalMs = options?.betterRouteCheckIntervalMs ?? 60_000;
  }

  getState(): RemoteConnectionState {
    return this.state;
  }

  getEnvironment(): SavedRemoteEnvironment | null {
    return this.env;
  }

  connect(env: SavedRemoteEnvironment): void {
    this.disconnect();
    this.env = env;
    this.desired = true;
    this.setState({
      phase: 'connecting',
      environmentId: env.environmentId,
      activeRoute: null,
      descriptor: null,
      role: env.role,
      scopes: env.scopes,
      error: null,
      attempt: 1,
    });
    void this.runConnectAttempt(++this.connectGeneration);
  }

  disconnect(): void {
    this.desired = false;
    this.connectGeneration += 1;
    this.clearTimers();
    this.teardownSocket(1000, 'client disconnect');
    this.rejectAllPending(new Error('Disconnected'));
    this.setState({
      phase: 'disconnected',
      environmentId: this.env?.environmentId ?? null,
      activeRoute: null,
      descriptor: null,
      role: null,
      scopes: [],
      error: null,
      attempt: 0,
    });
  }

  /** Called on app foreground or network change to probe or promote to a faster route. */
  async probeOrReconnect(): Promise<void> {
    if (!this.desired || !this.env) return;
    if (this.state.phase === 'reconnecting') {
      this.clearTimers();
      this.teardownSocket(1000, 'reconnect triggered');
      void this.runConnectAttempt(++this.connectGeneration);
      return;
    }
    if (this.state.phase === 'connected') {
      await this.checkForBetterRoute();
    }
  }

  async call<M extends RemoteRpcMethod>(
    method: M,
    ...args: RemoteRpcMethodMap[M]['params'] extends void ? [] : [RemoteRpcMethodMap[M]['params']]
  ): Promise<RemoteRpcMethodMap[M]['result']> {
    const socket = this.socket;
    if (!socket || this.state.phase !== 'connected') {
      throw new Error('Not connected to desktop');
    }
    const id = `rpc-${++this.rpcSeq}`;
    const payload: RemoteWsClientMessage = {
      type: 'rpc',
      id,
      method,
      ...(args.length > 0 ? { params: args[0] } : {}),
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpcs.delete(id);
        reject(new Error(`RPC ${method} timed out`));
      }, 30_000);
      this.pendingRpcs.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        socket.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pendingRpcs.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private setState(next: RemoteConnectionState): void {
    this.state = next;
    this.callbacks.onStateChange?.(next);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.betterRouteTimer) {
      clearInterval(this.betterRouteTimer);
      this.betterRouteTimer = null;
    }
  }

  private teardownSocket(code?: number, reason?: string): void {
    const active = this.socket;
    this.socket = null;
    if (!active) return;
    active.onopen = null;
    active.onmessage = null;
    active.onerror = null;
    active.onclose = null;
    try {
      active.close(code, reason);
    } catch {
      // ignore close errors
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, entry] of this.pendingRpcs.entries()) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pendingRpcs.delete(id);
    }
  }

  private async mintWsTicket(route: SavedRemoteRoute, accessToken: string): Promise<RemoteWsTicketResponse> {
    const response = await fetchWithTimeout(
      this.transport.fetch,
      `${normalizeOrigin(route.httpBaseUrl)}/api/auth/websocket-ticket`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
        },
      },
      8_000,
    );
    if (response.status === 401 || response.status === 403) {
      throw new RemoteAuthRevokedError();
    }
    if (!response.ok) {
      throw new Error(`Failed to mint WebSocket ticket (${response.status})`);
    }
    return (await response.json()) as RemoteWsTicketResponse;
  }

  private async connectViaRoute(
    env: SavedRemoteEnvironment,
    route: SavedRemoteRoute,
    generation: number,
  ): Promise<void> {
    const timeoutMs = route.kind === 'lan' || route.kind === 'loopback' ? 2_500 : 8_000;
    const descriptor = await fetchEnvironmentDescriptor(this.transport, route.httpBaseUrl, timeoutMs);
    if (!this.desired || generation !== this.connectGeneration) return;
    if (descriptor.environmentId !== env.environmentId) {
      throw new Error(`Different desktop answered at ${route.httpBaseUrl}`);
    }
    const ticketRes = await this.mintWsTicket(route, env.accessToken);
    if (!this.desired || generation !== this.connectGeneration) return;

    const wsUrl = new URL('/ws', route.wsBaseUrl);
    wsUrl.searchParams.set('ticket', ticketRes.ticket);
    const socket = this.transport.createWebSocket(wsUrl.toString());
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const preHelloEvents: RemoteWsPushEvent[] = [];
      const openTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('WebSocket handshake timed out'));
      }, 10_000);

      socket.onmessage = (event) => {
        if (generation !== this.connectGeneration) return;
        const raw = typeof event.data === 'string' ? event.data : String(event.data ?? '');
        let msg: RemoteWsServerMessage;
        try {
          msg = JSON.parse(raw) as RemoteWsServerMessage;
        } catch {
          return;
        }
        if (msg.type === 'hello') {
          if (!settled) {
            settled = true;
            clearTimeout(openTimeout);
            this.onHelloReceived(env, route, msg);
            for (const buffered of preHelloEvents) {
              if (
                buffered.channel === 'agent-event' &&
                buffered.payload.sequence <= msg.snapshot.sequence
              ) {
                continue;
              }
              this.handleSocketMessage({ type: 'event', ...buffered });
            }
            preHelloEvents.length = 0;
            resolve();
          }
          return;
        }
        if (!settled) {
          if (msg.type === 'event' && preHelloEvents.length < 500) {
            const { type: _type, ...pushEvent } = msg;
            preHelloEvents.push(pushEvent as RemoteWsPushEvent);
          }
          return;
        }
        this.handleSocketMessage(msg);
      };

      socket.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(openTimeout);
          reject(new Error('WebSocket connection error'));
        }
      };

      socket.onclose = (closeEvent) => {
        const code = closeEvent?.code ?? 1006;
        if (!settled) {
          settled = true;
          clearTimeout(openTimeout);
          if (code === 4401) {
            reject(new RemoteAuthRevokedError('Session revoked by desktop'));
          } else {
            reject(new Error(`WebSocket closed before hello (${code})`));
          }
          return;
        }
        if (generation !== this.connectGeneration) return;
        this.handleLiveSocketClose(code);
      };
    });
  }

  private async runConnectAttempt(generation: number): Promise<void> {
    const env = this.env;
    if (!this.desired || !env || generation !== this.connectGeneration) return;

    const routes = sortRemoteRoutes(env.routes).filter(
      (route) => !env.pairedOverHttps || route.httpBaseUrl.startsWith('https://'),
    );
    let lastError: Error | null = null;

    try {
      for (const route of routes) {
        if (!this.desired || generation !== this.connectGeneration) return;
        try {
          await this.connectViaRoute(env, route, generation);
          return;
        } catch (error) {
          if (error instanceof RemoteAuthRevokedError) {
            throw error;
          }
          if (!this.desired || generation !== this.connectGeneration) return;
          this.teardownSocket();
          lastError = error instanceof Error ? error : new Error(String(error));
        }
      }
      throw lastError ?? new Error('No reachable route to desktop');
    } catch (error) {
      if (!this.desired || generation !== this.connectGeneration) return;
      this.teardownSocket();
      if (error instanceof RemoteAuthRevokedError) {
        this.desired = false;
        this.clearTimers();
        this.setState({
          ...this.state,
          phase: 'auth-error',
          activeRoute: null,
          error: error.message,
        });
        return;
      }
      this.scheduleReconnect(error instanceof Error ? error.message : String(error));
    }
  }

  private onHelloReceived(
    env: SavedRemoteEnvironment,
    route: SavedRemoteRoute,
    hello: Extract<RemoteWsServerMessage, { type: 'hello' }>,
  ): void {
    this.lastPongAt = Date.now();
    const mergedRoutes = mergeLearnedRemoteRoutes(env, hello.descriptor.directEndpoints);
    const updatedEnv: SavedRemoteEnvironment = {
      ...env,
      label: hello.label || env.label,
      role: hello.role,
      scopes: hello.scopes,
      routes: mergedRoutes,
      lastConnectedAt: new Date().toISOString(),
    };
    this.env = updatedEnv;
    this.callbacks.onEnvironmentUpdated?.(updatedEnv);
    this.setState({
      phase: 'connected',
      environmentId: hello.environmentId,
      activeRoute: route,
      descriptor: hello.descriptor,
      role: hello.role,
      scopes: hello.scopes,
      error: null,
      attempt: 0,
    });
    this.startLiveTimers();
    this.callbacks.onHello?.(hello);
  }

  private handleSocketMessage(msg: RemoteWsServerMessage): void {
    if (msg.type === 'pong') {
      this.lastPongAt = Date.now();
      return;
    }
    if (msg.type === 'rpc-result') {
      const pending = this.pendingRpcs.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingRpcs.delete(msg.id);
      if (msg.ok) pending.resolve(msg.result);
      else pending.reject(new RemoteRpcCallError(msg.error));
      return;
    }
    if (msg.type === 'event') {
      if (msg.channel === 'endpoints-changed' && this.env) {
        const merged = mergeLearnedRemoteRoutes(this.env, msg.payload.directEndpoints);
        this.env = { ...this.env, routes: merged };
        this.callbacks.onEnvironmentUpdated?.(this.env);
      }
      this.callbacks.onEvent?.(msg);
    }
  }

  private handleLiveSocketClose(code: number): void {
    this.clearTimers();
    this.socket = null;
    this.rejectAllPending(new Error(`Connection closed (${code})`));
    if (!this.desired) return;
    if (code === 4401) {
      this.desired = false;
      this.setState({
        ...this.state,
        phase: 'auth-error',
        activeRoute: null,
        error: 'This device was revoked on the desktop.',
      });
      return;
    }
    this.scheduleReconnect(`Connection closed (${code})`);
  }

  private scheduleReconnect(reason: string): void {
    const nextAttempt = this.state.attempt + 1;
    const baseDelay = Math.min(30_000, 1_000 * 2 ** Math.min(nextAttempt, 5));
    const jittered = Math.round(baseDelay * (0.65 + Math.random() * 0.35));
    this.setState({
      ...this.state,
      phase: 'reconnecting',
      activeRoute: null,
      error: reason,
      attempt: nextAttempt,
    });
    const generation = ++this.connectGeneration;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.runConnectAttempt(generation);
    }, jittered);
  }

  private startLiveTimers(): void {
    this.clearTimers();
    this.heartbeatTimer = setInterval(() => {
      if (!this.socket || this.state.phase !== 'connected') return;
      if (Date.now() - this.lastPongAt > this.heartbeatIntervalMs * 2.5) {
        this.teardownSocket(4000, 'heartbeat timeout');
        this.handleLiveSocketClose(4000);
        return;
      }
      try {
        const ping: RemoteWsClientMessage = { type: 'ping', ts: Date.now() };
        this.socket.send(JSON.stringify(ping));
      } catch {
        this.teardownSocket(4000, 'ping write failed');
        this.handleLiveSocketClose(4000);
      }
    }, this.heartbeatIntervalMs);

    this.betterRouteTimer = setInterval(() => {
      void this.checkForBetterRoute();
    }, this.betterRouteCheckIntervalMs);
  }

  private async checkForBetterRoute(): Promise<void> {
    if (this.checkingBetterRoute) return;
    const env = this.env;
    const active = this.state.activeRoute;
    const gen = this.connectGeneration;
    if (!this.desired || !env || !active || this.state.phase !== 'connected') return;
    this.checkingBetterRoute = true;
    try {
      const sorted = sortRemoteRoutes(env.routes);
      const activeRank = ROUTE_PRIORITY[active.kind];
      for (const candidate of sorted) {
        if (ROUTE_PRIORITY[candidate.kind] >= activeRank) break;
        if (env.pairedOverHttps && !candidate.httpBaseUrl.startsWith('https://')) continue;
        try {
          const descriptor = await fetchEnvironmentDescriptor(this.transport, candidate.httpBaseUrl, 2_000);
          if (
            !this.desired ||
            gen !== this.connectGeneration ||
            this.env?.environmentId !== env.environmentId ||
            this.state.phase !== 'connected'
          ) {
            return;
          }
          if (descriptor.environmentId === env.environmentId) {
            // Faster route is reachable (e.g. phone returned to home Wi-Fi) — switch over!
            this.clearTimers();
            this.teardownSocket(1000, 'switching to faster route');
            this.rejectAllPending(new Error('Switching to faster route'));
            this.setState({
              ...this.state,
              phase: 'reconnecting',
              activeRoute: null,
              error: null,
            });
            void this.runConnectAttempt(++this.connectGeneration);
            return;
          }
        } catch {
          // Not reachable yet; keep current route
        }
      }
    } finally {
      this.checkingBetterRoute = false;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Live Conversation Snapshot Reducer (shared by mobile UI & tests)   */
/* ------------------------------------------------------------------ */

export function applyRemoteAgentEvent(snapshot: AgentSnapshot | null, envelope: { sequence: number; event: import('./index.ts').AgentUiEvent }): AgentSnapshot | null {
  const { event, sequence } = envelope;
  if (snapshot && sequence <= snapshot.sequence) {
    return snapshot;
  }
  if (event.type === 'ready') {
    const sameSession = Boolean(
      snapshot &&
      snapshot.cwd === event.cwd &&
      snapshot.sessionId === event.sessionId &&
      snapshot.sessionPath === event.sessionPath,
    );
    return {
      sequence,
      ...(snapshot?.sessionRuntimes ? { sessionRuntimes: snapshot.sessionRuntimes } : {}),
      subagentFleet: sameSession ? (snapshot?.subagentFleet ?? null) : null,
      backgroundTasks: sameSession ? (snapshot?.backgroundTasks ?? []) : [],
      ...(event.agent ? { agent: event.agent } : {}),
      ...(event.defaultAgentId ? { defaultAgentId: event.defaultAgentId } : snapshot?.defaultAgentId ? { defaultAgentId: snapshot.defaultAgentId } : {}),
      status: sameSession && snapshot?.status === 'busy' ? 'busy' : 'idle',
      statusMessage: undefined,
      retryAttempt: undefined,
      retryMaxAttempts: undefined,
      model: event.model,
      modelName: event.modelName ?? null,
      modelProvider: event.modelProvider,
      thinkingLevel: event.thinkingLevel,
      availableThinkingLevels: event.availableThinkingLevels,
      contextUsage: event.contextUsage,
      cwd: event.cwd,
      sessionId: event.sessionId,
      sessionPath: event.sessionPath,
      messages: event.messages,
      activities: event.activities,
      runs: event.runs ?? [],
      queuedCount: 0,
      queuedMessages: [],
      fileChanges: event.fileChanges,
      fileChangeTurns: event.fileChangeTurns ?? [],
      fileChangeActiveRunId: event.fileChangeActiveRunId ?? null,
      ...(event.historyTotal !== undefined ? { historyTotal: event.historyTotal } : {}),
      error: null,
      errorInfo: null,
    };
  }
  if (!snapshot) return null;

  switch (event.type) {
    case 'reset':
      return {
        ...snapshot,
        sequence,
        status: 'uninitialized',
        statusMessage: undefined,
        retryAttempt: undefined,
        retryMaxAttempts: undefined,
        model: '',
        modelName: null,
        modelProvider: '',
        agent: undefined,
        thinkingLevel: 'off',
        availableThinkingLevels: [],
        contextUsage: null,
        cwd: event.cwd,
        sessionId: null,
        sessionPath: null,
        messages: [],
        activities: [],
        runs: [],
        queuedCount: 0,
        queuedMessages: [],
        fileChanges: [],
        fileChangeTurns: [],
        fileChangeActiveRunId: null,
        subagentFleet: null,
        backgroundTasks: [],
        historyTotal: 0,
        error: null,
        errorInfo: null,
      };
    case 'status':
      return {
        ...snapshot,
        sequence,
        status: event.status,
        statusMessage: event.message,
        retryAttempt: event.attempt,
        retryMaxAttempts: event.maxAttempts,
        ...(event.status === 'busy' ? { error: null, errorInfo: null } : {}),
        ...(event.status === 'error'
          ? {
              runs: (snapshot.runs ?? []).map((run) =>
                run.status === 'running' ? { ...run, status: 'interrupted' as const, finishedAt: null } : run,
              ),
              messages: snapshot.messages.map((message) =>
                message.status === 'streaming'
                  ? {
                      ...message,
                      status: 'error' as const,
                      errorMessage: event.message ?? message.errorMessage,
                      thinkingStatus: message.thinkingStatus === 'streaming' ? ('error' as const) : message.thinkingStatus,
                    }
                  : message,
              ),
              activities: snapshot.activities.map((activity) =>
                activity.status === 'running' ? { ...activity, status: 'interrupted' as const } : activity,
              ),
            }
          : {}),
      };
    case 'model':
      return {
        ...snapshot,
        sequence,
        ...(event.agent ? { agent: event.agent } : {}),
        model: event.model,
        modelName: event.modelName ?? null,
        modelProvider: event.modelProvider,
        thinkingLevel: event.thinkingLevel,
        availableThinkingLevels: event.availableThinkingLevels,
        contextUsage: event.contextUsage,
      };
    case 'thinking-level':
      return { ...snapshot, sequence, thinkingLevel: event.level };
    case 'context-usage':
      return { ...snapshot, sequence, contextUsage: event.contextUsage };
    case 'run': {
      const existing = snapshot.runs ?? [];
      const idx = existing.findIndex((r) => r.id === event.run.id);
      const runs = idx >= 0
        ? existing.map((r, i) => (i === idx ? event.run : r))
        : [...existing, event.run];
      return { ...snapshot, sequence, runs };
    }
    case 'user-message':
      return {
        ...snapshot,
        sequence,
        messages: [
          ...snapshot.messages.filter((m) => m.id !== event.id),
          {
            id: event.id,
            order: event.order,
            role: 'user',
            text: event.text,
            status: 'done',
            ...(event.runId ? { runId: event.runId } : {}),
            ...(event.attachments ? { attachments: event.attachments } : {}),
            ...(event.attachmentsOmitted !== undefined ? { attachmentsOmitted: event.attachmentsOmitted } : {}),
            ...(event.attachmentReferences ? { attachmentReferences: event.attachmentReferences } : {}),
          },
        ],
      };
    case 'system-message':
      return {
        ...snapshot,
        sequence,
        messages: [
          ...snapshot.messages.filter((m) => m.id !== event.id),
          {
            id: event.id,
            order: event.order,
            role: 'system',
            text: event.text,
            status: 'done',
            ...(event.systemKind ? { systemKind: event.systemKind } : {}),
            ...(event.runId ? { runId: event.runId } : {}),
          },
        ],
      };
    case 'assistant-start':
      return {
        ...snapshot,
        sequence,
        error: null,
        errorInfo: null,
        messages: [
          ...snapshot.messages.filter((m) => m.id !== event.id),
          {
            id: event.id,
            order: event.order,
            role: 'assistant',
            text: '',
            status: 'streaming',
            ...(event.runId ? { runId: event.runId } : {}),
          },
        ],
      };
    case 'assistant-delta':
      return {
        ...snapshot,
        sequence,
        messages: snapshot.messages.map((m) =>
          m.id === event.id ? { ...m, text: m.text + event.delta, status: 'streaming' } : m,
        ),
      };
    case 'assistant-thinking':
      return {
        ...snapshot,
        sequence,
        messages: snapshot.messages.map((m) =>
          m.id === event.id && m.status === 'streaming'
            ? { ...m, thinking: event.thinking, thinkingStatus: event.thinkingStatus, thinkingTruncated: event.thinkingTruncated }
            : m,
        ),
      };
    case 'assistant-end':
      return {
        ...snapshot,
        sequence,
        messages: snapshot.messages.map((m) =>
          m.id === event.id
            ? {
                ...m,
                text: event.text || m.text,
                thinking: event.thinking ?? m.thinking,
                thinkingTruncated: event.thinkingTruncated ?? m.thinkingTruncated,
                thinkingStatus:
                  event.thinkingStatus ??
                  (m.thinkingStatus
                    ? event.errorMessage
                      ? 'error'
                      : event.aborted
                        ? 'interrupted'
                        : 'done'
                    : undefined),
                ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
                ...(event.error ? { error: event.error } : {}),
                status: event.aborted || event.errorMessage ? 'error' : 'done',
              }
            : m,
        ),
        ...(event.errorMessage ? { error: event.errorMessage, errorInfo: event.error ?? null } : {}),
      };
    case 'tool': {
      const exists = snapshot.activities.some((a) => a.id === event.activity.id);
      return {
        ...snapshot,
        sequence,
        activities: exists
          ? snapshot.activities.map((a) => (a.id === event.activity.id ? event.activity : a))
          : [...snapshot.activities, event.activity],
      };
    }
    case 'queue':
      return { ...snapshot, sequence, queuedCount: event.count, queuedMessages: event.items };
    case 'file-changes':
      return {
        ...snapshot,
        sequence,
        fileChanges: event.items,
        fileChangeTurns: event.turns,
        fileChangeActiveRunId: event.activeRunId,
      };
    case 'subagent-fleet':
      if (event.sessionPath !== undefined && event.sessionPath !== snapshot.sessionPath) {
        return { ...snapshot, sequence };
      }
      return { ...snapshot, sequence, subagentFleet: event.fleet };
    case 'background-tasks':
      if (event.sessionPath !== undefined && event.sessionPath !== snapshot.sessionPath) {
        return { ...snapshot, sequence };
      }
      if (event.sessionId !== undefined && event.sessionId !== snapshot.sessionId) {
        return { ...snapshot, sequence };
      }
      return { ...snapshot, sequence, backgroundTasks: event.tasks };
    case 'session-runtime': {
      const existing = snapshot.sessionRuntimes ?? [];
      const eventCwdKey = remoteWorkspaceKey(event.cwd);
      const filtered = existing.filter(
        (item) => !(remoteWorkspaceKey(item.cwd) === eventCwdKey && item.path === event.path),
      );
      return {
        ...snapshot,
        sequence,
        sessionRuntimes: [...filtered, { cwd: event.cwd, path: event.path, runtime: event.runtime }],
      };
    }
    case 'error':
      return { ...snapshot, sequence, error: event.message, errorInfo: event.error ?? null };
    default:
      return { ...snapshot, sequence };
  }
}

export function mergeRemotePendingDialog(
  current: readonly UiExtensionDialogRequest[],
  incoming: UiExtensionDialogRequest,
): UiExtensionDialogRequest[] {
  if (incoming.kind === 'notify') return [...current];
  return [...current.filter((item) => item.id !== incoming.id), incoming];
}

export function removeRemotePendingDialog(
  current: readonly UiExtensionDialogRequest[],
  id: string,
): UiExtensionDialogRequest[] {
  return current.filter((item) => item.id !== id);
}

/** Same folder identity as the desktop sidebar: Windows drive and UNC paths compare case-insensitively. */
export function remoteWorkspaceKey(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:(?:\/|$)/i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
}

/** Folders the desktop creates for conversations started without a project. */
export function isRemoteConversationWorkspace(path: string, conversationWorkspaces: readonly string[]): boolean {
  const key = remoteWorkspaceKey(path);
  return conversationWorkspaces.some((item) => remoteWorkspaceKey(item) === key);
}

export interface RemoteWorkspaceGroups {
  /** One tab per project, in the desktop's order. */
  readonly projects: string[];
  /** Conversation folders; the desktop lists their sessions together as "Unassigned sessions". */
  readonly conversations: string[];
}

/** Splits `agent.listWorkspaces` like the desktop sidebar; paths keep the host's spelling for later RPCs. */
export function groupRemoteWorkspaces(
  workspaces: readonly string[],
  conversationWorkspaces: readonly string[],
): RemoteWorkspaceGroups {
  const conversationKeys = new Set(conversationWorkspaces.map(remoteWorkspaceKey));
  const seen = new Set<string>();
  const projects: string[] = [];
  const conversations: string[] = [];
  for (const workspace of workspaces) {
    const key = remoteWorkspaceKey(workspace);
    if (seen.has(key)) continue;
    seen.add(key);
    (conversationKeys.has(key) ? conversations : projects).push(workspace);
  }
  return { projects, conversations };
}

/** Sessions of several folders as one list: pinned first, then most recently modified. */
export function mergeRemoteSessionLists(
  lists: readonly (readonly UiSessionSummary[] | undefined)[],
): UiSessionSummary[] {
  const seen = new Set<string>();
  const merged: UiSessionSummary[] = [];
  for (const list of lists) {
    for (const session of list ?? []) {
      if (seen.has(session.path)) continue;
      seen.add(session.path);
      merged.push(session);
    }
  }
  const modifiedAt = (session: UiSessionSummary) => {
    const time = Date.parse(session.modified);
    return Number.isFinite(time) ? time : 0;
  };
  return merged.sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || modifiedAt(b) - modifiedAt(a));
}
