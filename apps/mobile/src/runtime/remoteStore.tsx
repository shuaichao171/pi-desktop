import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import type {
  AgentSnapshot,
  UiAgentStatus,
  UiExtensionDialogRequest,
  UiExtensionDialogResponse,
  UiFileDiff,
  UiFileDiffScope,
  UiModelSummary,
  UiSessionSummary,
  UiThinkingLevel,
  WorkspaceBranches,
  WorkspaceEntry,
  WorkspaceGitStatus,
} from '@pidesktop/shared';
import { httpToWsUrl } from '@pidesktop/shared/remoteAccess';
import {
  RemoteConnectionClient,
  applyRemoteAgentEvent,
  classifyEndpointKind,
  mergeRemotePendingDialog,
  pairWithDesktop,
  remoteWorkspaceKey,
  removeRemotePendingDialog,
  sortRemoteRoutes,
  type RemoteConnectionState,
  type SavedRemoteEnvironment,
  type SavedRemoteRoute,
  type WebSocketLike,
} from '@pidesktop/shared/remoteClient';
import { loadSavedEnvironments, removeSavedEnvironment, saveEnvironment } from './storage';

interface RemoteContextValue {
  readonly hydrated: boolean;
  readonly environments: readonly SavedRemoteEnvironment[];
  readonly activeEnvironment: SavedRemoteEnvironment | null;
  readonly connection: RemoteConnectionState;
  readonly canOperate: boolean;
  readonly snapshot: AgentSnapshot | null;
  readonly pendingDialogs: readonly UiExtensionDialogRequest[];
  readonly workspaces: readonly string[];
  /** Folders of conversations started without a project (the desktop's "Unassigned sessions"). */
  readonly conversationWorkspaces: readonly string[];
  readonly sessionsByCwd: Readonly<Record<string, readonly UiSessionSummary[]>>;
  readonly models: readonly UiModelSummary[];
  readonly agents: readonly UiAgentStatus[];
  readonly busyAction: boolean;
  readonly pairHost: (input: { pairingUrlOrAddress: string; code?: string }) => Promise<SavedRemoteEnvironment>;
  readonly connectHost: (env: SavedRemoteEnvironment) => void;
  readonly disconnectHost: () => void;
  readonly forgetHost: (environmentId: string) => Promise<void>;
  readonly addRouteToHost: (environmentId: string, rawUrl: string) => Promise<void>;
  readonly refreshNavigationData: () => Promise<void>;
  /** Lists sessions of these folders in one batch; a folder that fails to list shows as empty. */
  readonly refreshSessionsForCwds: (cwds: readonly string[]) => Promise<void>;
  readonly switchWorkspace: (cwd: string, fresh?: boolean) => Promise<void>;
  readonly switchSession: (path: string) => Promise<void>;
  readonly createNewSession: (cwd?: string) => Promise<void>;
  readonly sendPrompt: (text: string, behavior?: 'steer' | 'followUp') => Promise<void>;
  readonly abortTurn: () => Promise<void>;
  readonly interruptShellTools: (toolCallId?: string) => Promise<void>;
  readonly stopBackgroundTask: (taskId: string) => Promise<void>;
  readonly updateQueuedMessage: (id: string, action: 'edit' | 'remove' | 'steer', text?: string) => Promise<void>;
  readonly respondDialog: (id: string, value: UiExtensionDialogResponse) => Promise<void>;
  readonly setModel: (provider: string, id: string) => Promise<void>;
  readonly setThinkingLevel: (level: UiThinkingLevel) => Promise<void>;
  readonly setSessionAgent: (agentId: string) => Promise<void>;
  readonly listFiles: (relativePath?: string) => Promise<WorkspaceEntry[]>;
  readonly readFile: (relativePath: string) => Promise<string>;
  readonly getGitStatus: () => Promise<WorkspaceGitStatus>;
  readonly getGitDiff: (relativePath: string, source?: 'staged' | 'unstaged' | 'all') => Promise<string>;
  readonly getBranches: () => Promise<WorkspaceBranches>;
  readonly getFileChangeDiffs: (scope: UiFileDiffScope) => Promise<UiFileDiff[]>;
}

const RemoteContext = createContext<RemoteContextValue | null>(null);

const nativeTransport = {
  fetch: (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) =>
    globalThis.fetch(input, init),
  createWebSocket: (url: string) => new globalThis.WebSocket(url) as unknown as WebSocketLike,
};

function currentMobileOs(): 'ios' | 'android' | 'unknown' {
  if (Platform.OS === 'ios') return 'ios';
  if (Platform.OS === 'android') return 'android';
  return 'unknown';
}

/** Name the desktop shows for this phone when its user left the device note empty, e.g. "Xiaomi MI 6". */
function currentDeviceLabel(): string {
  if (Platform.OS === 'ios') return Platform.isPad ? 'iPad' : 'iPhone';
  if (Platform.OS === 'android') {
    const maker = (Platform.constants.Manufacturer || Platform.constants.Brand || '').trim();
    const model = (Platform.constants.Model || '').trim();
    if (!model) return maker || 'Android device';
    if (!maker || model.toLowerCase().startsWith(maker.toLowerCase())) return model;
    return `${maker.charAt(0).toUpperCase()}${maker.slice(1)} ${model}`;
  }
  return 'Mobile device';
}

export function RemoteProvider({ children }: { children: React.ReactNode }) {
  const [hydrated, setHydrated] = useState(false);
  const [environments, setEnvironments] = useState<SavedRemoteEnvironment[]>([]);
  const [activeEnvId, setActiveEnvId] = useState<string | null>(null);
  const [connection, setConnection] = useState<RemoteConnectionState>({
    phase: 'disconnected',
    environmentId: null,
    activeRoute: null,
    descriptor: null,
    role: null,
    scopes: [],
    error: null,
    attempt: 0,
  });
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const [pendingDialogs, setPendingDialogs] = useState<UiExtensionDialogRequest[]>([]);
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [conversationWorkspaces, setConversationWorkspaces] = useState<string[]>([]);
  const [sessionsByCwd, setSessionsByCwd] = useState<Record<string, UiSessionSummary[]>>({});
  const [models, setModels] = useState<UiModelSummary[]>([]);
  const [agents, setAgents] = useState<UiAgentStatus[]>([]);
  const [busyAction, setBusyAction] = useState(false);

  const clientRef = useRef<RemoteConnectionClient | null>(null);
  const workspaceKeysRef = useRef(new Set<string>());
  const sessionLoadsRef = useRef(new Set<string>());

  // The Sessions screen loads the folders behind the tab it shows; no folder is preloaded here.
  const refreshNavigationData = useCallback(async () => {
    const client = clientRef.current;
    if (!client || client.getState().phase !== 'connected') return;
    const [wsList, conversationList, modelList, agentList] = await Promise.all([
      client.call('agent.listWorkspaces').catch(() => [] as string[]),
      client.call('agent.listConversationWorkspaces').catch(() => [] as string[]),
      client.call('agent.listModels').catch(() => [] as UiModelSummary[]),
      client.call('agent.listAgents').catch(() => [] as UiAgentStatus[]),
    ]);
    workspaceKeysRef.current = new Set(wsList.map(remoteWorkspaceKey));
    setWorkspaces(wsList);
    setConversationWorkspaces(conversationList);
    setModels(modelList);
    setAgents(agentList);
  }, []);

  if (!clientRef.current) {
    clientRef.current = new RemoteConnectionClient(nativeTransport, {
      onStateChange: (next) => setConnection(next),
      onHello: (hello) => {
        setSnapshot(hello.snapshot);
        setPendingDialogs([...hello.pendingDialogs]);
        void refreshNavigationData();
        if (hello.snapshot.cwd) {
          void clientRef.current
            ?.call('agent.listSessions', { cwd: hello.snapshot.cwd })
            .then((list) => setSessionsByCwd((prev) => ({ ...prev, [hello.snapshot.cwd]: list })))
            .catch(() => {});
        }
      },
      onEvent: (event) => {
        if (event.channel === 'agent-event') {
          setSnapshot((prev) => applyRemoteAgentEvent(prev, event.payload));
          if (event.payload.event.type === 'sessions-changed') {
            const changedCwd = event.payload.event.cwd;
            // A conversation started without a project lives in a folder this phone has not listed yet.
            if (!workspaceKeysRef.current.has(remoteWorkspaceKey(changedCwd))) void refreshNavigationData();
            void clientRef.current
              ?.call('agent.listSessions', { cwd: changedCwd })
              .then((list) => setSessionsByCwd((prev) => ({ ...prev, [changedCwd]: list })))
              .catch(() => {});
          }
          return;
        }
        if (event.channel === 'extension-dialog') {
          setPendingDialogs((prev) => mergeRemotePendingDialog(prev, event.payload));
          return;
        }
        if (event.channel === 'extension-dialog-closed') {
          setPendingDialogs((prev) => removeRemotePendingDialog(prev, event.payload.id));
        }
      },
      onEnvironmentUpdated: (updated) => {
        void saveEnvironment(updated).then((list) => setEnvironments(list)).catch(() => {});
      },
    });
  }

  useEffect(() => {
    let active = true;
    void loadSavedEnvironments().then((saved) => {
      if (!active) return;
      setEnvironments(saved);
      setHydrated(true);
      if (saved[0]) {
        setActiveEnvId(saved[0].environmentId);
        clientRef.current?.connect(saved[0]);
      }
    });
    return () => {
      active = false;
      clientRef.current?.disconnect();
    };
  }, []);

  // Re-probe routes when returning to foreground or switching Wi-Fi / Cellular (LAN promotion)
  useEffect(() => {
    const appSub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        void clientRef.current?.probeOrReconnect();
      }
    });
    const netUnsub = NetInfo.addEventListener(() => {
      void clientRef.current?.probeOrReconnect();
    });
    return () => {
      appSub.remove();
      netUnsub();
    };
  }, []);

  // The desktop (or this phone) switched to a folder created after the last listing, e.g. a new conversation.
  // An empty key set means the first listing (started by onHello) has not landed yet.
  const snapshotCwd = snapshot?.cwd ?? '';
  useEffect(() => {
    const known = workspaceKeysRef.current;
    if (snapshotCwd && connection.phase === 'connected' && known.size > 0 && !known.has(remoteWorkspaceKey(snapshotCwd))) {
      void refreshNavigationData();
    }
  }, [snapshotCwd, connection.phase, refreshNavigationData]);

  const connectHost = useCallback((env: SavedRemoteEnvironment) => {
    setActiveEnvId(env.environmentId);
    setSnapshot(null);
    setPendingDialogs([]);
    setWorkspaces([]);
    setConversationWorkspaces([]);
    workspaceKeysRef.current = new Set();
    setSessionsByCwd({});
    clientRef.current?.connect(env);
  }, []);

  const disconnectHost = useCallback(() => {
    clientRef.current?.disconnect();
    setSnapshot(null);
    setPendingDialogs([]);
  }, []);

  const pairHost = useCallback(
    async (input: { pairingUrlOrAddress: string; code?: string }): Promise<SavedRemoteEnvironment> => {
      const os = currentMobileOs();
      const env = await pairWithDesktop({
        transport: nativeTransport,
        pairingUrlOrAddress: input.pairingUrlOrAddress,
        code: input.code,
        clientLabel: currentDeviceLabel(),
        deviceType: 'mobile',
        os,
      });
      const updatedList = await saveEnvironment(env);
      setEnvironments(updatedList);
      connectHost(env);
      return env;
    },
    [connectHost],
  );

  const forgetHost = useCallback(
    async (environmentId: string) => {
      if (activeEnvId === environmentId) {
        disconnectHost();
        setActiveEnvId(null);
      }
      const next = await removeSavedEnvironment(environmentId);
      setEnvironments(next);
    },
    [activeEnvId, disconnectHost],
  );

  const addRouteToHost = useCallback(
    async (environmentId: string, rawUrl: string) => {
      const target = environments.find((e) => e.environmentId === environmentId);
      if (!target) throw new Error('Environment not found');
      const normalized = /^https?:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : `http://${rawUrl.trim()}`;
      const origin = new URL(normalized).origin;
      const kind = classifyEndpointKind(origin);
      const route: SavedRemoteRoute = {
        id: `manual:${kind}:${origin}`,
        kind,
        label: kind === 'lan' ? 'LAN' : kind === 'tailscale' ? 'Tailscale' : kind === 'cloudflare' ? 'Cloudflare' : new URL(origin).host,
        httpBaseUrl: origin,
        wsBaseUrl: httpToWsUrl(origin),
        learned: false,
      };
      const updated: SavedRemoteEnvironment = {
        ...target,
        routes: sortRemoteRoutes([...target.routes.filter((r) => r.httpBaseUrl !== origin), route]),
      };
      const list = await saveEnvironment(updated);
      setEnvironments(list);
      if (activeEnvId === environmentId) {
        clientRef.current?.connect(updated);
      }
    },
    [environments, activeEnvId],
  );

  const refreshSessionsForCwds = useCallback(async (cwds: readonly string[]) => {
    const client = clientRef.current;
    if (!client || client.getState().phase !== 'connected') return;
    // Skip folders already loading, so re-renders during a batch never repeat its requests.
    const targets = [...new Set(cwds)].filter((cwd) => cwd && !sessionLoadsRef.current.has(cwd));
    if (targets.length === 0) return;
    for (const cwd of targets) sessionLoadsRef.current.add(cwd);
    try {
      const results = await Promise.allSettled(targets.map((cwd) => client.call('agent.listSessions', { cwd })));
      setSessionsByCwd((prev) => {
        const next = { ...prev };
        targets.forEach((cwd, index) => {
          const result = results[index];
          next[cwd] = result.status === 'fulfilled' ? result.value : (prev[cwd] ?? []);
        });
        return next;
      });
    } finally {
      for (const cwd of targets) sessionLoadsRef.current.delete(cwd);
    }
  }, []);

  const runAction = useCallback(async <T,>(work: (client: RemoteConnectionClient) => Promise<T>): Promise<T> => {
    const client = clientRef.current;
    if (!client) throw new Error('Remote client unavailable');
    setBusyAction(true);
    try {
      return await work(client);
    } finally {
      setBusyAction(false);
    }
  }, []);

  const activeEnvironment = useMemo(
    () => environments.find((item) => item.environmentId === activeEnvId) ?? null,
    [environments, activeEnvId],
  );
  const canOperate = connection.scopes.includes('chat:operate');

  const value = useMemo<RemoteContextValue>(
    () => ({
      hydrated,
      environments,
      activeEnvironment,
      connection,
      canOperate,
      snapshot,
      pendingDialogs,
      workspaces,
      conversationWorkspaces,
      sessionsByCwd,
      models,
      agents,
      busyAction,
      pairHost,
      connectHost,
      disconnectHost,
      forgetHost,
      addRouteToHost,
      refreshNavigationData,
      refreshSessionsForCwds,
      switchWorkspace: (cwd, fresh) => runAction((c) => c.call('agent.switchWorkspace', { cwd, fresh }).then(() => undefined)),
      switchSession: (path) => runAction((c) => c.call('agent.switchSession', { path }).then(() => undefined)),
      createNewSession: (cwd) => runAction((c) => c.call('agent.newSession', cwd ? { cwd } : undefined).then(() => undefined)),
      sendPrompt: (text, behavior) => runAction((c) => c.call('agent.prompt', { text, behavior }).then(() => undefined)),
      abortTurn: () => runAction((c) => c.call('agent.abort').then(() => undefined)),
      interruptShellTools: (toolCallId) => runAction((c) => c.call('agent.interruptShellTools', toolCallId ? { toolCallId } : undefined).then(() => undefined)),
      stopBackgroundTask: (taskId) => runAction((c) => c.call('agent.stopBackgroundTask', { taskId }).then(() => undefined)),
      updateQueuedMessage: (id, action, text) => runAction((c) => c.call('agent.updateQueuedMessage', { id, action, text }).then(() => undefined)),
      respondDialog: (id, responseValue) =>
        runAction((c) => c.call('agent.respondExtensionDialog', { id, value: responseValue }).then(() => undefined)),
      setModel: (provider, id) => runAction((c) => c.call('agent.setModel', { provider, id }).then(() => undefined)),
      setThinkingLevel: (level) => runAction((c) => c.call('agent.setThinkingLevel', { level }).then(() => undefined)),
      setSessionAgent: (agentId) => runAction((c) => c.call('agent.setSessionAgent', { agentId }).then(() => undefined)),
      listFiles: (relativePath) => clientRef.current!.call('workspace.listEntries', relativePath ? { relativePath } : undefined),
      readFile: (relativePath) => clientRef.current!.call('workspace.readFile', { relativePath }).then((r) => r.content),
      getGitStatus: () => clientRef.current!.call('workspace.gitStatus'),
      getGitDiff: (relativePath, source) => clientRef.current!.call('workspace.gitDiff', { relativePath, source }).then((r) => r.diff),
      getBranches: () => clientRef.current!.call('workspace.branches'),
      getFileChangeDiffs: (scope) => clientRef.current!.call('agent.getFileChangeDiffs', { scope }),
    }),
    [
      hydrated,
      environments,
      activeEnvironment,
      connection,
      canOperate,
      snapshot,
      pendingDialogs,
      workspaces,
      conversationWorkspaces,
      sessionsByCwd,
      models,
      agents,
      busyAction,
      pairHost,
      connectHost,
      disconnectHost,
      forgetHost,
      addRouteToHost,
      refreshNavigationData,
      refreshSessionsForCwds,
      runAction,
    ],
  );

  return <RemoteContext.Provider value={value}>{children}</RemoteContext.Provider>;
}

export function useRemote(): RemoteContextValue {
  const ctx = useContext(RemoteContext);
  if (!ctx) throw new Error('useRemote must be used inside RemoteProvider');
  return ctx;
}
