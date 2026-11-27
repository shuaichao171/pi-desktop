import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { UiFileDiff, WorkspaceEntry, WorkspaceGitStatus } from '@pidesktop/shared';
import { isRemoteConversationWorkspace } from '@pidesktop/shared/remoteClient';
import { useRemote } from '../runtime/remoteStore';
import { font, radius, space, useTheme } from '../theme';
import { t } from '../i18n';
import { Banner, EmptyState, Header, Segmented, Separator } from '../components/ui';

interface WorkspaceScreenProps {
  onBack: () => void;
}

type TabKind = 'files' | 'git' | 'changes';

const MAX_VIEWER_LINES = 2000;

function folderBasename(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Splits "src/app/main.ts" into a bold file name and a muted folder. */
function PathLabel({ path }: { path: string }) {
  const theme = useTheme();
  const index = path.lastIndexOf('/');
  const name = index >= 0 ? path.slice(index + 1) : path;
  const dir = index >= 0 ? path.slice(0, index) : '';
  return (
    <View style={styles.pathLabel}>
      <Text style={[styles.rowText, { color: theme.text }]} numberOfLines={1}>
        {name}
      </Text>
      {dir ? (
        <Text style={[styles.rowDir, { color: theme.textMuted }]} numberOfLines={1}>
          {dir}
        </Text>
      ) : null}
    </View>
  );
}

export function WorkspaceScreen({ onBack }: WorkspaceScreenProps) {
  const theme = useTheme();
  const { connection, snapshot, conversationWorkspaces, listFiles, readFile, getGitStatus, getGitDiff, getFileChangeDiffs } = useRemote();
  const [tab, setTab] = useState<TabKind>('git');
  const [currentDir, setCurrentDir] = useState('');
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [gitStatus, setGitStatus] = useState<WorkspaceGitStatus | null>(null);
  const [changeDiffs, setChangeDiffs] = useState<UiFileDiff[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewer, setViewer] = useState<{ title: string; body: string; isDiff: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const snapshotCwd = snapshot?.cwd ?? '';
  const sessionId = snapshot?.sessionId ?? '';
  const sessionPath = snapshot?.sessionPath ?? '';
  const fileChanges = snapshot?.fileChanges;

  const loadReqIdRef = useRef(0);
  const viewerReqIdRef = useRef(0);
  const lastCwdRef = useRef(snapshotCwd);

  // Immediately treat directory as root when workspace changes so loadCurrent never fetches a stale subdir.
  const effectiveDir = lastCwdRef.current === snapshotCwd ? currentDir : '';

  useEffect(() => {
    loadReqIdRef.current += 1;
    viewerReqIdRef.current += 1;
    lastCwdRef.current = snapshotCwd;
    setCurrentDir('');
    setEntries([]);
    setGitStatus(null);
    setChangeDiffs([]);
    setViewer(null);
    setError(null);
    setLoading(false);
  }, [snapshotCwd]);

  useEffect(() => {
    setChangeDiffs([]);
  }, [sessionId, sessionPath]);

  useEffect(() => {
    if (connection.phase !== 'connected') {
      loadReqIdRef.current += 1;
      viewerReqIdRef.current += 1;
      setLoading(false);
    }
  }, [connection.phase]);

  const loadCurrent = useCallback(async () => {
    if (connection.phase !== 'connected') return;
    const reqId = ++loadReqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      if (tab === 'files') {
        const nextEntries = await listFiles(effectiveDir);
        if (reqId !== loadReqIdRef.current) return;
        setEntries(nextEntries);
      } else if (tab === 'git') {
        const nextStatus = await getGitStatus();
        if (reqId !== loadReqIdRef.current) return;
        setGitStatus(nextStatus);
      } else {
        const nextDiffs = await getFileChangeDiffs({ kind: 'conversation' });
        if (reqId !== loadReqIdRef.current) return;
        setChangeDiffs(nextDiffs);
      }
    } catch (err) {
      if (reqId !== loadReqIdRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (reqId === loadReqIdRef.current) {
        setLoading(false);
      }
    }
  }, [connection.phase, tab, effectiveDir, listFiles, getGitStatus, getFileChangeDiffs]);

  // Only react to session / fileChanges updates while viewing the Thread Diffs tab.
  const changesFileTrigger = tab === 'changes' ? fileChanges : null;
  const changesSessionTrigger = tab === 'changes' ? `${sessionId}|${sessionPath}` : '';

  useEffect(() => {
    void loadCurrent();
  }, [loadCurrent, snapshotCwd, changesFileTrigger, changesSessionTrigger]);

  const closeViewer = useCallback(() => {
    viewerReqIdRef.current += 1;
    setViewer(null);
  }, []);

  // The viewer is an inner page: Android back closes it before leaving the files page.
  useEffect(() => {
    if (!viewer) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      closeViewer();
      return true;
    });
    return () => sub.remove();
  }, [viewer, closeViewer]);

  const openFile = async (relativePath: string) => {
    const reqId = ++viewerReqIdRef.current;
    setError(null);
    try {
      const content = await readFile(relativePath);
      if (reqId !== viewerReqIdRef.current) return;
      setViewer({ title: relativePath, body: content, isDiff: false });
    } catch (err) {
      if (reqId !== viewerReqIdRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const openGitDiff = async (relativePath: string) => {
    const reqId = ++viewerReqIdRef.current;
    setError(null);
    try {
      const diff = await getGitDiff(relativePath, 'all');
      if (reqId !== viewerReqIdRef.current) return;
      setViewer({ title: relativePath, body: diff || t('files.noDiff'), isDiff: true });
    } catch (err) {
      if (reqId !== viewerReqIdRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const viewerData = useMemo(() => {
    if (!viewer) return { lines: [] as string[], truncated: false, totalLines: 0 };
    const allLines = viewer.body.split('\n');
    if (allLines.length <= MAX_VIEWER_LINES) {
      return { lines: allLines, truncated: false, totalLines: allLines.length };
    }
    return {
      lines: allLines.slice(0, MAX_VIEWER_LINES),
      truncated: true,
      totalLines: allLines.length,
    };
  }, [viewer]);

  const renderViewerLine = useCallback(
    ({ item: line }: { item: string }) => {
      const isAdd = Boolean(viewer?.isDiff && line.startsWith('+') && !line.startsWith('+++'));
      const isDel = Boolean(viewer?.isDiff && line.startsWith('-') && !line.startsWith('---'));
      const isHunk = Boolean(viewer?.isDiff && line.startsWith('@@'));
      return (
        <Text
          style={[
            styles.codeLine,
            {
              color: isAdd ? theme.diffAddText : isDel ? theme.diffDelText : isHunk ? theme.brand : theme.text,
              backgroundColor: isAdd ? theme.diffAddBg : isDel ? theme.diffDelBg : 'transparent',
            },
          ]}
        >
          {line || ' '}
        </Text>
      );
    },
    [viewer?.isDiff, theme],
  );

  if (connection.phase !== 'connected') {
    return (
      <View style={[styles.container, { backgroundColor: theme.bg }]}>
        <Header title={t('files.title')} onBack={onBack} />
        <EmptyState title={t('chat.notConnected')} />
      </View>
    );
  }

  if (viewer) {
    const slash = viewer.title.lastIndexOf('/');
    return (
      <View style={[styles.container, { backgroundColor: theme.bg }]}>
        <Header
          title={slash >= 0 ? viewer.title.slice(slash + 1) : viewer.title}
          subtitle={slash >= 0 ? viewer.title.slice(0, slash) : undefined}
          onBack={closeViewer}
        />
        <FlatList<string>
          data={viewerData.lines}
          keyExtractor={(_line, index) => String(index)}
          renderItem={renderViewerLine}
          initialNumToRender={40}
          maxToRenderPerBatch={40}
          windowSize={11}
          removeClippedSubviews
          style={[styles.viewer, { backgroundColor: theme.surface }]}
          contentContainerStyle={styles.viewerContent}
          ListFooterComponent={
            viewerData.truncated ? (
              <Text style={[styles.truncated, { color: theme.textMuted }]}>
                {t('files.truncated', { shown: MAX_VIEWER_LINES.toLocaleString(), total: viewerData.totalLines.toLocaleString() })}
              </Text>
            ) : null
          }
        />
      </View>
    );
  }

  const gitEntries = gitStatus?.entries ?? [];
  const refresh = <RefreshControl refreshing={loading} onRefresh={() => void loadCurrent()} colors={[theme.brand]} progressBackgroundColor={theme.surface} />;

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <Header title={t('files.title')} subtitle={
          snapshotCwd && !isRemoteConversationWorkspace(snapshotCwd, conversationWorkspaces) ? folderBasename(snapshotCwd) : undefined
        } onBack={onBack} />

      <View style={styles.segmentWrap}>
        <Segmented<TabKind>
          value={tab}
          onChange={setTab}
          options={[
            { key: 'git', label: t('files.tab.git') },
            { key: 'changes', label: t('files.tab.thread') },
            { key: 'files', label: t('files.tab.browse') },
          ]}
        />
      </View>

      {error ? <Banner tone="danger" text={error} actionLabel={t('common.dismiss')} onPress={() => setError(null)} /> : null}

      <ScrollView refreshControl={refresh} contentContainerStyle={styles.body}>
        {tab === 'files' ? (
          <>
            {effectiveDir !== '' ? (
              <>
                <Pressable
                  onPress={() => {
                    const parts = effectiveDir.split('/').filter(Boolean);
                    parts.pop();
                    setCurrentDir(parts.join('/'));
                  }}
                  style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.surface }]}
                >
                  <Text style={[styles.rowText, { color: theme.brand }]}>‹ {t('files.up')}</Text>
                  <Text style={[styles.rowDir, styles.flexShrink, { color: theme.textMuted }]} numberOfLines={1}>
                    /{effectiveDir}
                  </Text>
                </Pressable>
                <Separator />
              </>
            ) : null}
            {entries.length === 0 && !loading ? (
              <EmptyState title={t('files.emptyDir')} />
            ) : (
              entries.map((entry, index) => (
                <React.Fragment key={entry.path}>
                  {index > 0 ? <Separator /> : null}
                  <Pressable
                    onPress={() => {
                      if (entry.kind === 'directory') setCurrentDir(entry.path);
                      else void openFile(entry.path);
                    }}
                    style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.surface }]}
                  >
                    <Text style={[styles.rowText, styles.flex, { color: theme.text, fontWeight: entry.kind === 'directory' ? '600' : '400' }]} numberOfLines={1}>
                      {entry.name}
                      {entry.kind === 'directory' ? '/' : ''}
                    </Text>
                    {entry.kind === 'directory' ? <Text style={[styles.chevron, { color: theme.textMuted }]}>›</Text> : null}
                  </Pressable>
                </React.Fragment>
              ))
            )}
          </>
        ) : null}

        {tab === 'git' ? (
          gitStatus && !gitStatus.isRepository ? (
            <EmptyState title={t('files.notRepo')} />
          ) : (
            <>
              <Text style={[styles.caption, { color: theme.textMuted }]}>
                {t('files.branch', { branch: gitStatus?.branch ?? '—', n: gitEntries.length })}
              </Text>
              {gitEntries.length === 0 && !loading ? (
                <EmptyState title={t('files.clean')} />
              ) : (
                gitEntries.map((entry, index) => (
                  <React.Fragment key={entry.path}>
                    {index > 0 ? <Separator /> : null}
                    <Pressable
                      onPress={() => void openGitDiff(entry.path)}
                      style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.surface }]}
                    >
                      <PathLabel path={entry.path} />
                      <Text style={[styles.badge, { color: theme.warning, backgroundColor: theme.warningSoft }]}>{entry.status || 'M'}</Text>
                    </Pressable>
                  </React.Fragment>
                ))
              )}
            </>
          )
        ) : null}

        {tab === 'changes' ? (
          changeDiffs.length === 0 ? (
            <EmptyState title={t('files.noThreadChanges')} />
          ) : (
            changeDiffs.map((item, index) => (
              <React.Fragment key={item.path}>
                {index > 0 ? <Separator /> : null}
                <Pressable
                  onPress={() => {
                    viewerReqIdRef.current += 1;
                    setViewer({
                      title: item.path,
                      body: item.diff ?? `(${item.preview ?? t('files.diffUnavailable')})`,
                      isDiff: true,
                    });
                  }}
                  style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.surface }]}
                >
                  <PathLabel path={item.path} />
                  <Text style={[styles.chevron, { color: theme.textMuted }]}>›</Text>
                </Pressable>
              </React.Fragment>
            ))
          )
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  flexShrink: { flexShrink: 1 },
  segmentWrap: { paddingHorizontal: space.lg, paddingBottom: space.sm },
  body: { paddingBottom: space.xl },
  caption: { fontSize: font.caption, paddingHorizontal: space.lg, paddingVertical: space.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  pathLabel: { flex: 1, gap: 1 },
  rowText: { fontSize: font.body },
  rowDir: { fontSize: font.caption },
  chevron: { fontSize: 20, lineHeight: 22 },
  badge: { fontSize: 11, fontWeight: '700', paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.sm, overflow: 'hidden' },
  viewer: { flex: 1, marginHorizontal: space.md, marginBottom: space.md, borderRadius: radius.md },
  viewerContent: { padding: space.md },
  codeLine: { fontFamily: 'monospace', fontSize: font.caption, lineHeight: 18, paddingHorizontal: space.xs },
  truncated: { fontSize: font.caption, paddingTop: space.md },
});
