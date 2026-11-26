/**
 * Persistent authentication store for Pi Desktop remote access.
 *
 * Security invariants (adapted from T3 Code's EnvironmentAuth):
 * - Environment ID persists across restarts and IP changes.
 * - Pairing codes are high-entropy, hashed with SHA-256 on disk, single-use,
 *   and time-bounded; raw secrets are returned ONLY at creation time.
 * - Client sessions carry explicit role/scopes, slide-expire after 30 days of
 *   inactivity, and immediately emit revocation callbacks to close live sockets.
 * - WebSocket tickets are in-memory, 60-second TTL, single-use, and cleared on
 *   session revocation so long-lived access tokens never appear in WS URLs.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  REMOTE_PAIRING_DEFAULT_TTL_MINUTES,
  scopesForRemoteRole,
  type RemoteAccessRole,
  type RemoteAccessScope,
  type RemoteClientSession,
  type RemotePairingGrant,
} from '@pidesktop/shared/remoteAccess';
import { readStateFile, writeStateFileAsync } from '../stateFiles.ts';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const WS_TICKET_TTL_MS = 60 * 1000;
const MAX_PAIRING_GRANTS = 32;
const MAX_SESSIONS = 64;

interface StoredPairingGrant {
  readonly id: string;
  readonly label: string;
  readonly role: RemoteAccessRole;
  readonly scopes: readonly RemoteAccessScope[];
  readonly codeHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  consumedAt: string | null;
}

interface StoredSession {
  readonly sessionId: string;
  readonly label: string;
  readonly deviceType: RemoteClientSession['deviceType'];
  readonly os: RemoteClientSession['os'];
  readonly role: RemoteAccessRole;
  readonly scopes: readonly RemoteAccessScope[];
  readonly tokenHash: string;
  readonly createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

interface PersistedAuthState {
  readonly version: 1;
  readonly environmentId: string;
  pairingGrants: StoredPairingGrant[];
  sessions: StoredSession[];
}

interface PendingWsTicket {
  readonly ticketHash: string;
  readonly sessionId: string;
  readonly expiresAtMs: number;
}

export interface AuthenticatedRemoteSession {
  readonly sessionId: string;
  readonly label: string;
  readonly role: RemoteAccessRole;
  readonly scopes: ReadonlySet<RemoteAccessScope>;
  readonly scopeList: readonly RemoteAccessScope[];
  readonly expiresAt: string;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function constantTimeHexEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function isPersistedAuthState(value: unknown): value is PersistedAuthState {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Partial<PersistedAuthState>;
  return (
    obj.version === 1 &&
    typeof obj.environmentId === 'string' &&
    obj.environmentId.length > 0 &&
    Array.isArray(obj.pairingGrants) &&
    Array.isArray(obj.sessions)
  );
}

function sanitizeLabel(raw: string | undefined, fallback: string): string {
  const cleaned = (raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
  return cleaned || fallback;
}

export class RemoteAuthStore {
  private readonly filePath: string;
  private state: PersistedAuthState;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly tickets = new Map<string, PendingWsTicket>();
  private readonly activeConnections = new Map<string, { count: number; connectedAt: string; remoteAddress: string | null }>();
  private readonly revokeListeners = new Set<(sessionId: string) => void>();
  private readonly changeListeners = new Set<() => void>();

  constructor(filePath: string) {
    this.filePath = filePath;
    const defaultState = (): PersistedAuthState => ({
      version: 1,
      environmentId: randomUUID(),
      pairingGrants: [],
      sessions: [],
    });
    let loaded: PersistedAuthState;
    let shouldPersistInitial = false;
    try {
      const candidate = readStateFile(filePath, () => {
        shouldPersistInitial = true;
        return defaultState();
      }, isPersistedAuthState);
      loaded = candidate;
    } catch {
      shouldPersistInitial = true;
      loaded = defaultState();
    }
    this.state = loaded;
    this.pruneExpired();
    if (shouldPersistInitial) {
      void this.persist();
    }
  }

  get environmentId(): string {
    return this.state.environmentId;
  }

  onSessionRevoked(listener: (sessionId: string) => void): () => void {
    this.revokeListeners.add(listener);
    return () => {
      this.revokeListeners.delete(listener);
    };
  }

  onChanged(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  listPairingGrants(): RemotePairingGrant[] {
    this.pruneExpired();
    return this.state.pairingGrants.map(({ codeHash: _ignored, ...grant }) => ({ ...grant }));
  }

  listSessions(): RemoteClientSession[] {
    this.pruneExpired();
    return this.state.sessions.map(({ tokenHash: _ignored, ...session }) => {
      const live = this.activeConnections.get(session.sessionId);
      return {
        ...session,
        connected: Boolean(live && live.count > 0),
        connectedAt: live?.connectedAt ?? null,
        remoteAddress: live?.remoteAddress ?? null,
      };
    });
  }

  async createPairingGrant(input: {
    readonly label?: string;
    readonly role: RemoteAccessRole;
    readonly expiresInMinutes?: number;
  }): Promise<{ readonly grant: RemotePairingGrant; readonly code: string }> {
    this.pruneExpired();
    const ttlMinutes = Math.max(1, Math.min(60, Math.round(input.expiresInMinutes ?? REMOTE_PAIRING_DEFAULT_TTL_MINUTES)));
    const now = Date.now();
    const id = randomUUID();
    const code = randomBytes(24).toString('base64url');
    const scopes = scopesForRemoteRole(input.role);
    const stored: StoredPairingGrant = {
      id,
      label: sanitizeLabel(input.label, input.role === 'read-only' ? 'Read-only device' : 'Mobile device'),
      role: input.role,
      scopes,
      codeHash: sha256Hex(code),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMinutes * 60_000).toISOString(),
      consumedAt: null,
    };
    this.state.pairingGrants.unshift(stored);
    if (this.state.pairingGrants.length > MAX_PAIRING_GRANTS) {
      this.state.pairingGrants.length = MAX_PAIRING_GRANTS;
    }
    await this.persist();
    this.emitChanged();
    const { codeHash: _ignored, ...grant } = stored;
    return { grant, code };
  }

  async revokePairingGrant(grantId: string): Promise<boolean> {
    const before = this.state.pairingGrants.length;
    this.state.pairingGrants = this.state.pairingGrants.filter((g) => g.id !== grantId);
    if (this.state.pairingGrants.length === before) return false;
    await this.persist();
    this.emitChanged();
    return true;
  }

  async exchangePairingCode(input: {
    readonly code: string;
    readonly clientLabel?: string;
    readonly deviceType?: RemoteClientSession['deviceType'];
    readonly os?: RemoteClientSession['os'];
  }): Promise<{ readonly accessToken: string; readonly session: AuthenticatedRemoteSession } | null> {
    this.pruneExpired();
    const trimmed = input.code.trim();
    if (!trimmed || trimmed.length > 256) return null;
    const candidateHash = sha256Hex(trimmed);
    const now = Date.now();

    let matched: StoredPairingGrant | null = null;
    for (const grant of this.state.pairingGrants) {
      if (grant.consumedAt !== null) continue;
      if (Date.parse(grant.expiresAt) <= now) continue;
      if (constantTimeHexEqual(grant.codeHash, candidateHash)) {
        matched = grant;
        break;
      }
    }
    if (!matched) return null;

    // Consume immediately (single-use)
    matched.consumedAt = new Date(now).toISOString();
    // Remove consumed grant from pending list
    this.state.pairingGrants = this.state.pairingGrants.filter((g) => g.id !== matched!.id);

    const accessToken = `pdr_${randomBytes(32).toString('base64url')}`;
    const sessionId = randomUUID();
    const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
    const stored: StoredSession = {
      sessionId,
      label: sanitizeLabel(input.clientLabel, matched.label),
      deviceType: input.deviceType ?? 'mobile',
      os: input.os ?? 'unknown',
      role: matched.role,
      scopes: [...matched.scopes],
      tokenHash: sha256Hex(accessToken),
      createdAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      expiresAt,
    };
    this.state.sessions.unshift(stored);
    if (this.state.sessions.length > MAX_SESSIONS) {
      const removed = this.state.sessions.splice(MAX_SESSIONS);
      for (const old of removed) this.notifySessionRevoked(old.sessionId);
    }
    await this.persist();
    this.emitChanged();

    return {
      accessToken,
      session: this.toAuthenticated(stored),
    };
  }

  authenticateBearer(authorizationHeader: string | undefined): AuthenticatedRemoteSession | null {
    if (!authorizationHeader || !/^Bearer\s+/i.test(authorizationHeader)) return null;
    const token = authorizationHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token || token.length > 256) return null;
    this.pruneExpired();
    const candidateHash = sha256Hex(token);
    const now = Date.now();
    for (const session of this.state.sessions) {
      if (Date.parse(session.expiresAt) <= now) continue;
      if (constantTimeHexEqual(session.tokenHash, candidateHash)) {
        // Slide session expiry on active use (throttled writes)
        const lastSeenMs = Date.parse(session.lastSeenAt);
        if (!Number.isFinite(lastSeenMs) || now - lastSeenMs > 5 * 60_000) {
          session.lastSeenAt = new Date(now).toISOString();
          session.expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
          void this.persist();
        }
        return this.toAuthenticated(session);
      }
    }
    return null;
  }

  mintWebSocketTicket(sessionId: string): { readonly ticket: string; readonly expiresAt: string } | null {
    const exists = this.state.sessions.some((s) => s.sessionId === sessionId);
    if (!exists) return null;
    this.pruneExpiredTickets();
    const ticket = randomBytes(24).toString('base64url');
    const ticketHash = sha256Hex(ticket);
    const expiresAtMs = Date.now() + WS_TICKET_TTL_MS;
    this.tickets.set(ticketHash, { ticketHash, sessionId, expiresAtMs });
    return { ticket, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  consumeWebSocketTicket(ticket: string): AuthenticatedRemoteSession | null {
    const trimmed = ticket.trim();
    if (!trimmed || trimmed.length > 256) return null;
    this.pruneExpiredTickets();
    const ticketHash = sha256Hex(trimmed);
    const entry = this.tickets.get(ticketHash);
    if (!entry) return null;
    // Always delete immediately — strictly single-use
    this.tickets.delete(ticketHash);
    if (entry.expiresAtMs <= Date.now()) return null;
    const session = this.state.sessions.find((s) => s.sessionId === entry.sessionId);
    if (!session || Date.parse(session.expiresAt) <= Date.now()) return null;
    session.lastSeenAt = new Date().toISOString();
    session.expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    void this.persist();
    return this.toAuthenticated(session);
  }

  markConnected(sessionId: string, remoteAddress: string | null): void {
    const existing = this.activeConnections.get(sessionId);
    if (existing) {
      existing.count += 1;
      existing.remoteAddress = remoteAddress ?? existing.remoteAddress;
    } else {
      this.activeConnections.set(sessionId, {
        count: 1,
        connectedAt: new Date().toISOString(),
        remoteAddress,
      });
    }
    this.emitChanged();
  }

  markDisconnected(sessionId: string): void {
    const existing = this.activeConnections.get(sessionId);
    if (!existing) return;
    existing.count -= 1;
    if (existing.count <= 0) {
      this.activeConnections.delete(sessionId);
    }
    this.emitChanged();
  }

  async revokeSession(sessionId: string): Promise<boolean> {
    const before = this.state.sessions.length;
    this.state.sessions = this.state.sessions.filter((s) => s.sessionId !== sessionId);
    if (this.state.sessions.length === before) return false;
    this.deleteTicketsForSession(sessionId);
    this.activeConnections.delete(sessionId);
    await this.persist();
    this.notifySessionRevoked(sessionId);
    this.emitChanged();
    return true;
  }

  async revokeAllSessions(): Promise<number> {
    const ids = this.state.sessions.map((s) => s.sessionId);
    if (ids.length === 0) return 0;
    this.state.sessions = [];
    this.tickets.clear();
    this.activeConnections.clear();
    await this.persist();
    for (const id of ids) this.notifySessionRevoked(id);
    this.emitChanged();
    return ids.length;
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private toAuthenticated(stored: StoredSession): AuthenticatedRemoteSession {
    return {
      sessionId: stored.sessionId,
      label: stored.label,
      role: stored.role,
      scopes: new Set(stored.scopes),
      scopeList: [...stored.scopes],
      expiresAt: stored.expiresAt,
    };
  }

  private deleteTicketsForSession(sessionId: string): void {
    for (const [hash, ticket] of this.tickets.entries()) {
      if (ticket.sessionId === sessionId) this.tickets.delete(hash);
    }
  }

  private pruneExpiredTickets(): void {
    const now = Date.now();
    for (const [hash, ticket] of this.tickets.entries()) {
      if (ticket.expiresAtMs <= now) this.tickets.delete(hash);
    }
  }

  private pruneExpired(): void {
    const now = Date.now();
    this.state.pairingGrants = this.state.pairingGrants.filter(
      (g) => g.consumedAt === null && Date.parse(g.expiresAt) > now,
    );
    this.state.sessions = this.state.sessions.filter(
      (s) => Date.parse(s.expiresAt) > now || this.activeConnections.has(s.sessionId),
    );
  }

  private notifySessionRevoked(sessionId: string): void {
    for (const listener of this.revokeListeners) {
      try {
        listener(sessionId);
      } catch {
        // isolate listener errors
      }
    }
  }

  private emitChanged(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch {
        // isolate listener errors
      }
    }
  }

  private persist(): Promise<void> {
    const snapshot: PersistedAuthState = {
      version: 1,
      environmentId: this.state.environmentId,
      pairingGrants: this.state.pairingGrants.map((g) => ({ ...g })),
      sessions: this.state.sessions.map((s) => ({ ...s })),
    };
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(() => writeStateFileAsync(this.filePath, snapshot));
    return this.writeQueue;
  }
}
