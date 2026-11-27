import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { UiSessionSummary } from '@pidesktop/shared';
import { groupRemoteWorkspaces, isRemoteConversationWorkspace } from '@pidesktop/shared/remoteClient';
import { useRemote } from '../runtime/remoteStore';
import { font, radius, space, useTheme, type MobileTheme } from '../theme';
import { relativeTime, t } from '../i18n';
import { Banner, Button, Chip, EmptyState, Header, Separator, StatusDot, TextField } from '../components/ui';

interface SessionsScreenProps {
  onOpenChat: () => void;
  onOpenHosts: () => void;
}

/** A project folder, or every conversation folder together (the desktop's "Unassigned sessions"). */
type WorkspaceTab = { readonly kind: 'project'; readonly cwd: string } | { readonly kind: 'unassigned' };

type SessionPhase = 'idle' | 'running' | 'waiting-input' | 'waiting-approval' | 'failed';

interface SessionEntry {
  readonly cwd: string;
  readonly session: UiSessionSummary;
}

const UNASSIGNED_TAB: WorkspaceTab = { kind: 'unassigned' };

function folderBasename(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function sessionModifiedMs(session: UiSessionSummary): number {
  const time = Date.parse(session.modified);
  return Number.isFinite(time) ? time : 0;
}

function phaseColor(theme: MobileTheme, phase: SessionPhase): string {
  if (phase === 'waiting-approval' || phase === 'waiting-input') return theme.warning;
  if (phase === 'running') return theme.brand;
  if (phase === 'failed') return theme.danger;
  return theme.textMuted;
}

const SessionRow = memo(function SessionRow({
  entry,
  active,
  phase,
  disabled,
  onPress,
}: {
  entry: SessionEntry;
  active: boolean;
  phase: SessionPhase;
  disabled: boolean;
  onPress: (entry: SessionEntry) => void;
}) {
  const theme = useTheme();
  const item = entry.session;
  return (
    <Pressable
      disabled={disabled}
      onPress={() => onPress(entry)}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? theme.surfaceAlt : active ? theme.surface : theme.bg }]}
    >
      <View style={styles.rowTop}>
        <Text style={[styles.rowTitle, { color: theme.text, fontWeight: item.unread ? '700' : '600' }]} numberOfLines={1}>
          {item.name || item.firstMessage || t('home.untitled')}
        </Text>
        <Text style={[styles.rowTime, { color: theme.textMuted }]}>{relativeTime(item.modified)}</Text>
      </View>
      <View style={styles.rowBottom}>
        {phase !== 'idle' ? (
          <View style={styles.phase}>
            <StatusDot color={phaseColor(theme, phase)} size={6} />
            <Text style={[styles.rowMeta, { color: phaseColor(theme, phase) }]}>{t(`phase.${phase}`)}</Text>
          </View>
        ) : (
          <Text style={[styles.rowMeta, { color: theme.textMuted }]}>
            {active ? `${t('home.current')} · ` : ''}
            {t('home.messages', { n: item.messageCount })}
          </Text>
        )}
        {item.unread ? <StatusDot color={theme.brand} /> : null}
      </View>
    </Pressable>
  );
});

export function SessionsScreen({ onOpenChat, onOpenHosts }: SessionsScreenProps) {
  const theme = useTheme();
  const {
    environments,
    activeEnvironment,
    connection,
    canOperate,
    snapshot,
    pendingDialogs,
    workspaces,
    conversationWorkspaces,
    sessionsByCwd,
    connectHost,
    refreshNavigationData,
    refreshSessionsForCwds,
    selectSession,
    createNewSession,
  } = useRemote();

  const [selectedTab, setSelectedTab] = useState<WorkspaceTab | null>(null);
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);

  useEffect(() => {
    setSelectedTab(null);
    setActionError(null);
  }, [connection.environmentId]);

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
    const map = new Map<string, SessionPhase>();
    for (const item of snapshot?.sessionRuntimes ?? []) {
      map.set(item.path, item.runtime.phase);
    }
    return map;
  }, [snapshot?.sessionRuntimes]);

  const sessions = useMemo<SessionEntry[]>(() => {
    const seen = new Set<string>();
    const merged: SessionEntry[] = [];
    for (const cwd of activeFolders) {
      for (const session of sessionsByCwd[cwd] ?? []) {
        if (seen.has(session.path)) continue;
        seen.add(session.path);
        merged.push({ cwd, session });
      }
    }
    merged.sort(
      (a, b) =>
        Number(b.session.pinned === true) - Number(a.session.pinned === true) ||
        sessionModifiedMs(b.session) - sessionModifiedMs(a.session),
    );
    const q = query.trim().toLowerCase();
    return merged
      .filter((entry) => !entry.session.archived)
      .filter((entry) => !q || `${entry.session.name ?? ''} ${entry.session.firstMessage}`.toLowerCase().includes(q));
  }, [sessionsByCwd, activeFolders, query]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setActionError(null);
    try {
      await refreshNavigationData();
      await refreshSessionsForCwds(activeFolders);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  };

  const selectTab = (tab: WorkspaceTab) => {
    setSelectedTab(tab);
    setActionError(null);
    // Browsing tabs only lists sessions; it never mutates the desktop's active workspace.
    if (tab.kind === 'unassigned') {
      void refreshSessionsForCwds(groups.conversations);
      return;
    }
    void refreshSessionsForCwds([tab.cwd]);
  };

  const handleSelectSession = useCallback(
    async (entry: SessionEntry) => {
      if (!canOperate) {
        onOpenChat();
        return;
      }
      if (openingRef.current) return;
      openingRef.current = true;
      setOpening(true);
      setActionError(null);
      try {
        await selectSession(entry.cwd, entry.session.path);
        onOpenChat();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        openingRef.current = false;
        setOpening(false);
      }
    },
    [canOperate, onOpenChat, selectSession],
  );
  const pressSession = useCallback((entry: SessionEntry) => void handleSelectSession(entry), [handleSelectSession]);

  const handleCreateSession = async () => {
    if (!canOperate || openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    setActionError(null);
    try {
      // Under Unassigned the desktop creates a fresh conversation folder, as its own "New chat" does.
      await createNewSession(activeTab?.kind === 'project' ? activeTab.cwd : undefined);
      onOpenChat();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  };

  const phase = connection.phase;
  const hostLabel = activeEnvironment?.label ?? environments[0]?.label ?? t('hosts.title');
  const statusColor =
    phase === 'connected' ? theme.success : phase === 'auth-error' ? theme.danger : phase === 'disconnected' ? theme.textMuted : theme.warning;

  const hostPill = (
    <Pressable
      onPress={onOpenHosts}
      accessibilityLabel={t('conn.manage')}
      style={({ pressed }) => [styles.hostPill, { backgroundColor: theme.surface, opacity: pressed ? 0.7 : 1 }]}
    >
      <StatusDot color={statusColor} />
      <Text style={[styles.hostLabel, { color: theme.textSubtle }]} numberOfLines={1}>
        {hostLabel}
      </Text>
    </Pressable>
  );

  if (phase !== 'connected') {
    const target = activeEnvironment ?? environments[0] ?? null;
    return (
      <View style={[styles.container, { backgroundColor: theme.bg }]}>
        <Header title={t('home.title')} large right={hostPill} />
        {phase === 'connecting' || phase === 'reconnecting' ? (
          <EmptyState
            title={phase === 'reconnecting' ? t('conn.reconnecting', { n: connection.attempt }) : t('conn.connecting')}
            action={<ActivityIndicator color={theme.brand} />}
          />
        ) : (
          <EmptyState
            title={phase === 'auth-error' ? t('conn.authError') : t('conn.disconnected')}
            hint={phase === 'auth-error' ? undefined : (connection.error ?? t('home.notConnectedHint'))}
            action={
              <View style={styles.emptyActions}>
                {phase !== 'auth-error' && target ? <Button label={t('hosts.connect')} onPress={() => connectHost(target)} /> : null}
                <Button label={t('conn.manage')} variant="ghost" onPress={onOpenHosts} />
              </View>
            }
          />
        )}
      </View>
    );
  }

  const listEmpty =
    query.trim() !== ''
      ? t('home.emptySearch')
      : activeTab?.kind === 'unassigned'
        ? t('home.emptyUnassigned')
        : t('home.emptyProject');
  const tabCount = groups.projects.length + (groups.conversations.length > 0 ? 1 : 0);
  const currentPath = snapshot?.sessionPath ?? null;

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <Header title={t('home.title')} large right={hostPill} />

      {pendingDialogs.length > 0 ? (
        <Banner text={t('home.pending', { n: pendingDialogs.length })} actionLabel="›" onPress={onOpenChat} />
      ) : null}

      {tabCount > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll} contentContainerStyle={styles.chips}>
          {groups.projects.map((ws) => (
            <Chip
              key={ws}
              label={folderBasename(ws)}
              selected={activeTab?.kind === 'project' && activeTab.cwd === ws}
              onPress={() => selectTab({ kind: 'project', cwd: ws })}
            />
          ))}
          {groups.conversations.length > 0 ? (
            <Chip label={t('home.unassigned')} selected={activeTab?.kind === 'unassigned'} onPress={() => selectTab(UNASSIGNED_TAB)} />
          ) : null}
        </ScrollView>
      ) : null}

      <View style={styles.searchWrap}>
        <TextField value={query} onChangeText={setQuery} placeholder={t('home.search')} returnKeyType="search" />
      </View>

      {actionError ? (
        <Banner tone="danger" text={actionError} actionLabel={t('common.dismiss')} onPress={() => setActionError(null)} />
      ) : null}

      <FlatList<SessionEntry>
        data={sessions}
        keyExtractor={(entry) => entry.session.path}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void handleRefresh()}
            colors={[theme.brand]}
            progressBackgroundColor={theme.surface}
          />
        }
        contentContainerStyle={styles.listContent}
        ItemSeparatorComponent={Separator}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={<EmptyState title={listEmpty} />}
        renderItem={({ item: entry }) => (
          <SessionRow
            entry={entry}
            active={currentPath === entry.session.path}
            phase={runtimeByPath.get(entry.session.path) ?? entry.session.runtime?.phase ?? 'idle'}
            disabled={opening}
            onPress={pressSession}
          />
        )}
      />

      {canOperate ? (
        <Pressable
          onPress={() => void handleCreateSession()}
          disabled={opening}
          style={({ pressed }) => [styles.fab, { backgroundColor: theme.brand, opacity: opening ? 0.6 : pressed ? 0.85 : 1 }]}
        >
          {opening ? <ActivityIndicator size="small" color={theme.brandInk} /> : <Text style={[styles.fabPlus, { color: theme.brandInk }]}>＋</Text>}
          <Text style={[styles.fabLabel, { color: theme.brandInk }]}>{t('home.new')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  hostPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    maxWidth: 170,
  },
  hostLabel: { fontSize: font.small, fontWeight: '500', flexShrink: 1 },
  emptyActions: { alignSelf: 'stretch', gap: space.xs, marginTop: space.sm },
  chipScroll: { flexGrow: 0 },
  chips: { gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.sm },
  searchWrap: { paddingHorizontal: space.lg, paddingBottom: space.sm },
  listContent: { paddingBottom: 96 },
  row: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: 3 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  rowTitle: { flex: 1, fontSize: font.body },
  rowTime: { fontSize: font.caption },
  rowBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 16 },
  phase: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  rowMeta: { fontSize: font.caption },
  fab: {
    position: 'absolute',
    right: space.lg,
    bottom: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 18,
    height: 48,
    borderRadius: radius.pill,
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  fabPlus: { fontSize: 18, fontWeight: '600', marginTop: -1 },
  fabLabel: { fontSize: font.body, fontWeight: '600' },
});
