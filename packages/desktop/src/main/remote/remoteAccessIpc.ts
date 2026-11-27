/**
 * Main-process IPC & lifecycle orchestration for Pi Desktop remote mobile access.
 *
 * Persists configuration in `userData/remote-access.json` and auth credentials
 * in `userData/remote-access-auth.json` (keeping secrets out of desktopSettings.json).
 * The Cloudflare tunnel token is stored encrypted with Electron safeStorage; only
 * the in-memory config holds it in clear.
 * Coordinates the HTTP/WS RemoteServer, LAN interface discovery, Tailscale Serve,
 * and managed `cloudflared` tunnel subprocess.
 */

import { hostname } from 'node:os';
import { join } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import {
  DEFAULT_REMOTE_ACCESS_PORT,
  DEFAULT_TAILSCALE_SERVE_PORT,
  REMOTE_ACCESS_CHANNELS,
  REMOTE_PROTOCOL_VERSION,
  buildRemotePairingUrl,
  type CreateRemotePairingInput,
  type RemoteAdvertisedEndpoint,
  type RemoteCloudflareMode,
  type RemoteEnvironmentDescriptor,
  type RemoteExposureMode,
  type RemotePairingCreated,
  type UiRemoteAccessConfig,
  type UiRemoteAccessState,
  type UiRemoteTailscaleStatus,
} from '@pidesktop/shared/remoteAccess';
import type { AgentEventEnvelope, AgentSnapshot, UiExtensionDialogRequest } from '@pidesktop/shared';
import { broadcastToRenderers, handleRendererInvoke } from '../rendererIpc.ts';
import { decryptSecret, encryptSecret, isEncodedSecret } from '../secretStorage.ts';
import { readStateFile, writeStateFileAsync } from '../stateFiles.ts';
import { RemoteAuthStore } from './authStore.ts';
import { CloudflaredManager } from './cloudflaredService.ts';
import { buildAdvertisedEndpoints, discoverHostAddresses } from './networkDiscovery.ts';
import { createRemoteServer, type RemoteRpcHandlers, type RemoteServerHandle } from './remoteServer.ts';
import { disableTailscaleServe, enableTailscaleServe, probeTailscaleStatus } from './tailscaleService.ts';

interface PersistedRemoteAccessConfig {
  readonly version: 1;
  readonly enabled: boolean;
  readonly port: number;
  readonly exposureMode: RemoteExposureMode;
  readonly machineLabel: string;
  readonly tailscaleServeEnabled: boolean;
  readonly tailscaleServePort: number;
  readonly cloudflareMode: RemoteCloudflareMode;
  readonly cloudflareTunnelToken: string;
  readonly cloudflarePublicHostname: string;
}

const DEFAULT_CONFIG = (): PersistedRemoteAccessConfig => ({
  version: 1,
  enabled: false,
  port: DEFAULT_REMOTE_ACCESS_PORT,
  exposureMode: 'lan',
  machineLabel: hostname() || 'Pi Desktop',
  tailscaleServeEnabled: false,
  tailscaleServePort: DEFAULT_TAILSCALE_SERVE_PORT,
  cloudflareMode: 'off',
  cloudflareTunnelToken: '',
  cloudflarePublicHostname: '',
});

function isPersistedConfig(value: unknown): value is PersistedRemoteAccessConfig {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Partial<PersistedRemoteAccessConfig>;
  return (
    c.version === 1 &&
    typeof c.enabled === 'boolean' &&
    typeof c.port === 'number' &&
    Number.isInteger(c.port) &&
    c.port >= 1 &&
    c.port <= 65535 &&
    (c.exposureMode === 'local-only' || c.exposureMode === 'lan') &&
    typeof c.machineLabel === 'string' &&
    typeof c.tailscaleServeEnabled === 'boolean' &&
    typeof c.tailscaleServePort === 'number' &&
    (c.cloudflareMode === 'off' || c.cloudflareMode === 'quick' || c.cloudflareMode === 'named') &&
    typeof c.cloudflareTunnelToken === 'string' &&
    typeof c.cloudflarePublicHostname === 'string'
  );
}

/** On-disk form: the tunnel token is never written in clear. */
function toStoredConfig(config: PersistedRemoteAccessConfig): PersistedRemoteAccessConfig {
  return { ...config, cloudflareTunnelToken: encryptSecret(config.cloudflareTunnelToken) };
}

function sanitizeMachineLabel(raw: string | undefined, fallback: string): string {
  const cleaned = (raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
  return cleaned || fallback;
}

function normalizeCloudflarePublicHostname(raw: string): string {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f\s]/g, '').replace(/\/+$/, '').slice(0, 253);
  if (!cleaned) return '';
  const hasScheme = /^https?:\/\//i.test(cleaned);
  let parsed: URL;
  try {
    parsed = new URL(hasScheme ? cleaned : `https://${cleaned}`);
  } catch {
    throw new Error('Cloudflare 公网域名格式无效 / Invalid Cloudflare public hostname');
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Cloudflare 公网域名格式无效 / Invalid Cloudflare public hostname');
  }
  return hasScheme ? `${parsed.protocol}//${parsed.host}` : parsed.host;
}

const PAIRING_QR_TARGET_MAX_BYTES = 320;

/**
 * Builds a pairing URL whose UTF-8 byte length stays compact for QR scanning even
 * when `machineLabel` contains many non-ASCII characters (each percent-encodes to 9 bytes).
 * The full desktop label is still delivered in the pairing response descriptor.
 */
function buildCompactRemotePairingUrl(input: {
  readonly endpointUrl: string;
  readonly code: string;
  readonly environmentId: string;
  readonly label?: string;
}): string {
  const full = buildRemotePairingUrl(input);
  if (Buffer.byteLength(full, 'utf8') <= PAIRING_QR_TARGET_MAX_BYTES || !input.label?.trim()) {
    return full;
  }
  const chars = [...input.label.trim()];
  let lo = 0;
  let hi = chars.length;
  let best = buildRemotePairingUrl({ endpointUrl: input.endpointUrl, code: input.code, environmentId: input.environmentId });
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const candidateLabel = mid > 0 ? chars.slice(0, mid).join('') : undefined;
    const candidate = buildRemotePairingUrl({
      endpointUrl: input.endpointUrl,
      code: input.code,
      environmentId: input.environmentId,
      ...(candidateLabel ? { label: candidateLabel } : {}),
    });
    if (Buffer.byteLength(candidate, 'utf8') <= PAIRING_QR_TARGET_MAX_BYTES) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function normalizeConfigPatch(
  current: PersistedRemoteAccessConfig,
  patch: unknown,
): PersistedRemoteAccessConfig {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new Error('远程访问配置参数无效 / Invalid remote access configuration');
  }
  const input = patch as Partial<UiRemoteAccessConfig>;
  const port = input.port === undefined ? current.port : Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('端口无效（1-65535）/ Invalid port (1-65535)');
  }
  const tailscaleServePort =
    input.tailscaleServePort === undefined ? current.tailscaleServePort : Number(input.tailscaleServePort);
  if (!Number.isInteger(tailscaleServePort) || tailscaleServePort < 1 || tailscaleServePort > 65535) {
    throw new Error('Tailscale Serve 端口无效（1-65535）/ Invalid Tailscale Serve port');
  }
  const exposureMode: RemoteExposureMode =
    input.exposureMode === 'local-only' || input.exposureMode === 'lan'
      ? input.exposureMode
      : current.exposureMode;
  const cloudflareMode: RemoteCloudflareMode =
    input.cloudflareMode === 'off' || input.cloudflareMode === 'quick' || input.cloudflareMode === 'named'
      ? input.cloudflareMode
      : current.cloudflareMode;
  let cloudflareTunnelToken = current.cloudflareTunnelToken;
  if (typeof input.cloudflareTunnelToken === 'string') {
    if (/[\u0000-\u001f\u007f]/.test(input.cloudflareTunnelToken)) {
      throw new Error('Cloudflare Tunnel Token 包含非法控制字符 / Invalid control character in tunnel token');
    }
    cloudflareTunnelToken = input.cloudflareTunnelToken.trim();
  }
  const cloudflarePublicHostname =
    typeof input.cloudflarePublicHostname === 'string'
      ? normalizeCloudflarePublicHostname(input.cloudflarePublicHostname)
      : current.cloudflarePublicHostname;

  return {
    version: 1,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : current.enabled,
    port,
    exposureMode,
    machineLabel: sanitizeMachineLabel(input.machineLabel, current.machineLabel),
    tailscaleServeEnabled:
      typeof input.tailscaleServeEnabled === 'boolean'
        ? input.tailscaleServeEnabled
        : current.tailscaleServeEnabled,
    tailscaleServePort,
    cloudflareMode,
    cloudflareTunnelToken,
    cloudflarePublicHostname,
  };
}

export interface RemoteAccessController {
  getState(): UiRemoteAccessState;
  broadcastAgentEvent(envelope: AgentEventEnvelope): void;
  broadcastExtensionDialog(request: UiExtensionDialogRequest): void;
  broadcastExtensionDialogClosed(id: string): void;
  dispose(): Promise<void>;
}

export function registerRemoteAccessIpc(options: {
  readonly userDataDir: string;
  readonly appVersion: () => string;
  readonly getInitialSnapshot: () => Promise<AgentSnapshot>;
  readonly getPendingDialogs: () => UiExtensionDialogRequest[];
  readonly handlers: RemoteRpcHandlers;
  readonly requireTrustedSender: (event: IpcMainInvokeEvent) => void;
  readonly isMainWindow?: (win: Electron.BrowserWindow) => boolean;
}): RemoteAccessController {
  const configPath = join(options.userDataDir, 'remote-access.json');
  const authPath = join(options.userDataDir, 'remote-access-auth.json');
  const managedBinDir = join(options.userDataDir, 'bin');

  let config: PersistedRemoteAccessConfig;
  let legacyPlainToken = false;
  try {
    const stored = readStateFile(configPath, DEFAULT_CONFIG, isPersistedConfig);
    // Files written before encryption hold the raw token; read it once, then rewrite it encrypted.
    legacyPlainToken = stored.cloudflareTunnelToken.length > 0 && !isEncodedSecret(stored.cloudflareTunnelToken);
    config = {
      ...stored,
      cloudflareTunnelToken: legacyPlainToken ? stored.cloudflareTunnelToken : decryptSecret(stored.cloudflareTunnelToken),
    };
  } catch {
    config = DEFAULT_CONFIG();
  }

  const authStore = new RemoteAuthStore(authPath);
  let server: RemoteServerHandle | null = null;
  let lastError: string | null = null;
  let lastEndpointsKey = '';
  let tailscaleStatus: UiRemoteTailscaleStatus = {
    available: false,
    running: false,
    active: false,
    magicDnsName: null,
    tailnetIpv4: null,
    httpsEnabled: null,
    url: null,
    error: null,
  };
  let disposed = false;
  let opQueue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = opQueue.catch(() => {}).then(work);
    opQueue = next;
    return next;
  };
  if (legacyPlainToken) {
    // Queued with config writes so a later settings change can never be overwritten by the migration.
    void serialize(() => writeStateFileAsync(configPath, toStoredConfig(config))).catch((error: unknown) => {
      console.error('远程访问配置加密迁移失败 / failed to encrypt the stored tunnel token:', error);
    });
  }

  const emitState = () => {
    if (disposed) return;
    const current = buildState();
    broadcastToRenderers(REMOTE_ACCESS_CHANNELS.changed, current, options.isMainWindow);
    const endpointsKey = current.endpoints.map((e) => e.httpBaseUrl).join('|');
    if (endpointsKey !== lastEndpointsKey) {
      lastEndpointsKey = endpointsKey;
      server?.broadcastEvent({
        channel: 'endpoints-changed',
        payload: { directEndpoints: current.endpoints },
      });
    }
  };

  const cloudflared = new CloudflaredManager(managedBinDir, () => {
    emitState();
  });

  const unsubscribeAuth = authStore.onChanged(() => {
    emitState();
  });

  const computeEndpoints = (): RemoteAdvertisedEndpoint[] => {
    if (!server) return [];
    return buildAdvertisedEndpoints({
      port: server.port,
      exposureMode: config.exposureMode,
      addresses: discoverHostAddresses(),
      tailscaleHttpsUrl: tailscaleStatus.active ? tailscaleStatus.url : null,
      cloudflareUrl: cloudflared.getStatus().status === 'running' ? cloudflared.getStatus().url : null,
    });
  };

  const getDescriptor = (): RemoteEnvironmentDescriptor => ({
    environmentId: authStore.environmentId,
    label: config.machineLabel,
    appVersion: options.appVersion(),
    platform: process.platform,
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    capabilities: {
      bearer: true,
      wsTickets: true,
      scopes: true,
      directEndpoints: true,
      fileBrowse: true,
      gitDiff: true,
      backgroundTasks: true,
    },
    directEndpoints: computeEndpoints(),
  });

  const redactedConfig = (): UiRemoteAccessConfig => ({
    enabled: config.enabled,
    port: config.port,
    exposureMode: config.exposureMode,
    machineLabel: config.machineLabel,
    tailscaleServeEnabled: config.tailscaleServeEnabled,
    tailscaleServePort: config.tailscaleServePort,
    cloudflareMode: config.cloudflareMode,
    hasCloudflareTunnelToken: config.cloudflareTunnelToken.length > 0,
    cloudflarePublicHostname: config.cloudflarePublicHostname,
  });

  const buildState = (): UiRemoteAccessState => ({
    config: redactedConfig(),
    environmentId: authStore.environmentId,
    running: server !== null,
    bindHost: server?.bindHost ?? null,
    port: server?.port ?? null,
    endpoints: computeEndpoints(),
    tailscale: tailscaleStatus,
    cloudflare: cloudflared.getStatus(),
    pairingGrants: authStore.listPairingGrants(),
    sessions: authStore.listSessions(),
    error: lastError,
  });

  async function applyConfigInternal(next: PersistedRemoteAccessConfig): Promise<UiRemoteAccessState> {
    if (disposed) return buildState();
    const previous = config;
    config = next;
    await writeStateFileAsync(configPath, toStoredConfig(next));
    if (disposed) return buildState();
    lastError = null;

    const bindHost = next.exposureMode === 'lan' ? '0.0.0.0' : '127.0.0.1';
    const needServerRestart =
      !next.enabled ||
      server === null ||
      server.port !== next.port ||
      server.bindHost !== bindHost;

    if (needServerRestart && server) {
      await server.stop();
      server = null;
    }

    if (!next.enabled) {
      await cloudflared.stop();
      if (tailscaleStatus.active || previous.tailscaleServeEnabled) {
        await disableTailscaleServe({ servePort: previous.tailscaleServePort });
        tailscaleStatus = await probeTailscaleStatus();
      }
      emitState();
      return buildState();
    }

    let serverStartedNow = false;
    if (!server) {
      try {
        server = await createRemoteServer(
          { bindHost, port: next.port },
          {
            authStore,
            getDescriptor,
            getInitialSnapshot: options.getInitialSnapshot,
            getPendingDialogs: options.getPendingDialogs,
            handlers: options.handlers,
          },
        );
        serverStartedNow = true;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await cloudflared.stop();
        if (tailscaleStatus.active || previous.tailscaleServeEnabled) {
          await disableTailscaleServe({ servePort: previous.tailscaleServePort }).catch(() => {});
          tailscaleStatus = await probeTailscaleStatus().catch(() => ({ ...tailscaleStatus, active: false, url: null }));
        }
        emitState();
        return buildState();
      }
    }

    if (disposed) return buildState();

    // Reconcile Tailscale Serve (only when settings changed, server restarted, or active state drifted)
    const tailscaleChanged =
      serverStartedNow ||
      previous.enabled !== next.enabled ||
      previous.port !== next.port ||
      previous.tailscaleServeEnabled !== next.tailscaleServeEnabled ||
      previous.tailscaleServePort !== next.tailscaleServePort;

    if (next.tailscaleServeEnabled) {
      if (tailscaleChanged || !tailscaleStatus.active) {
        if (previous.tailscaleServeEnabled && previous.tailscaleServePort !== next.tailscaleServePort) {
          await disableTailscaleServe({ servePort: previous.tailscaleServePort });
        }
        tailscaleStatus = await enableTailscaleServe({
          localPort: server.port,
          servePort: next.tailscaleServePort,
        });
      }
    } else if (tailscaleChanged || tailscaleStatus.active) {
      if (tailscaleStatus.active || previous.tailscaleServeEnabled) {
        await disableTailscaleServe({ servePort: previous.tailscaleServePort });
      }
      tailscaleStatus = await probeTailscaleStatus();
    }

    if (disposed) return buildState();

    // Reconcile Cloudflare Tunnel only when tunnel config or local server port changed,
    // so unrelated edits (like machineLabel or Tailscale toggles) do not tear down a live Quick Tunnel.
    const cfStatus = cloudflared.getStatus();
    const cfConfigChanged =
      serverStartedNow ||
      previous.enabled !== next.enabled ||
      previous.port !== next.port ||
      previous.cloudflareMode !== next.cloudflareMode ||
      previous.cloudflareTunnelToken !== next.cloudflareTunnelToken ||
      previous.cloudflarePublicHostname !== next.cloudflarePublicHostname ||
      cfStatus.mode !== next.cloudflareMode ||
      (next.cloudflareMode !== 'off' && cfStatus.status === 'off');

    if (cfConfigChanged) {
      await cloudflared.applyConfig({
        mode: next.cloudflareMode,
        localPort: server.port,
        tunnelToken: next.cloudflareTunnelToken,
        publicHostname: next.cloudflarePublicHostname,
      });
    }

    emitState();
    return buildState();
  }

  handleRendererInvoke(REMOTE_ACCESS_CHANNELS.getState, async (event) => {
    options.requireTrustedSender(event);
    await Promise.all([
      cloudflared.refreshBinaryInfo().catch(() => {}),
      tailscaleStatus.active || config.tailscaleServeEnabled
        ? Promise.resolve()
        : probeTailscaleStatus().then((status) => {
            // Re-check after awaiting so an overlapping enableTailscaleServe cannot be clobbered.
            if (!disposed && !tailscaleStatus.active && !config.tailscaleServeEnabled) {
              tailscaleStatus = status;
            }
          }).catch(() => {}),
    ]);
    return buildState();
  });

  handleRendererInvoke(REMOTE_ACCESS_CHANNELS.setConfig, (event, patch: unknown) => {
    options.requireTrustedSender(event);
    return serialize(() => {
      if (disposed) return Promise.resolve(buildState());
      const next = normalizeConfigPatch(config, patch);
      return applyConfigInternal(next);
    });
  });

  handleRendererInvoke(REMOTE_ACCESS_CHANNELS.createPairing, (event, input: unknown) => {
    options.requireTrustedSender(event);
    return serialize(async (): Promise<RemotePairingCreated> => {
      if (disposed || !server) {
        throw new Error('请先启动远程访问服务 / Enable Remote Access before creating a pairing code');
      }
      const req = (typeof input === 'object' && input !== null ? input : {}) as Partial<CreateRemotePairingInput>;
      const role = req.role === 'read-only' ? 'read-only' : 'full';
      const endpoints = computeEndpoints();
      const requestedUrl = typeof req.endpointUrl === 'string' ? req.endpointUrl.trim().replace(/\/+$/, '') : '';
      const chosenEndpoint =
        (requestedUrl && endpoints.find((e) => e.httpBaseUrl === requestedUrl)?.httpBaseUrl) ||
        endpoints.find((e) => e.isDefault)?.httpBaseUrl ||
        endpoints.find((e) => e.kind !== 'loopback')?.httpBaseUrl ||
        endpoints[0]?.httpBaseUrl;
      if (!chosenEndpoint) {
        throw new Error('没有可用的访问地址 / No reachable endpoint is available');
      }
      const { grant, code } = await authStore.createPairingGrant({
        label: typeof req.label === 'string' ? req.label : undefined,
        role,
        expiresInMinutes: typeof req.expiresInMinutes === 'number' ? req.expiresInMinutes : undefined,
      });
      return {
        grant,
        code,
        endpointUrl: chosenEndpoint,
        pairingUrl: buildCompactRemotePairingUrl({
          endpointUrl: chosenEndpoint,
          code,
          environmentId: authStore.environmentId,
          label: config.machineLabel,
        }),
      };
    });
  });

  // Auth revocations run immediately outside the tunnel opQueue so a slow tunnel
  // operation or cloudflared download can never delay kicking out a revoked device.
  handleRendererInvoke(REMOTE_ACCESS_CHANNELS.revokePairing, async (event, grantId: unknown) => {
    options.requireTrustedSender(event);
    if (typeof grantId !== 'string' || !grantId) throw new Error('配对码 ID 无效');
    await authStore.revokePairingGrant(grantId);
    return buildState();
  });

  handleRendererInvoke(REMOTE_ACCESS_CHANNELS.revokeSession, async (event, sessionId: unknown) => {
    options.requireTrustedSender(event);
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('会话 ID 无效');
    await authStore.revokeSession(sessionId);
    return buildState();
  });

  handleRendererInvoke(REMOTE_ACCESS_CHANNELS.revokeAllSessions, async (event) => {
    options.requireTrustedSender(event);
    await authStore.revokeAllSessions();
    return buildState();
  });

  // Downloads run outside opQueue with their own single-flight + AbortController so
  // they cannot deadlock config edits, revocations, or app quit.
  handleRendererInvoke(REMOTE_ACCESS_CHANNELS.installCloudflared, async (event) => {
    options.requireTrustedSender(event);
    if (disposed) return buildState();
    await cloudflared.install();
    return buildState();
  });

  handleRendererInvoke(REMOTE_ACCESS_CHANNELS.refreshNetwork, (event) => {
    options.requireTrustedSender(event);
    return serialize(async () => {
      if (disposed) return buildState();
      await cloudflared.refreshBinaryInfo();
      if (!disposed && !tailscaleStatus.active && !config.tailscaleServeEnabled) {
        tailscaleStatus = await probeTailscaleStatus();
      }
      emitState();
      return buildState();
    });
  });

  // Auto-start at boot only when explicitly enabled (zero startup overhead when off)
  if (config.enabled) {
    void serialize(() => applyConfigInternal(config)).catch((error: unknown) => {
      console.error('远程访问服务启动失败 / remote access failed to start:', error);
    });
  }

  return {
    getState: buildState,
    broadcastAgentEvent(envelope) {
      server?.broadcastEvent({ channel: 'agent-event', payload: envelope });
    },
    broadcastExtensionDialog(request) {
      server?.broadcastEvent({ channel: 'extension-dialog', payload: request });
    },
    broadcastExtensionDialogClosed(id) {
      server?.broadcastEvent({ channel: 'extension-dialog-closed', payload: { id } });
    },
    async dispose() {
      disposed = true;
      unsubscribeAuth();
      cloudflared.abortInstall();
      await serialize(async () => {
        await cloudflared.stop();
        if (tailscaleStatus.active) {
          await disableTailscaleServe({ servePort: config.tailscaleServePort }).catch(() => {});
        }
        if (server) {
          await server.stop();
          server = null;
        }
        await authStore.flush();
      });
    },
  };
}
