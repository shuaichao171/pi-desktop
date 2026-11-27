import React, { useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { UiSessionSummary } from '@pidesktop/shared';
import {
  groupRemoteWorkspaces,
  isRemoteConversationWorkspace,
  mergeRemoteSessionLists,
} from '@pidesktop/shared/remoteClient';
import { useRemote } from '../runtime/remoteStore';
import { useTheme } from '../theme';

interface SessionsScreenProps {
  onOpenChat: () => void;
}

/** A project folder, or every conversation folder together (the desktop's "Unassigned sessions"). */
type WorkspaceTab = { readonly kind: 'project'; readonly cwd: string } | { readonly kind: 'unassigned' };

const UNASSIGNED_TAB: WorkspaceTab = { kind: 'unassigned' };

function folderBasename(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function SessionsScreen({ onOpenChat }: SessionsScreenProps) {
  const theme = useTheme();
  const {
    connection,
    canOperate,
    snapshot,
    workspaces,
    conversationWorkspaces,
    sessionsByCwd,
    refreshNavigationData,
    refreshSessionsForCwds,
    switchWorkspace,
    switchSession,
    createNewSession,
  } = useRemote();

  const [selectedTab, setSelectedTab] = useState<WorkspaceTab | null>(null);
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const groups = useMemo(
    () => groupRemoteWorkspaces(workspaces, conversationWorkspaces),
    [workspaces, conversationWorkspaces],
  );
  const snapshotCwd = snapshot?.cwd ?? '';
  const activeTab = useMemo<WorkspaceTab | null>(() => {
    if (selectedTab) return selectedTab;
    if (snapshotCwd) {
      return isRemoteConversationWorkspace(snapshotCwd, conversationWorkspaces) ? UNASSIGNED_TAB : { kind: 'project', cwd: snapshotCwd };
    }
    if (groups.projects[0]) return { kind: 'project', cwd: groups.projects[0] };
    return groups.conversations.length > 0 ? UNASSIGNED_TAB : null;
  }, [selectedTab, snapshotCwd, conversationWorkspaces, groups]);
  const activeFolders = useMemo(
    () => (!activeTab ? [] : activeTab.kind === 'unassigned' ? groups.conversations : [activeTab.cwd]),
    [activeTab, groups.conversations],
  );

  useEffect(() => {
    const missing = activeFolders.filter((cwd) => !sessionsByCwd[cwd]);
    if (missing.length > 0 && connection.phase === 'connected') {
      void refreshSessionsForCwds(missing);
    }
  }, [activeFolders, connection.phase, sessionsByCwd, refreshSessionsForCwds]);

  const runtimeByPath = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of snapshot?.sessionRuntimes ?? []) {
      map.set(item.path, item.runtime.phase);
    }
    return map;
  }, [snapshot?.sessionRuntimes]);

  const sessions = useMemo(() => {
    const list =
      activeTab?.kind === 'unassigned'
        ? mergeRemoteSessionLists(activeFolders.map((cwd) => sessionsByCwd[cwd]))
        : (sessionsByCwd[activeFolders[0] ?? ''] ?? []);
    const q = query.trim().toLowerCase();
    return list
      .filter((s) => !s.archived)
      .filter((s) => !q || `${s.name ?? ''} ${s.firstMessage}`.toLowerCase().includes(q));
  }, [sessionsByCwd, activeTab, activeFolders, query]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshNavigationData();
      await refreshSessionsForCwds(activeFolders);
    } finally {
      setRefreshing(false);
    }
  };

  const selectTab = (tab: WorkspaceTab) => {
    setSelectedTab(tab);
    // Unassigned is a view over many folders, so it never moves the desktop to one of them.
    if (tab.kind === 'unassigned') {
      void refreshSessionsForCwds(groups.conversations);
      return;
    }
    void refreshSessionsForCwds([tab.cwd]);
    if (canOperate && tab.cwd !== snapshotCwd) {
      void switchWorkspace(tab.cwd).catch(() => {});
    }
  };

  const renderTab = (key: string, label: string, tab: WorkspaceTab, selected: boolean) => (
    <Pressable
      key={key}
      onPress={() => selectTab(tab)}
      style={[
        styles.wsChip,
        {
          borderColor: selected ? theme.brand : theme.border,
          backgroundColor: selected ? theme.brand : theme.surfaceAlt,
        },
      ]}
    >
      <Text style={{ color: selected ? theme.brandInk : theme.text, fontSize: 12, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );

  if (connection.phase !== 'connected') {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]}>
        <Text style={{ color: theme.textSubtle, fontSize: 15 }}>
          Connect to a desktop host in the Hosts tab to view conversations.
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <View style={[styles.topBar, { borderBottomColor: theme.border, backgroundColor: theme.surface }]}>
        <View style={styles.titleRow}>
          <Text style={[styles.heading, { color: theme.text }]}>Conversations</Text>
          {canOperate && (
            <Pressable
              style={[styles.newBtn, { backgroundColor: theme.brand }]}
              onPress={() =>
                // Under Unassigned the desktop creates a fresh conversation folder, as its own "New chat" does.
                void createNewSession(activeTab?.kind === 'project' ? activeTab.cwd : undefined).then(onOpenChat)
              }
            >
              <Text style={{ color: theme.brandInk, fontWeight: '700', fontSize: 13 }}>+ New</Text>
            </Pressable>
          )}
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.wsChips}>
          {groups.projects.map((ws) =>
            renderTab(ws, folderBasename(ws), { kind: 'project', cwd: ws }, activeTab?.kind === 'project' && activeTab.cwd === ws),
          )}
          {groups.conversations.length > 0 &&
            renderTab('unassigned', 'Unassigned', UNASSIGNED_TAB, activeTab?.kind === 'unassigned')}
        </ScrollView>

        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Filter conversations…"
          placeholderTextColor={theme.textMuted}
          style={[styles.search, { borderColor: theme.border, backgroundColor: theme.surfaceAlt, color: theme.text }]}
        />
      </View>

      <FlatList<UiSessionSummary>
        data={sessions}
        keyExtractor={(item) => item.path}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void handleRefresh()} />}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <Text style={{ color: theme.textMuted, textAlign: 'center', marginTop: 40 }}>
            {activeTab?.kind === 'unassigned' ? 'No conversations outside projects yet.' : 'No conversations in this workspace yet.'}
          </Text>
        }
        renderItem={({ item }) => {
          const isActive = snapshot?.sessionPath === item.path;
          const phase = runtimeByPath.get(item.path) ?? item.runtime?.phase ?? 'idle';
          const phaseColor =
            phase === 'waiting-approval' || phase === 'waiting-input'
              ? theme.warning
              : phase === 'running'
                ? theme.brand
                : phase === 'failed'
                  ? theme.danger
                  : item.unread
                    ? theme.success
                    : 'transparent';

          return (
            <Pressable
              onPress={() => {
                if (canOperate) {
                  void switchSession(item.path).then(onOpenChat);
                } else {
                  onOpenChat();
                }
              }}
              style={[
                styles.row,
                {
                  backgroundColor: theme.surface,
                  borderColor: isActive ? theme.brand : theme.border,
                },
              ]}
            >
              <View style={styles.rowHeader}>
                <View style={[styles.dot, { backgroundColor: phaseColor }]} />
                <Text style={[styles.rowTitle, { color: theme.text }]} numberOfLines={1}>
                  {item.name || item.firstMessage || 'Untitled conversation'}
                </Text>
              </View>
              <View style={styles.rowMeta}>
                <Text style={{ color: theme.textMuted, fontSize: 11 }}>
                  {item.messageCount} msgs · {phase !== 'idle' ? phase : new Date(item.modified).toLocaleDateString()}
                </Text>
                {isActive && <Text style={{ color: theme.brand, fontSize: 11, fontWeight: '700' }}>ACTIVE</Text>}
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  topBar: { padding: 12, gap: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heading: { fontSize: 20, fontWeight: '700' },
  newBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  wsChips: { gap: 8 },
  wsChip: { paddingHorizontal: 11, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  search: { borderWidth: 1, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13 },
  listContent: { padding: 12, gap: 8, paddingBottom: 24 },
  row: { padding: 12, borderRadius: 12, borderWidth: 1, gap: 6 },
  rowHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  rowTitle: { flex: 1, fontSize: 15, fontWeight: '600' },
  rowMeta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingLeft: 16 },
});
