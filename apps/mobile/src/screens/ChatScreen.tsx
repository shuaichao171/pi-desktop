import React, { useMemo, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { UiMessage, UiToolActivity } from '@pidesktop/shared';
import { useRemote } from '../runtime/remoteStore';
import { useTheme } from '../theme';
import { ApprovalCard } from '../components/ApprovalCard';
import { BackgroundTasksStrip } from '../components/BackgroundTasksStrip';
import { ModelAgentSheet } from '../components/ModelAgentSheet';

type TimelineRow =
  | { readonly key: string; readonly kind: 'message'; readonly order: number; readonly message: UiMessage }
  | { readonly key: string; readonly kind: 'tool'; readonly order: number; readonly activity: UiToolActivity };

export function ChatScreen() {
  const theme = useTheme();
  const {
    connection,
    canOperate,
    snapshot,
    pendingDialogs,
    models,
    agents,
    sendPrompt,
    abortTurn,
    interruptShellTools,
    stopBackgroundTask,
    updateQueuedMessage,
    respondDialog,
    setModel,
    setThinkingLevel,
    setSessionAgent,
  } = useRemote();

  const [draft, setDraft] = useState('');
  const [busyMode, setBusyMode] = useState<'followUp' | 'steer'>('followUp');
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const listRef = useRef<FlatList<TimelineRow>>(null);

  const timeline = useMemo<TimelineRow[]>(() => {
    if (!snapshot) return [];
    const rows: TimelineRow[] = [
      ...snapshot.messages.map((message) => ({
        key: `m:${message.id}`,
        kind: 'message' as const,
        order: message.order,
        message,
      })),
      ...snapshot.activities.map((activity) => ({
        key: `t:${activity.id}`,
        kind: 'tool' as const,
        order: activity.order,
        activity,
      })),
    ];
    rows.sort((a, b) => a.order - b.order);
    return rows;
  }, [snapshot]);

  const isBusy = snapshot?.status === 'busy';
  const hasRunningShell = (snapshot?.activities ?? []).some(
    (a) => a.status === 'running' && (a.tool === 'bash' || a.tool === 'powershell'),
  );
  const activeDialog = pendingDialogs[0] ?? null;

  const toggleExpand = (key: string) => {
    setExpandedIds((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || !canOperate) return;
    setDraft('');
    setSendError(null);
    try {
      await sendPrompt(text, isBusy ? busyMode : undefined);
    } catch (err) {
      setDraft(text);
      setSendError(err instanceof Error ? err.message : String(err));
    }
  };

  if (connection.phase !== 'connected' || !snapshot) {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]}>
        <Text style={{ color: theme.textSubtle, fontSize: 15 }}>
          {connection.phase === 'reconnecting'
            ? `Reconnecting to desktop (attempt ${connection.attempt})…`
            : 'Not connected to a desktop conversation.'}
        </Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: theme.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={76}
    >
      <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <View style={styles.headerCopy}>
          <Text style={[styles.headerTitle, { color: theme.text }]} numberOfLines={1}>
            {snapshot.agent?.displayName ?? 'Pi'} · {snapshot.modelName || snapshot.model || 'Default'}
          </Text>
          <Text style={{ color: theme.textMuted, fontSize: 11 }} numberOfLines={1}>
            {connection.activeRoute?.label ?? 'Remote'} · {isBusy ? 'Running…' : snapshot.status}
            {snapshot.thinkingLevel !== 'off' ? ` · ${snapshot.thinkingLevel}` : ''}
          </Text>
        </View>
        {canOperate && (
          <Pressable
            onPress={() => setPickerOpen(true)}
            style={[styles.modelBtn, { borderColor: theme.border, backgroundColor: theme.surfaceAlt }]}
          >
            <Text style={{ color: theme.text, fontSize: 12, fontWeight: '600' }}>Model</Text>
          </Pressable>
        )}
      </View>

      <FlatList<TimelineRow>
        ref={listRef}
        data={timeline}
        keyExtractor={(item) => item.key}
        contentContainerStyle={styles.listContent}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        ListEmptyComponent={
          <Text style={{ color: theme.textMuted, textAlign: 'center', marginTop: 48 }}>
            Send a prompt to start working on your desktop.
          </Text>
        }
        renderItem={({ item }) => {
          if (item.kind === 'tool') {
            const act = item.activity;
            const expanded = Boolean(expandedIds[item.key]);
            const statusColor =
              act.status === 'running'
                ? theme.brand
                : act.status === 'done'
                  ? theme.success
                  : theme.danger;
            return (
              <Pressable
                onPress={() => toggleExpand(item.key)}
                style={[styles.toolCard, { backgroundColor: theme.surface, borderColor: theme.border }]}
              >
                <View style={styles.toolHead}>
                  <View style={[styles.dot, { backgroundColor: statusColor }]} />
                  <Text style={[styles.toolTitle, { color: theme.text }]} numberOfLines={1}>
                    {act.tool}: {act.title}
                  </Text>
                  <Text style={{ color: theme.textMuted, fontSize: 11 }}>
                    {act.status === 'running' ? 'running' : act.exitCode !== undefined && act.exitCode !== null ? `exit ${act.exitCode}` : act.status}
                  </Text>
                </View>
                {expanded && (
                  <View style={styles.toolBody}>
                    {act.command ? (
                      <Text style={[styles.monoBlock, { backgroundColor: theme.surfaceAlt, color: theme.text }]}>
                        $ {act.command}
                      </Text>
                    ) : null}
                    {act.diff ? (
                      <Text style={[styles.monoBlock, { backgroundColor: theme.surfaceAlt, color: theme.textSubtle }]}>
                        {act.diff.slice(0, 2000)}
                      </Text>
                    ) : null}
                    {act.detail ? (
                      <Text style={[styles.monoBlock, { backgroundColor: theme.surfaceAlt, color: theme.textSubtle }]}>
                        {act.detail.slice(0, 2000)}
                      </Text>
                    ) : null}
                  </View>
                )}
              </Pressable>
            );
          }

          const msg = item.message;
          const isUser = msg.role === 'user';
          const isSystem = msg.role === 'system';
          const thinkingExpanded = Boolean(expandedIds[`think:${msg.id}`]);

          if (isSystem) {
            return (
              <View style={[styles.systemCard, { borderColor: theme.border, backgroundColor: theme.surfaceAlt }]}>
                <Text style={{ color: theme.textSubtle, fontSize: 12 }}>{msg.text}</Text>
              </View>
            );
          }

          return (
            <View
              style={[
                styles.bubble,
                {
                  alignSelf: isUser ? 'flex-end' : 'stretch',
                  backgroundColor: isUser ? theme.userBubble : theme.assistantBubble,
                  borderColor: theme.border,
                },
              ]}
            >
              {!isUser && msg.thinking ? (
                <Pressable
                  onPress={() => toggleExpand(`think:${msg.id}`)}
                  style={[styles.thinkingPill, { backgroundColor: theme.surfaceAlt }]}
                >
                  <Text style={{ color: theme.textSubtle, fontSize: 11, fontWeight: '600' }}>
                    {thinkingExpanded ? 'Hide thinking' : `Thinking (${msg.thinkingStatus ?? 'done'})`}
                  </Text>
                  {thinkingExpanded ? (
                    <Text style={{ color: theme.textSubtle, fontSize: 12, marginTop: 6 }}>
                      {msg.thinking}
                    </Text>
                  ) : null}
                </Pressable>
              ) : null}
              <Text style={[styles.messageText, { color: theme.text }]} selectable>
                {msg.text || (msg.status === 'streaming' ? '…' : '')}
              </Text>
              {msg.errorMessage ? (
                <Text style={{ color: theme.danger, fontSize: 12, marginTop: 6 }}>{msg.errorMessage}</Text>
              ) : null}
            </View>
          );
        }}
      />

      <BackgroundTasksStrip
        tasks={snapshot.backgroundTasks ?? []}
        canOperate={canOperate}
        onStop={stopBackgroundTask}
      />

      {snapshot.queuedMessages.length > 0 && (
        <View style={[styles.queueBox, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Text style={{ color: theme.textSubtle, fontSize: 11, fontWeight: '700' }}>
            QUEUED ({snapshot.queuedMessages.length})
          </Text>
          {snapshot.queuedMessages.map((q) => (
            <View key={q.id} style={styles.queueRow}>
              <Text style={{ color: theme.text, flex: 1, fontSize: 13 }} numberOfLines={1}>
                [{q.behavior}] {q.text}
              </Text>
              {canOperate && (
                <>
                  <Pressable onPress={() => void updateQueuedMessage(q.id, 'steer')}>
                    <Text style={{ color: theme.brand, fontSize: 12, fontWeight: '600' }}>Steer</Text>
                  </Pressable>
                  <Pressable onPress={() => void updateQueuedMessage(q.id, 'remove')}>
                    <Text style={{ color: theme.danger, fontSize: 12, fontWeight: '600' }}>Remove</Text>
                  </Pressable>
                </>
              )}
            </View>
          ))}
        </View>
      )}

      {activeDialog && (
        <ApprovalCard request={activeDialog} canOperate={canOperate} onRespond={respondDialog} />
      )}

      {sendError ? (
        <Text style={{ color: theme.danger, fontSize: 12, paddingHorizontal: 14, paddingBottom: 4 }}>
          {sendError}
        </Text>
      ) : null}

      <View style={[styles.composer, { backgroundColor: theme.surface, borderTopColor: theme.border }]}>
        {isBusy && canOperate && (
          <View style={styles.busyBar}>
            <Pressable
              onPress={() => setBusyMode((m) => (m === 'followUp' ? 'steer' : 'followUp'))}
              style={[styles.busyChip, { borderColor: theme.border, backgroundColor: theme.surfaceAlt }]}
            >
              <Text style={{ color: theme.text, fontSize: 11, fontWeight: '600' }}>
                Send as: {busyMode === 'steer' ? 'Steer now' : 'Follow-up queue'}
              </Text>
            </Pressable>
            {hasRunningShell && (
              <Pressable
                onPress={() => void interruptShellTools()}
                style={[styles.busyChip, { borderColor: theme.warning }]}
              >
                <Text style={{ color: theme.warning, fontSize: 11, fontWeight: '600' }}>Interrupt Shell</Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => void abortTurn()}
              style={[styles.busyChip, { borderColor: theme.danger, backgroundColor: theme.danger }]}
            >
              <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>Stop</Text>
            </Pressable>
          </View>
        )}

        <View style={styles.composerRow}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            editable={canOperate}
            multiline
            placeholder={
              !canOperate
                ? 'Read-only session'
                : isBusy
                  ? busyMode === 'steer'
                    ? 'Steer the running turn…'
                    : 'Queue a follow-up message…'
                  : 'Message Pi Desktop…'
            }
            placeholderTextColor={theme.textMuted}
            style={[
              styles.input,
              { borderColor: theme.border, backgroundColor: theme.surfaceAlt, color: theme.text },
            ]}
          />
          <Pressable
            disabled={!canOperate || !draft.trim()}
            onPress={() => void handleSend()}
            style={[
              styles.sendBtn,
              {
                backgroundColor: canOperate && draft.trim() ? theme.brand : theme.surfaceAlt,
              },
            ]}
          >
            <Text
              style={{
                color: canOperate && draft.trim() ? theme.brandInk : theme.textMuted,
                fontWeight: '700',
                fontSize: 14,
              }}
            >
              Send
            </Text>
          </Pressable>
        </View>
      </View>

      <ModelAgentSheet
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        currentAgentId={snapshot.agent?.id ?? 'pi'}
        currentProvider={snapshot.modelProvider}
        currentModelId={snapshot.model}
        currentThinking={snapshot.thinkingLevel}
        availableThinking={snapshot.availableThinkingLevels}
        models={models}
        agents={agents}
        onSelectAgent={setSessionAgent}
        onSelectModel={setModel}
        onSelectThinking={setThinkingLevel}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  headerCopy: { flex: 1, gap: 2 },
  headerTitle: { fontSize: 15, fontWeight: '700' },
  modelBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  listContent: { padding: 12, gap: 10, paddingBottom: 18 },
  bubble: { maxWidth: '94%', padding: 12, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  messageText: { fontSize: 14, lineHeight: 21 },
  thinkingPill: { padding: 8, borderRadius: 8, marginBottom: 8 },
  systemCard: { padding: 9, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth },
  toolCard: { borderRadius: 10, borderWidth: 1, padding: 10, gap: 8 },
  toolHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  toolTitle: { flex: 1, fontSize: 13, fontWeight: '600' },
  toolBody: { gap: 6 },
  monoBlock: { fontFamily: 'monospace', fontSize: 11, padding: 8, borderRadius: 6 },
  queueBox: { marginHorizontal: 12, marginBottom: 8, padding: 10, borderRadius: 10, borderWidth: 1, gap: 6 },
  queueRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, padding: 10, gap: 8 },
  busyBar: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  busyChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, borderWidth: 1 },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
  },
  sendBtn: { paddingHorizontal: 16, paddingVertical: 11, borderRadius: 10 },
});
