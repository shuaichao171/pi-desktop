/**
 * HTTP + WebSocket remote control server for Pi Desktop.
 *
 * Endpoints:
 * - GET  /.well-known/pidesktop/environment   Unauthenticated minimal probe (environment id + protocol only)
 * - POST /api/auth/pair                       Exchange single-use pairing code -> Bearer session
 * - GET  /api/auth/session                    Verify Bearer session + return descriptor
 * - POST /api/auth/websocket-ticket           Mint 60s single-use wsTicket over authenticated HTTP
 * - GET  /ws?ticket=<wsTicket>                WebSocket JSON-RPC + real-time agent/dialog event stream
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  REMOTE_PROTOCOL_VERSION,
  REMOTE_RPC_REQUIRED_SCOPE,
  toPublicEnvironmentDescriptor,
  type RemoteEnvironmentDescriptor,
  type RemotePairExchangeRequest,
  type RemotePairExchangeResponse,
  type RemoteRpcErrorCode,
  type RemoteRpcMethod,
  type RemoteRpcMethodMap,
  type RemoteSessionInfoResponse,
  type RemoteWsClientMessage,
  type RemoteWsPushEvent,
  type RemoteWsServerMessage,
  type RemoteWsTicketResponse,
} from '@pidesktop/shared/remoteAccess';
import type { AgentSnapshot, UiExtensionDialogRequest } from '@pidesktop/shared';
import type { AuthenticatedRemoteSession, RemoteAuthStore } from './authStore.ts';
import { acceptWebSocketUpgrade, rejectHttpUpgrade, type RemoteWebSocketConnection } from './wsServer.ts';

const MAX_HTTP_BODY_BYTES = 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_STALE_MS = 70_000;
const MAX_TOTAL_SOCKETS = 32;
const MAX_SOCKETS_PER_SESSION = 6;
const MAX_PRE_HELLO_EVENTS = 500;

export type RemoteRpcHandlers = {
  [M in RemoteRpcMethod]: (
    params: RemoteRpcMethodMap[M]['params'],
    session: AuthenticatedRemoteSession,
  ) => Promise<RemoteRpcMethodMap[M]['result']> | RemoteRpcMethodMap[M]['result'];
};

export interface RemoteServerDeps {
  readonly authStore: RemoteAuthStore;
  readonly getDescriptor: () => RemoteEnvironmentDescriptor;
  readonly getInitialSnapshot: () => Promise<AgentSnapshot>;
  readonly getPendingDialogs: () => UiExtensionDialogRequest[];
  readonly handlers: RemoteRpcHandlers;
}

export interface RemoteServerHandle {
  readonly port: number;
  readonly bindHost: string;
  broadcastEvent(event: RemoteWsPushEvent): void;
  activeSocketCount(): number;
  stop(): Promise<void>;
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
} as const;

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  response.writeHead(status, {
    ...CORS_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    pragma: 'no-cache',
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buf.length;
    if (bytes > MAX_HTTP_BODY_BYTES) {
      throw new Error('Request body too large');
    }
    chunks.push(buf);
  }
  if (bytes === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ConnectedSocketEntry {
  readonly ws: RemoteWebSocketConnection;
  readonly session: AuthenticatedRemoteSession;
  lastActivityAt: number;
  helloSent: boolean;
  pendingEvents: string[];
}

export async function createRemoteServer(
  options: { readonly bindHost: string; readonly port: number },
  deps: RemoteServerDeps,
): Promise<RemoteServerHandle> {
  const connectedSockets = new Set<ConnectedSocketEntry>();

  const unsubscribeRevoke = deps.authStore.onSessionRevoked((sessionId) => {
    for (const entry of [...connectedSockets]) {
      if (entry.session.sessionId === sessionId) {
        entry.ws.close(4401, 'Session revoked');
        connectedSockets.delete(entry);
      }
    }
  });

  const handleHttp = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = (request.method ?? 'GET').toUpperCase();
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1');
    } catch {
      sendJson(response, 400, { error: 'Invalid request URL' });
      return;
    }

    if (method === 'OPTIONS') {
      response.writeHead(204, CORS_HEADERS);
      response.end();
      return;
    }

    if (method === 'GET' && url.pathname === '/.well-known/pidesktop/environment') {
      // Unauthenticated (possibly via a public tunnel): never leak label, version or LAN addresses here.
      sendJson(response, 200, toPublicEnvironmentDescriptor(deps.getDescriptor()));
      return;
    }

    if (method === 'POST' && url.pathname === '/api/auth/pair') {
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : 'Invalid JSON body',
        });
        return;
      }
      if (!isRecord(body) || typeof body.code !== 'string' || !body.code.trim()) {
        sendJson(response, 400, { error: 'Missing pairing code' });
        return;
      }
      const reqPayload: RemotePairExchangeRequest = {
        code: body.code,
        ...(typeof body.clientLabel === 'string' ? { clientLabel: body.clientLabel } : {}),
        ...(body.deviceType === 'mobile' || body.deviceType === 'tablet' || body.deviceType === 'desktop'
          ? { deviceType: body.deviceType }
          : {}),
        ...(body.os === 'ios' || body.os === 'android' || body.os === 'macos' || body.os === 'windows' || body.os === 'linux'
          ? { os: body.os }
          : {}),
      };
      const exchanged = await deps.authStore.exchangePairingCode(reqPayload);
      if (!exchanged) {
        sendJson(response, 401, { error: 'Invalid, expired, or already used pairing code' });
        return;
      }
      const descriptor = deps.getDescriptor();
      const result: RemotePairExchangeResponse = {
        accessToken: exchanged.accessToken,
        sessionId: exchanged.session.sessionId,
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        role: exchanged.session.role,
        scopes: exchanged.session.scopeList,
        expiresAt: exchanged.session.expiresAt,
        descriptor,
      };
      sendJson(response, 200, result);
      return;
    }

    if (method === 'GET' && url.pathname === '/api/auth/session') {
      const session = deps.authStore.authenticateBearer(request.headers.authorization);
      if (!session) {
        sendJson(response, 401, { error: 'Unauthorized' });
        return;
      }
      const result: RemoteSessionInfoResponse = {
        authenticated: true,
        sessionId: session.sessionId,
        role: session.role,
        scopes: session.scopeList,
        expiresAt: session.expiresAt,
        descriptor: deps.getDescriptor(),
      };
      sendJson(response, 200, result);
      return;
    }

    if (method === 'POST' && url.pathname === '/api/auth/websocket-ticket') {
      const session = deps.authStore.authenticateBearer(request.headers.authorization);
      if (!session) {
        sendJson(response, 401, { error: 'Unauthorized' });
        return;
      }
      const ticket = deps.authStore.mintWebSocketTicket(session.sessionId);
      if (!ticket) {
        sendJson(response, 401, { error: 'Session is no longer active' });
        return;
      }
      const result: RemoteWsTicketResponse = ticket;
      sendJson(response, 200, result);
      return;
    }

    sendJson(response, 404, { error: `Unknown endpoint: ${method} ${url.pathname}` });
  };

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // Node does not attach an 'error' listener to upgrade sockets; bind one immediately
    // so mid-handshake TCP resets cannot throw uncaught exceptions in the main process.
    socket.on('error', () => {
      try {
        if (!socket.destroyed) socket.destroy();
      } catch {
        // ignore
      }
    });

    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1');
    } catch {
      rejectHttpUpgrade(socket, 400, 'Bad Request');
      return;
    }
    if (url.pathname !== '/ws') {
      rejectHttpUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (connectedSockets.size >= MAX_TOTAL_SOCKETS) {
      rejectHttpUpgrade(socket, 503, 'Too Many Connections');
      return;
    }
    const ticket = url.searchParams.get('ticket') ?? '';
    const session = deps.authStore.consumeWebSocketTicket(ticket);
    if (!session) {
      rejectHttpUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    let sessionSocketCount = 0;
    for (const existing of connectedSockets) {
      if (existing.session.sessionId === session.sessionId) sessionSocketCount += 1;
    }
    if (sessionSocketCount >= MAX_SOCKETS_PER_SESSION) {
      rejectHttpUpgrade(socket, 429, 'Too Many Session Connections');
      return;
    }

    const ws = acceptWebSocketUpgrade(request, socket, head);
    if (!ws || !ws.isOpen()) return;

    const entry: ConnectedSocketEntry = {
      ws,
      session,
      lastActivityAt: Date.now(),
      helloSent: false,
      pendingEvents: [],
    };
    connectedSockets.add(entry);
    deps.authStore.markConnected(session.sessionId, ws.remoteAddress);

    const sendServerMessage = (msg: RemoteWsServerMessage) => {
      if (ws.isOpen()) {
        ws.sendText(JSON.stringify(msg));
      }
    };

    const sendRpcError = (
      id: string,
      code: RemoteRpcErrorCode,
      message: string,
      requiredScope?: (typeof REMOTE_RPC_REQUIRED_SCOPE)[RemoteRpcMethod],
    ) => {
      sendServerMessage({
        type: 'rpc-result',
        id,
        ok: false,
        error: { code, message, ...(requiredScope ? { requiredScope } : {}) },
      });
    };

    ws.onPong(() => {
      entry.lastActivityAt = Date.now();
    });

    ws.onClose(() => {
      if (connectedSockets.delete(entry)) {
        deps.authStore.markDisconnected(session.sessionId);
      }
    });

    ws.onMessage((raw) => {
      entry.lastActivityAt = Date.now();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      if (!isRecord(parsed) || typeof parsed.type !== 'string') return;
      const msg = parsed as RemoteWsClientMessage;

      if (msg.type === 'ping') {
        sendServerMessage({ type: 'pong', ts: typeof msg.ts === 'number' ? msg.ts : Date.now() });
        return;
      }

      if (msg.type !== 'rpc' || typeof msg.id !== 'string' || typeof msg.method !== 'string') {
        return;
      }

      // The socket only lives as long as its session: an expired or revoked session
      // stops here even if the revocation callback has not closed the socket yet.
      if (!deps.authStore.touchSession(session.sessionId)) {
        sendRpcError(msg.id, 'unauthorized', 'Session expired or revoked');
        ws.close(4401, 'Session expired');
        return;
      }

      const method = msg.method as RemoteRpcMethod;
      if (!Object.hasOwn(REMOTE_RPC_REQUIRED_SCOPE, method)) {
        sendRpcError(msg.id, 'unknown_method', `Unknown RPC method: ${msg.method}`);
        return;
      }

      const requiredScope = REMOTE_RPC_REQUIRED_SCOPE[method];
      if (!session.scopes.has(requiredScope)) {
        sendRpcError(
          msg.id,
          'forbidden',
          `This session lacks the '${requiredScope}' permission required for ${method}`,
          requiredScope,
        );
        return;
      }

      const handler = deps.handlers[method] as (
        params: unknown,
        auth: AuthenticatedRemoteSession,
      ) => Promise<unknown> | unknown;

      void Promise.resolve()
        .then(() => handler(msg.params, session))
        .then(
          (result) => {
            sendServerMessage({ type: 'rpc-result', id: msg.id, ok: true, result });
          },
          (error: unknown) => {
            sendRpcError(
              msg.id,
              'internal',
              error instanceof Error ? error.message : String(error),
            );
          },
        );
    });

    // Send initial hello with descriptor, live snapshot, and pending dialogs
    void deps
      .getInitialSnapshot()
      .then((snapshot) => {
        if (!ws.isOpen()) return;
        const descriptor = deps.getDescriptor();
        sendServerMessage({
          type: 'hello',
          protocolVersion: REMOTE_PROTOCOL_VERSION,
          environmentId: descriptor.environmentId,
          label: descriptor.label,
          sessionId: session.sessionId,
          role: session.role,
          scopes: session.scopeList,
          descriptor,
          snapshot,
          pendingDialogs: deps.getPendingDialogs(),
        });
        entry.helloSent = true;
        if (entry.pendingEvents.length > 0) {
          const queued = entry.pendingEvents;
          entry.pendingEvents = [];
          for (const frame of queued) {
            if (!ws.isOpen()) break;
            ws.sendText(frame);
          }
        }
      })
      .catch((error: unknown) => {
        ws.close(1011, error instanceof Error ? error.message.slice(0, 100) : 'Snapshot unavailable');
      });
  };

  const server: Server = createServer((request, response) => {
    void handleHttp(request, response).catch((error: unknown) => {
      try {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      } catch {
        // response already committed
      }
    });
  });

  server.on('upgrade', handleUpgrade);

  const heartbeatTimer = setInterval(() => {
    // Expired sessions close their sockets through the revocation callback.
    deps.authStore.sweepExpired();
    const now = Date.now();
    for (const entry of [...connectedSockets]) {
      if (!entry.ws.isOpen()) {
        connectedSockets.delete(entry);
        deps.authStore.markDisconnected(entry.session.sessionId);
        continue;
      }
      if (now - entry.lastActivityAt > HEARTBEAT_STALE_MS) {
        entry.ws.close(4000, 'Heartbeat timeout');
        continue;
      }
      entry.ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(options.port, options.bindHost, () => {
        server.off('error', onError);
        resolve();
      });
    });
  } catch (error) {
    clearInterval(heartbeatTimer);
    unsubscribeRevoke();
    throw error;
  }

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : options.port;

  return {
    port: actualPort,
    bindHost: options.bindHost,
    broadcastEvent(event: RemoteWsPushEvent) {
      if (connectedSockets.size === 0) return;
      const frame = JSON.stringify({ type: 'event', ...event } satisfies RemoteWsServerMessage);
      for (const entry of connectedSockets) {
        if (!entry.ws.isOpen()) continue;
        if (!entry.session.scopes.has('chat:read')) continue;
        if (!entry.helloSent) {
          if (entry.pendingEvents.length < MAX_PRE_HELLO_EVENTS) {
            entry.pendingEvents.push(frame);
          }
          continue;
        }
        entry.ws.sendText(frame);
      }
    },
    activeSocketCount: () => connectedSockets.size,
    async stop() {
      clearInterval(heartbeatTimer);
      unsubscribeRevoke();
      for (const entry of [...connectedSockets]) {
        entry.ws.close(1001, 'Server shutting down');
      }
      connectedSockets.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      });
    },
  };
}
