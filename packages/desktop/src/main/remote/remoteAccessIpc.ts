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
  const cloudflareTunnelToken =
    typeof input.cloudflareTunnelToken === 'string'
      ? input.cloudflareTunnelToken.trim()
      : current.cloudflareTunnelToken;
  const cloudflarePublicHostname =
    typeof input.cloudflarePublicHostname === 'string'
      ? input.cloudflarePublicHostname.replace(/[\u0000-\u001f\u007f\s]/g, '').slice(0, 253)
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
    const previous = config;
    config = next;
    await writeStateFileAsync(configPath, toStoredConfig(next));
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
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await cloudflared.stop();
        emitState();
        return buildState();
      }
    }

    // Reconcile Tailscale Serve
    if (next.tailscaleServeEnabled) {
      if (previous.tailscaleServeEnabled && previous.tailscaleServePort !== next.tailscaleServePort) {
        await disableTailscaleServe({ servePort: previous.tailscaleServePort });
      }
      tailscaleStatus = await enableTailscaleServe({
        localPort: server.port,
        servePort: next.tailscaleServePort,
      });
    } else {
      if (tailscaleStatus.active || previous.tailscaleServeEnabled) {
        await disableTailscaleServe({ servePort: previous.tailscaleServePort });
      }
      tailscaleStatus = await probeTailscaleStatus();
    }

    // Reconcile Cloudflare Tunnel
    await cloudflared.applyConfig({
      mode: next.cloudflareMode,
      localPort: server.port,
      tunnelToken: next.cloudflareTunnelToken,
      publicHostname: next.cloudflarePublicHostname,
    });

    emitState();
    return buildState();
  }

  handleRendererInvoke(REMOTE_ACCESS_CHANNELS.getState, async (event) => {
    options.requireTrustedSender(event);
    await Promise.all([
      cloudflared.refreshBinaryInfo().catch(() => {}),
      tailscaleStatus.active
        ? Promise.resolve()
        : probeTailscaleStatus().then((status) => {
            tailscaleStatus = status;
          }).catch(() => {}),
    ]);
    return buildState();
  });

  handleRendererInvoke(REMOTE_ACCESS_CHANNELS.setConfig, (event, patch: unknown) => {
    options.requireTrustedSender(event);
    const next = normalizeConfigPatch(config, patch);
    return serialize(() => applyConfigInternal(next));
  });

  handleRendererInvoke(REMOTE_ACCESS_CHANNELS.createPairing, (event, input: unknown) => {
    options.requireTrustedSender(event);
    return serialize(async (): Promise<RemotePairingCreated> => {
      if (!server) {
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
        pairingUrl: buildRemotePairingUrl({
          endpointUrl: chosenEndpoint,
          code,
          environmentId: authStore.environmentId,
          label: config.machineLabel,
        }),
      };
    });
  });

  handleRendererInvoke(REMOTE_ACCESS_CHANNELS.revokePairing, (event, grantId: unknown) => {
    options.requireTrustedSender(event);
    if (typeof grantId !== 'string' || !grantId) throw new Error('配对码 ID 无效');
    return serialize(async () => {
      await authStore.revokePairingGrant(grantId);
      return buildState();
    });
  });

  handleRendererInvoke(REMOTE_ACCESS_CHANNELS.revokeSession, (event, sessionId: unknown) => {
    options.requireTrustedSender(event);
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('会话 ID 无效');
    return serialize(async () => {
      await authStore.revokeSession(sessionId);
      return buildState();
    });
  });

  handleRendererInvoke(REMOTE_ACCESS_CHANNELS.revokeAllSessions, (event) => {
    options.requireTrustedSender(event);
    return serialize(async () => {
      await authStore.revokeAllSessions();
      return buildState();
    });
  });

  handleRendererInvoke(REMOTE_ACCESS_CHANNELS.installCloudflared, (event) => {
    options.requireTrustedSender(event);
    return serialize(async () => {
      await cloudflared.install();
      return buildState();
    });
  });

  handleRendererInvoke(REMOTE_ACCESS_CHANNELS.refreshNetwork, (event) => {
    options.requireTrustedSender(event);
    return serialize(async () => {
      await cloudflared.refreshBinaryInfo();
      if (!tailscaleStatus.active) {
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
      await serialize(async () => {
        await cloudflared.stop();
        if (tailscaleStatus.active) {
          await disableTailscaleServe({ servePort: config.tailscaleServePort });
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
