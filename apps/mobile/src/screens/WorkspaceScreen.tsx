import React, { useCallback, useEffect, useState } from 'react';
import {
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { UiFileDiff, WorkspaceEntry, WorkspaceGitStatus } from '@pidesktop/shared';
import { useRemote } from '../runtime/remoteStore';
import { useTheme } from '../theme';

type TabKind = 'files' | 'git' | 'changes';

export function WorkspaceScreen() {
  const theme = useTheme();
  const { connection, snapshot, listFiles, readFile, getGitStatus, getGitDiff, getFileChangeDiffs } = useRemote();
  const [tab, setTab] = useState<TabKind>('git');
  const [currentDir, setCurrentDir] = useState('');
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [gitStatus, setGitStatus] = useState<WorkspaceGitStatus | null>(null);
  const [changeDiffs, setChangeDiffs] = useState<UiFileDiff[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewer, setViewer] = useState<{ title: string; body: string; isDiff: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadCurrent = useCallback(async () => {
    if (connection.phase !== 'connected') return;
    setLoading(true);
    setError(null);
    try {
      if (tab === 'files') {
        setEntries(await listFiles(currentDir));
      } else if (tab === 'git') {
        setGitStatus(await getGitStatus());
      } else {
        setChangeDiffs(await getFileChangeDiffs({ kind: 'conversation' }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [connection.phase, tab, currentDir, listFiles, getGitStatus, getFileChangeDiffs]);

  useEffect(() => {
    void loadCurrent();
  }, [loadCurrent, snapshot?.cwd]);

  const openFile = async (relativePath: string) => {
    try {
      const content = await readFile(relativePath);
      setViewer({ title: relativePath, body: content, isDiff: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const openGitDiff = async (relativePath: string) => {
    try {
      const diff = await getGitDiff(relativePath, 'all');
      setViewer({ title: relativePath, body: diff || '(No diff output)', isDiff: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (connection.phase !== 'connected') {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]}>
        <Text style={{ color: theme.textSubtle }}>Connect to a desktop host to inspect files and Git diffs.</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <View style={[styles.tabBar, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        {(['git', 'changes', 'files'] as TabKind[]).map((item) => {
          const active = tab === item;
          return (
            <Pressable
              key={item}
              onPress={() => setTab(item)}
              style={[
                styles.tabBtn,
                { borderBottomColor: active ? theme.brand : 'transparent' },
              ]}
            >
              <Text style={{ color: active ? theme.brand : theme.textSubtle, fontWeight: '700', fontSize: 13 }}>
                {item === 'git' ? 'Git Status' : item === 'changes' ? 'Thread Diffs' : 'Files'}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {error ? <Text style={{ color: theme.danger, padding: 12, fontSize: 13 }}>{error}</Text> : null}

      <ScrollView
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void loadCurrent()} />}
        contentContainerStyle={styles.body}
      >
        {tab === 'files' && (
          <>
            {currentDir !== '' && (
              <Pressable
                onPress={() => {
                  const parts = currentDir.split('/').filter(Boolean);
                  parts.pop();
                  setCurrentDir(parts.join('/'));
                }}
                style={[styles.row, { backgroundColor: theme.surface, borderColor: theme.border }]}
              >
                <Text style={{ color: theme.brand, fontWeight: '600' }}>← Up (/{currentDir})</Text>
              </Pressable>
            )}
            {entries.map((entry) => (
              <Pressable
                key={entry.path}
                onPress={() => {
                  if (entry.kind === 'directory') setCurrentDir(entry.path);
                  else void openFile(entry.path);
                }}
                style={[styles.row, { backgroundColor: theme.surface, borderColor: theme.border }]}
              >
                <Text style={{ color: theme.text, fontWeight: entry.kind === 'directory' ? '700' : '500' }}>
                  {entry.kind === 'directory' ? '📁 ' : '📄 '}
                  {entry.name}
                </Text>
              </Pressable>
            ))}
          </>
        )}

        {tab === 'git' && (
          <>
            {gitStatus && !gitStatus.isRepository ? (
              <Text style={{ color: theme.textMuted }}>Active workspace is not a Git repository.</Text>
            ) : (
              <>
                <Text style={[styles.branchLabel, { color: theme.textSubtle }]}>
                  Branch: {gitStatus?.branch ?? '—'} · {gitStatus?.entries.length ?? 0} changed file(s)
                </Text>
                {(gitStatus?.entries ?? []).map((entry) => (
                  <Pressable
                    key={entry.path}
                    onPress={() => void openGitDiff(entry.path)}
                    style={[styles.row, { backgroundColor: theme.surface, borderColor: theme.border }]}
                  >
                    <Text style={{ color: theme.text, flex: 1, fontFamily: 'monospace', fontSize: 12 }}>
                      {entry.path}
                    </Text>
                    <Text style={{ color: theme.warning, fontWeight: '700', fontSize: 11 }}>
                      {entry.status || 'M'}
                    </Text>
                  </Pressable>
                ))}
              </>
            )}
          </>
        )}

        {tab === 'changes' && (
          <>
            {changeDiffs.length === 0 ? (
              <Text style={{ color: theme.textMuted }}>No file changes recorded in this conversation.</Text>
            ) : (
              changeDiffs.map((item) => (
                <Pressable
                  key={item.path}
                  onPress={() =>
                    setViewer({
                      title: item.path,
                      body: item.diff ?? `(${item.preview ?? 'Diff unavailable'})`,
                      isDiff: true,
                    })
                  }
                  style={[styles.row, { backgroundColor: theme.surface, borderColor: theme.border }]}
                >
                  <Text style={{ color: theme.text, fontFamily: 'monospace', fontSize: 12 }}>
                    {item.path}
                  </Text>
                </Pressable>
              ))
            )}
          </>
        )}
      </ScrollView>

      <Modal visible={viewer !== null} animationType="slide" onRequestClose={() => setViewer(null)}>
        <View style={[styles.viewerWrap, { backgroundColor: theme.bg }]}>
          <View style={[styles.viewerHeader, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
            <Text style={[styles.viewerTitle, { color: theme.text }]} numberOfLines={1}>
              {viewer?.title}
            </Text>
            <Pressable onPress={() => setViewer(null)}>
              <Text style={{ color: theme.brand, fontWeight: '700', fontSize: 15 }}>Close</Text>
            </Pressable>
          </View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12 }}>
            <ScrollView horizontal>
              <View>
                {(viewer?.body ?? '').split('\n').map((line, index) => {
                  const isAdd = viewer?.isDiff && line.startsWith('+') && !line.startsWith('+++');
                  const isDel = viewer?.isDiff && line.startsWith('-') && !line.startsWith('---');
                  const isHunk = viewer?.isDiff && line.startsWith('@@');
                  return (
                    <Text
                      key={index}
                      style={[
                        styles.codeLine,
                        {
                          color: isAdd
                            ? theme.diffAddText
                            : isDel
                              ? theme.diffDelText
                              : isHunk
                                ? theme.brand
                                : theme.text,
                          backgroundColor: isAdd
                            ? theme.diffAddBg
                            : isDel
                              ? theme.diffDelBg
                              : 'transparent',
                        },
                      ]}
                    >
                      {line || ' '}
                    </Text>
                  );
                })}
              </View>
            </ScrollView>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  tabBar: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  tabBtn: { flex: 1, alignItems: 'center', paddingVertical: 12, borderBottomWidth: 2 },
  body: { padding: 12, gap: 8, paddingBottom: 28 },
  branchLabel: { fontSize: 12, fontWeight: '600', marginBottom: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    gap: 8,
  },
  viewerWrap: { flex: 1 },
  viewerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 52,
    paddingBottom: 14,
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  viewerTitle: { flex: 1, fontSize: 14, fontWeight: '700', fontFamily: 'monospace' },
  codeLine: { fontFamily: 'monospace', fontSize: 12, lineHeight: 18, paddingHorizontal: 4 },
});
