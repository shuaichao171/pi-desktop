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
  /** Lists sessions of these folders in one batch; folders that fail to list remain unset for retry. */
  readonly refreshSessionsForCwds: (cwds: readonly string[]) => Promise<void>;
  readonly switchWorkspace: (cwd: string, fresh?: boolean) => Promise<void>;
  readonly switchSession: (path: string) => Promise<void>;
  readonly selectSession: (cwd: string, path: string) => Promise<void>;
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
  readonly setAgentOption: (optionId: string, value: string) => Promise<void>;
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
  const connectionGenRef = useRef(0);
  const navRefreshGenRef = useRef(0);
  const busyCountRef = useRef(0);
  const snapshotRef = useRef<AgentSnapshot | null>(null);
  const environmentsRef = useRef<SavedRemoteEnvironment[]>([]);
  const activeEnvIdRef = useRef<string | null>(null);
  const forgottenIdsRef = useRef(new Set<string>());

  environmentsRef.current = environments;
  activeEnvIdRef.current = activeEnvId;
  snapshotRef.current = snapshot;

  const setSnapshotSynced = useCallback(
    (updater: AgentSnapshot | null | ((prev: AgentSnapshot | null) => AgentSnapshot | null)) => {
      setSnapshot((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        snapshotRef.current = next;
        return next;
      });
    },
    [],
  );

  // The Sessions screen loads the folders behind the tab it shows; no folder is preloaded here.
  const refreshNavigationData = useCallback(async () => {
    const client = clientRef.current;
    if (!client || client.getState().phase !== 'connected') return;
    const connGen = connectionGenRef.current;
    const navGen = ++navRefreshGenRef.current;
    const [wsList, conversationList, modelList, agentList] = await Promise.all([
      client.call('agent.listWorkspaces').catch(() => null),
      client.call('agent.listConversationWorkspaces').catch(() => null),
      client.call('agent.listModels').catch(() => null),
      client.call('agent.listAgents').catch(() => null),
    ]);
    if (connGen !== connectionGenRef.current || navGen !== navRefreshGenRef.current) return;
    if (wsList !== null) {
      workspaceKeysRef.current = new Set(wsList.map(remoteWorkspaceKey));
      setWorkspaces(wsList);
    }
    if (conversationList !== null) {
      setConversationWorkspaces(conversationList);
    }
    if (modelList !== null) {
      setModels(modelList);
    }
    if (agentList !== null) {
      setAgents(agentList);
    }
  }, []);

  if (!clientRef.current) {
    clientRef.current = new RemoteConnectionClient(nativeTransport, {
      onStateChange: (next) => setConnection(next),
      onHello: (hello) => {
        const connGen = connectionGenRef.current;
        setSnapshotSynced(hello.snapshot);
        setPendingDialogs([...hello.pendingDialogs]);
        void refreshNavigationData();
        if (hello.snapshot.cwd) {
          const cwd = hello.snapshot.cwd;
          void clientRef.current
            ?.call('agent.listSessions', { cwd })
            .then((list) => {
              if (connGen !== connectionGenRef.current) return;
              setSessionsByCwd((prev) => ({ ...prev, [cwd]: list }));
            })
            .catch(() => {});
        }
      },
      onEvent: (event) => {
        if (event.channel === 'agent-event') {
          setSnapshotSynced((prev) => applyRemoteAgentEvent(prev, event.payload));
          if (event.payload.event.type === 'sessions-changed') {
            const connGen = connectionGenRef.current;
            const changedCwd = event.payload.event.cwd;
            // A conversation started without a project lives in a folder this phone has not listed yet.
            if (!workspaceKeysRef.current.has(remoteWorkspaceKey(changedCwd))) void refreshNavigationData();
            void clientRef.current
              ?.call('agent.listSessions', { cwd: changedCwd })
              .then((list) => {
                if (connGen !== connectionGenRef.current) return;
                setSessionsByCwd((prev) => ({ ...prev, [changedCwd]: list }));
              })
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
        if (
          forgottenIdsRef.current.has(updated.environmentId) ||
          !environmentsRef.current.some((item) => item.environmentId === updated.environmentId)
        ) {
          return;
        }
        void saveEnvironment(updated)
          .then((list) => {
            if (forgottenIdsRef.current.has(updated.environmentId)) return;
            environmentsRef.current = list;
            setEnvironments(list);
          })
          .catch(() => {});
      },
    });
  }

  const connectHost = useCallback(
    (env: SavedRemoteEnvironment) => {
      connectionGenRef.current += 1;
      navRefreshGenRef.current += 1;
      activeEnvIdRef.current = env.environmentId;
      setActiveEnvId(env.environmentId);
      setSnapshotSynced(null);
      setPendingDialogs([]);
      setWorkspaces([]);
      setConversationWorkspaces([]);
      workspaceKeysRef.current = new Set();
      sessionLoadsRef.current.clear();
      setSessionsByCwd({});
      setModels([]);
      setAgents([]);
      clientRef.current?.connect(env);
    },
    [setSnapshotSynced],
  );

  const disconnectHost = useCallback(() => {
    connectionGenRef.current += 1;
    navRefreshGenRef.current += 1;
    clientRef.current?.disconnect();
    setSnapshotSynced(null);
    setPendingDialogs([]);
    setWorkspaces([]);
    setConversationWorkspaces([]);
    workspaceKeysRef.current = new Set();
    sessionLoadsRef.current.clear();
    setSessionsByCwd({});
    setModels([]);
    setAgents([]);
  }, [setSnapshotSynced]);

  useEffect(() => {
    let active = true;
    void loadSavedEnvironments()
      .then((saved) => {
        if (!active) return;
        environmentsRef.current = saved;
        setEnvironments(saved);
        setHydrated(true);
        if (saved[0]) {
          connectHost(saved[0]);
        }
      })
      .catch(() => {
        if (!active) return;
        setHydrated(true);
      });
    return () => {
      active = false;
      connectionGenRef.current += 1;
      navRefreshGenRef.current += 1;
      clientRef.current?.disconnect();
    };
  }, [connectHost]);

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
      forgottenIdsRef.current.delete(env.environmentId);
      const updatedList = await saveEnvironment(env);
      environmentsRef.current = updatedList;
      setEnvironments(updatedList);
      connectHost(env);
      return env;
    },
    [connectHost],
  );

  const forgetHost = useCallback(
    async (environmentId: string) => {
      forgottenIdsRef.current.add(environmentId);
      if (activeEnvIdRef.current === environmentId) {
        disconnectHost();
        activeEnvIdRef.current = null;
        setActiveEnvId(null);
      }
      const next = await removeSavedEnvironment(environmentId);
      environmentsRef.current = next;
      setEnvironments(next);
    },
    [disconnectHost],
  );

  const addRouteToHost = useCallback(
    async (environmentId: string, rawUrl: string) => {
      const target = environmentsRef.current.find((e) => e.environmentId === environmentId);
      if (!target) throw new Error('Environment not found');
      const trimmed = rawUrl.trim();
      if (!trimmed) throw new Error('Route URL is required');
      const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
      const origin = new URL(normalized).origin;
      if (target.pairedOverHttps && !origin.startsWith('https://')) {
        throw new Error(
          'This host was paired over HTTPS and requires an https:// route. Plain HTTP routes are blocked to protect your session token.',
        );
      }
      const kind = classifyEndpointKind(origin);
      const route: SavedRemoteRoute = {
        id: `manual:${kind}:${origin}`,
        kind,
        label:
          kind === 'lan'
            ? 'LAN'
            : kind === 'tailscale'
              ? 'Tailscale'
              : kind === 'cloudflare'
                ? 'Cloudflare'
                : new URL(origin).host,
        httpBaseUrl: origin,
        wsBaseUrl: httpToWsUrl(origin),
        learned: false,
      };
      const updated: SavedRemoteEnvironment = {
        ...target,
        routes: sortRemoteRoutes([...target.routes.filter((r) => r.httpBaseUrl !== origin), route]),
      };
      const list = await saveEnvironment(updated);
      environmentsRef.current = list;
      setEnvironments(list);
      const phase = clientRef.current?.getState().phase;
      if (
        activeEnvIdRef.current === environmentId &&
        (phase === 'connected' || phase === 'connecting' || phase === 'reconnecting')
      ) {
        connectHost(updated);
      }
    },
    [connectHost],
  );

  const refreshSessionsForCwds = useCallback(async (cwds: readonly string[]) => {
    const client = clientRef.current;
    if (!client || client.getState().phase !== 'connected') return;
    const connGen = connectionGenRef.current;
    // Skip folders already loading, so re-renders during a batch never repeat its requests.
    const targets = [...new Set(cwds)].filter((cwd) => cwd && !sessionLoadsRef.current.has(cwd));
    if (targets.length === 0) return;
    for (const cwd of targets) sessionLoadsRef.current.add(cwd);
    try {
      const results = await Promise.allSettled(targets.map((cwd) => client.call('agent.listSessions', { cwd })));
      if (connGen !== connectionGenRef.current) return;
      setSessionsByCwd((prev) => {
        let changed = false;
        const next = { ...prev };
        targets.forEach((cwd, index) => {
          const result = results[index];
          if (result.status === 'fulfilled') {
            next[cwd] = result.value;
            changed = true;
          }
        });
        return changed ? next : prev;
      });
    } finally {
      if (connGen === connectionGenRef.current) {
        for (const cwd of targets) sessionLoadsRef.current.delete(cwd);
      }
    }
  }, []);

  const requireClient = useCallback((): RemoteConnectionClient => {
    const client = clientRef.current;
    if (!client) throw new Error('Not connected');
    return client;
  }, []);

  const runAction = useCallback(async <T,>(work: (client: RemoteConnectionClient) => Promise<T>): Promise<T> => {
    const client = requireClient();
    busyCountRef.current += 1;
    if (busyCountRef.current === 1) setBusyAction(true);
    try {
      return await work(client);
    } finally {
      busyCountRef.current = Math.max(0, busyCountRef.current - 1);
      if (busyCountRef.current === 0) setBusyAction(false);
    }
  }, [requireClient]);

  const switchWorkspace = useCallback(
    (cwd: string, fresh?: boolean) =>
      runAction((c) => c.call('agent.switchWorkspace', { cwd, fresh }).then(() => undefined)),
    [runAction],
  );

  const switchSession = useCallback(
    (path: string) => runAction((c) => c.call('agent.switchSession', { path }).then(() => undefined)),
    [runAction],
  );

  const selectSession = useCallback(
    async (cwd: string, path: string): Promise<void> => {
      if (!cwd || !path) return;
      const gen = connectionGenRef.current;
      await runAction(async (client) => {
        const currentCwd = snapshotRef.current?.cwd ?? '';
        if (remoteWorkspaceKey(currentCwd) !== remoteWorkspaceKey(cwd)) {
          await client.call('agent.switchWorkspace', { cwd });
          if (gen !== connectionGenRef.current) return;
        }
        await client.call('agent.switchSession', { path });
      });
    },
    [runAction],
  );

  const createNewSession = useCallback(
    (cwd?: string) => runAction((c) => c.call('agent.newSession', cwd ? { cwd } : undefined).then(() => undefined)),
    [runAction],
  );

  const sendPrompt = useCallback(
    (text: string, behavior?: 'steer' | 'followUp') =>
      runAction((c) => c.call('agent.prompt', { text, behavior }).then(() => undefined)),
    [runAction],
  );

  const abortTurn = useCallback(
    () => runAction((c) => c.call('agent.abort').then(() => undefined)),
    [runAction],
  );

  const interruptShellTools = useCallback(
    (toolCallId?: string) =>
      runAction((c) =>
        c.call('agent.interruptShellTools', toolCallId ? { toolCallId } : undefined).then(() => undefined),
      ),
    [runAction],
  );

  const stopBackgroundTask = useCallback(
    (taskId: string) => runAction((c) => c.call('agent.stopBackgroundTask', { taskId }).then(() => undefined)),
    [runAction],
  );

  const updateQueuedMessage = useCallback(
    (id: string, action: 'edit' | 'remove' | 'steer', text?: string) =>
      runAction((c) => c.call('agent.updateQueuedMessage', { id, action, text }).then(() => undefined)),
    [runAction],
  );

  const respondDialog = useCallback(
    (id: string, responseValue: UiExtensionDialogResponse) =>
      runAction((c) => c.call('agent.respondExtensionDialog', { id, value: responseValue }).then(() => undefined)),
    [runAction],
  );

  const setModel = useCallback(
    (provider: string, id: string) => runAction((c) => c.call('agent.setModel', { provider, id }).then(() => undefined)),
    [runAction],
  );

  const setThinkingLevel = useCallback(
    (level: UiThinkingLevel) => runAction((c) => c.call('agent.setThinkingLevel', { level }).then(() => undefined)),
    [runAction],
  );

  const setSessionAgent = useCallback(
    (agentId: string) => runAction((c) => c.call('agent.setSessionAgent', { agentId }).then(() => undefined)),
    [runAction],
  );

  const setAgentOption = useCallback(
    (optionId: string, value: string) =>
      runAction((c) => c.call('agent.setAgentOption', { optionId, value }).then(() => undefined)),
    [runAction],
  );

  const listFiles = useCallback(
    (relativePath?: string) => requireClient().call('workspace.listEntries', relativePath ? { relativePath } : undefined),
    [requireClient],
  );

  const readFile = useCallback(
    (relativePath: string) => requireClient().call('workspace.readFile', { relativePath }).then((r) => r.content),
    [requireClient],
  );

  const getGitStatus = useCallback(() => requireClient().call('workspace.gitStatus'), [requireClient]);

  const getGitDiff = useCallback(
    (relativePath: string, source?: 'staged' | 'unstaged' | 'all') =>
      requireClient().call('workspace.gitDiff', { relativePath, source }).then((r) => r.diff),
    [requireClient],
  );

  const getBranches = useCallback(() => requireClient().call('workspace.branches'), [requireClient]);

  const getFileChangeDiffs = useCallback(
    (scope: UiFileDiffScope) => requireClient().call('agent.getFileChangeDiffs', { scope }),
    [requireClient],
  );

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
      switchWorkspace,
      switchSession,
      selectSession,
      createNewSession,
      sendPrompt,
      abortTurn,
      interruptShellTools,
      stopBackgroundTask,
      updateQueuedMessage,
      respondDialog,
      setModel,
      setThinkingLevel,
      setSessionAgent,
      setAgentOption,
      listFiles,
      readFile,
      getGitStatus,
      getGitDiff,
      getBranches,
      getFileChangeDiffs,
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
      switchWorkspace,
      switchSession,
      selectSession,
      createNewSession,
      sendPrompt,
      abortTurn,
      interruptShellTools,
      stopBackgroundTask,
      updateQueuedMessage,
      respondDialog,
      setModel,
      setThinkingLevel,
      setSessionAgent,
      setAgentOption,
      listFiles,
      readFile,
      getGitStatus,
      getGitDiff,
      getBranches,
      getFileChangeDiffs,
    ],
  );

  return <RemoteContext.Provider value={value}>{children}</RemoteContext.Provider>;
}

export function useRemote(): RemoteContextValue {
  const ctx = useContext(RemoteContext);
  if (!ctx) throw new Error('useRemote must be used inside RemoteProvider');
  return ctx;
}
