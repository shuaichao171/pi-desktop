import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { agentCapabilities, type UiMessage, type UiToolActivity } from '@pidesktop/shared';
import { useRemote } from '../runtime/remoteStore';
import { font, radius, space, useTheme } from '../theme';
import { t, thinkingLabel } from '../i18n';
import { ApprovalCard } from '../components/ApprovalCard';
import { BackgroundTasksStrip } from '../components/BackgroundTasksStrip';
import { ModelAgentSheet } from '../components/ModelAgentSheet';
import { Banner, Chip, EmptyState, Header, StatusDot, TextAction } from '../components/ui';

interface ChatScreenProps {
  onBack: () => void;
  onOpenFiles: () => void;
}

type TimelineRow =
  | { readonly key: string; readonly kind: 'message'; readonly order: number; readonly message: UiMessage }
  | { readonly key: string; readonly kind: 'tool'; readonly order: number; readonly activity: UiToolActivity };

const PREVIEW_LIMIT = 2000;

/** Rows keep their own expand state, so opening one tool or thought never re-renders the whole timeline. */
const MessageRow = memo(function MessageRow({ message }: { message: UiMessage }) {
  const theme = useTheme();
  const [thinkingOpen, setThinkingOpen] = useState(false);

  if (message.role === 'system') {
    return (
      <Text style={[styles.systemText, { color: theme.textMuted }]} numberOfLines={6}>
        {message.text}
      </Text>
    );
  }

  if (message.role === 'user') {
    return (
      <View style={[styles.userBubble, { backgroundColor: theme.userBubble }]}>
        <Text style={[styles.messageText, { color: theme.text }]} selectable>
          {message.text}
        </Text>
      </View>
    );
  }

  const thinkingLive = message.thinkingStatus === 'streaming';
  return (
    <View style={styles.assistant}>
      {message.thinking ? (
        <Pressable onPress={() => setThinkingOpen((open) => !open)} hitSlop={6}>
          <Text style={[styles.thinkingToggle, { color: theme.textMuted }]}>
            {thinkingLive ? t('chat.thinkingLive') : t('chat.thinking')} {thinkingOpen ? '▴' : '▾'}
          </Text>
          {thinkingOpen ? (
            <Text style={[styles.thinkingBody, { color: theme.textSubtle, borderLeftColor: theme.border }]}>{message.thinking}</Text>
          ) : null}
        </Pressable>
      ) : null}
      {message.text ? (
        <Text style={[styles.messageText, { color: theme.text }]} selectable>
          {message.text}
        </Text>
      ) : message.status === 'streaming' && !thinkingLive ? (
        <Text style={[styles.messageText, { color: theme.textMuted }]}>…</Text>
      ) : null}
      {message.errorMessage ? <Text style={[styles.errorText, { color: theme.danger }]}>{message.errorMessage}</Text> : null}
    </View>
  );
});

const ToolRow = memo(function ToolRow({ activity }: { activity: UiToolActivity }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const exitFailed = activity.exitCode !== undefined && activity.exitCode !== null && activity.exitCode !== 0;
  const failed = activity.status === 'error' || exitFailed;
  const dotColor =
    activity.status === 'running' ? theme.brand : failed ? theme.danger : activity.status === 'interrupted' ? theme.warning : theme.success;
  const statusText =
    activity.status === 'running'
      ? t('chat.toolRunning')
      : activity.status === 'interrupted'
        ? t('chat.toolInterrupted')
        : exitFailed
          ? t('chat.exit', { n: activity.exitCode ?? '' })
          : activity.status === 'error'
            ? t('chat.toolFailed')
            : '';
  const hasBody = Boolean(activity.command || activity.diff || activity.detail);
  return (
    <Pressable
      onPress={() => hasBody && setOpen((value) => !value)}
      style={({ pressed }) => [styles.tool, { backgroundColor: pressed && hasBody ? theme.surface : 'transparent' }]}
    >
      <View style={styles.toolHead}>
        <StatusDot color={dotColor} size={6} />
        <Text style={[styles.toolName, { color: theme.textSubtle }]}>{activity.tool}</Text>
        <Text style={[styles.toolTitle, { color: theme.textMuted }]} numberOfLines={1}>
          {activity.title}
        </Text>
        {statusText ? <Text style={[styles.toolStatus, { color: failed ? theme.danger : theme.textMuted }]}>{statusText}</Text> : null}
      </View>
      {open ? (
        <View style={styles.toolBody}>
          {activity.command ? (
            <Text style={[styles.mono, { backgroundColor: theme.surface, color: theme.text }]} selectable>
              $ {activity.command}
            </Text>
          ) : null}
          {activity.diff ? (
            <Text style={[styles.mono, { backgroundColor: theme.surface, color: theme.textSubtle }]} selectable>
              {activity.diff.slice(0, PREVIEW_LIMIT)}
            </Text>
          ) : null}
          {activity.detail ? (
            <Text style={[styles.mono, { backgroundColor: theme.surface, color: theme.textSubtle }]} selectable>
              {activity.detail.slice(0, PREVIEW_LIMIT)}
            </Text>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
});

export function ChatScreen({ onBack, onOpenFiles }: ChatScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const {
    connection,
    canOperate,
    snapshot,
    pendingDialogs,
    sessionsByCwd,
    models,
    agents,
    refreshNavigationData,
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
  } = useRemote();

  const [draft, setDraft] = useState('');
  const [busyMode, setBusyMode] = useState<'followUp' | 'steer'>('followUp');
  const [pickerOpen, setPickerOpen] = useState(false);
  // The host lists no models until its runtime has a session, so fetch again every time the sheet opens.
  const openPicker = useCallback(() => {
    setPickerOpen(true);
    void refreshNavigationData();
  }, [refreshNavigationData]);
  const [sendError, setSendError] = useState<string | null>(null);
  const [dismissedSnapshotError, setDismissedSnapshotError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const listRef = useRef<FlatList<TimelineRow>>(null);
  const isNearBottomRef = useRef(true);
  const forceScrollNextRef = useRef(false);
  const sendingRef = useRef(false);

  const sessionKey = `${snapshot?.sessionId ?? ''}|${snapshot?.sessionPath ?? ''}`;
  const snapshotError = snapshot?.error ?? null;

  useEffect(() => {
    setSendError(null);
    setDismissedSnapshotError(null);
    isNearBottomRef.current = true;
  }, [sessionKey]);

  useEffect(() => {
    if (!snapshotError || snapshotError !== dismissedSnapshotError) {
      setDismissedSnapshotError(null);
    }
  }, [snapshotError, dismissedSnapshotError]);

  const timeline = useMemo<TimelineRow[]>(() => {
    if (!snapshot) return [];
    const rows: TimelineRow[] = [
      ...snapshot.messages.map((message) => ({ key: `m:${message.id}`, kind: 'message' as const, order: message.order, message })),
      ...snapshot.activities.map((activity) => ({ key: `t:${activity.id}`, kind: 'tool' as const, order: activity.order, activity })),
    ];
    rows.sort((a, b) => a.order - b.order);
    return rows;
  }, [snapshot?.messages, snapshot?.activities]);

  const sessionPath = snapshot?.sessionPath ?? null;
  const title = useMemo(() => {
    if (sessionPath) {
      for (const list of Object.values(sessionsByCwd)) {
        const found = list.find((s) => s.path === sessionPath);
        if (found && (found.name || found.firstMessage)) return found.name || found.firstMessage;
      }
    }
    const firstUser = snapshot?.messages.find((m) => m.role === 'user');
    return firstUser?.text.split('\n')[0] || t('home.untitled');
  }, [sessionPath, sessionsByCwd, snapshot?.messages]);

  const isBusy = snapshot?.status === 'busy';
  const supportsSteer = agentCapabilities(snapshot?.agent).steer;
  const agentLocked = Boolean(snapshot?.messages.some((m) => m.role === 'user' || m.role === 'assistant'));
  const hasRunningShell = (snapshot?.activities ?? []).some(
    (a) => a.status === 'running' && (a.tool === 'bash' || a.tool === 'powershell'),
  );
  const activeDialog = pendingDialogs[0] ?? null;
  const visibleSnapshotError = snapshotError && snapshotError !== dismissedSnapshotError ? snapshotError : null;

  const runControl = async (work: () => Promise<void>) => {
    setSendError(null);
    try {
      await work();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || !canOperate || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setDraft('');
    setSendError(null);
    isNearBottomRef.current = true;
    forceScrollNextRef.current = true;
    const effectiveBehavior = isBusy ? (supportsSteer ? busyMode : 'followUp') : undefined;
    try {
      await sendPrompt(text, effectiveBehavior);
      listRef.current?.scrollToEnd({ animated: true });
    } catch (err) {
      setDraft((curr) => curr || text);
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  if (!snapshot) {
    const reconnecting = connection.phase === 'reconnecting' || connection.phase === 'connecting';
    return (
      <View style={[styles.container, { backgroundColor: theme.bg }]}>
        <Header title={t('home.untitled')} onBack={onBack} />
        <EmptyState
          title={reconnecting ? t('conn.reconnecting', { n: connection.attempt }) : t('chat.notConnected')}
          action={reconnecting ? <ActivityIndicator color={theme.brand} /> : null}
        />
      </View>
    );
  }

  const connected = connection.phase === 'connected';
  const modelLabel = snapshot.modelName || snapshot.model || t('model.default');
  const subtitle = [
    snapshot.agent && snapshot.agent.id !== 'pi' ? snapshot.agent.displayName : null,
    modelLabel,
    snapshot.thinkingLevel !== 'off' ? thinkingLabel(snapshot.thinkingLevel) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const hasDraft = draft.trim().length > 0;
  const canSend = canOperate && connected && hasDraft && !sending;
  const placeholder = !canOperate
    ? t('chat.readOnly')
    : isBusy
      ? supportsSteer && busyMode === 'steer'
        ? t('chat.placeholderSteer')
        : t('chat.placeholderQueue')
      : t('chat.placeholder');

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: theme.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
    >
      <Header
        title={title}
        subtitle={subtitle}
        onBack={onBack}
        onTitlePress={canOperate ? openPicker : undefined}
        right={<TextAction label={t('chat.files')} onPress={onOpenFiles} />}
      />

      {!connected ? (
        <Banner
          tone={connection.phase === 'auth-error' ? 'danger' : 'warning'}
          text={
            connection.phase === 'auth-error'
              ? t('conn.authError')
              : connection.phase === 'disconnected'
                ? t('conn.disconnected')
                : t('conn.reconnecting', { n: connection.attempt })
          }
        />
      ) : null}

      {visibleSnapshotError ? (
        <Banner
          tone="danger"
          text={visibleSnapshotError}
          actionLabel={t('common.dismiss')}
          onPress={() => setDismissedSnapshotError(visibleSnapshotError)}
        />
      ) : null}

      <FlatList<TimelineRow>
        ref={listRef}
        style={styles.flex}
        data={timeline}
        keyExtractor={(item) => item.key}
        contentContainerStyle={[styles.listContent, timeline.length === 0 ? styles.flexGrow : null]}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={16}
        windowSize={11}
        scrollEventThrottle={100}
        onScroll={(event) => {
          const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
          const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
          isNearBottomRef.current = distanceFromBottom <= 80;
        }}
        onContentSizeChange={() => {
          // Follow new output only while the reader is at the bottom; scrolling up to read stays put.
          if (forceScrollNextRef.current || isNearBottomRef.current) {
            forceScrollNextRef.current = false;
            listRef.current?.scrollToEnd({ animated: false });
          }
        }}
        ListEmptyComponent={<EmptyState title={t('chat.empty')} />}
        ListFooterComponent={
          isBusy ? (
            <View style={styles.running}>
              <ActivityIndicator size="small" color={theme.textMuted} />
              <Text style={{ color: theme.textMuted, fontSize: font.small }}>{t('chat.running')}</Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => (item.kind === 'tool' ? <ToolRow activity={item.activity} /> : <MessageRow message={item.message} />)}
      />

      <BackgroundTasksStrip tasks={snapshot.backgroundTasks ?? []} canOperate={canOperate} onStop={stopBackgroundTask} />

      {snapshot.queuedMessages.length > 0 ? (
        <View style={[styles.queue, { backgroundColor: theme.surface }]}>
          <Text style={[styles.queueLabel, { color: theme.textMuted }]}>{t('chat.queued', { n: snapshot.queuedMessages.length })}</Text>
          {snapshot.queuedMessages.map((q) => (
            <View key={q.id} style={styles.queueRow}>
              <Text style={{ color: theme.text, flex: 1, fontSize: font.small }} numberOfLines={1}>
                {q.text}
              </Text>
              {canOperate ? (
                <>
                  {supportsSteer ? (
                    <TextAction label={t('chat.queueSteer')} onPress={() => void runControl(() => updateQueuedMessage(q.id, 'steer'))} />
                  ) : null}
                  <TextAction
                    label={t('chat.queueRemove')}
                    tone="danger"
                    onPress={() => void runControl(() => updateQueuedMessage(q.id, 'remove'))}
                  />
                </>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      {activeDialog ? <ApprovalCard key={activeDialog.id} request={activeDialog} canOperate={canOperate} onRespond={respondDialog} /> : null}

      {sendError ? (
        <Banner tone="danger" text={sendError} actionLabel={t('common.dismiss')} onPress={() => setSendError(null)} />
      ) : null}

      <View style={styles.composerWrap}>
        {isBusy && canOperate ? (
          <View style={styles.busyRow}>
            {supportsSteer ? (
              <>
                <Chip label={t('chat.sendQueue')} selected={busyMode === 'followUp'} onPress={() => setBusyMode('followUp')} />
                <Chip label={t('chat.sendSteer')} selected={busyMode === 'steer'} onPress={() => setBusyMode('steer')} />
              </>
            ) : (
              <Text style={[styles.busyHint, { color: theme.textMuted }]} numberOfLines={1}>
                {t('chat.steerUnsupported')}
              </Text>
            )}
            <View style={styles.flex} />
            {hasRunningShell ? (
              <TextAction label={t('chat.interruptShell')} tone="danger" onPress={() => void runControl(() => interruptShellTools())} />
            ) : null}
          </View>
        ) : null}
        <View style={[styles.composer, { backgroundColor: theme.surface }]}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            editable={canOperate}
            multiline
            placeholder={placeholder}
            placeholderTextColor={theme.textMuted}
            style={[styles.input, { color: theme.text }]}
          />
          {isBusy && canOperate && !hasDraft ? (
            <Pressable
              onPress={() => void runControl(() => abortTurn())}
              accessibilityLabel={t('common.stop')}
              style={({ pressed }) => [styles.roundBtn, { backgroundColor: theme.text, opacity: pressed ? 0.75 : 1 }]}
            >
              <View style={[styles.stopSquare, { backgroundColor: theme.bg }]} />
            </Pressable>
          ) : (
            <Pressable
              disabled={!canSend}
              onPress={() => void handleSend()}
              accessibilityLabel={t('common.submit')}
              style={({ pressed }) => [
                styles.roundBtn,
                { backgroundColor: canSend ? theme.brand : theme.surfaceAlt, opacity: pressed ? 0.8 : 1 },
              ]}
            >
              {sending ? (
                <ActivityIndicator size="small" color={theme.textMuted} />
              ) : (
                <Text style={[styles.sendGlyph, { color: canSend ? theme.brandInk : theme.textMuted }]}>↑</Text>
              )}
            </Pressable>
          )}
        </View>
      </View>

      <ModelAgentSheet
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        agent={snapshot.agent}
        agentLocked={agentLocked}
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
        onSelectAgentOption={setAgentOption}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  flexGrow: { flexGrow: 1, justifyContent: 'center' },
  listContent: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.md },
  running: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingTop: space.md },
  userBubble: {
    alignSelf: 'flex-end',
    maxWidth: '86%',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radius.lg,
    borderBottomRightRadius: radius.sm,
  },
  assistant: { gap: space.sm },
  messageText: { fontSize: font.body, lineHeight: 23 },
  errorText: { fontSize: font.small },
  thinkingToggle: { fontSize: font.small, fontWeight: '500' },
  thinkingBody: { fontSize: font.small, lineHeight: 19, marginTop: 6, paddingLeft: 10, borderLeftWidth: 2 },
  systemText: { fontSize: font.caption, textAlign: 'center', paddingHorizontal: space.lg },
  tool: { borderRadius: radius.sm, paddingVertical: 4, marginHorizontal: -6, paddingHorizontal: 6 },
  toolHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  toolName: { fontSize: font.caption, fontWeight: '600' },
  toolTitle: { flex: 1, fontSize: font.caption },
  toolStatus: { fontSize: font.caption },
  toolBody: { gap: 6, marginTop: 6 },
  mono: { fontFamily: 'monospace', fontSize: 11, lineHeight: 16, padding: space.sm, borderRadius: radius.sm, overflow: 'hidden' },
  queue: { marginHorizontal: space.lg, marginBottom: space.sm, paddingHorizontal: space.md, paddingVertical: 10, borderRadius: radius.md, gap: 6 },
  queueLabel: { fontSize: font.caption, fontWeight: '600' },
  queueRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  composerWrap: { paddingHorizontal: space.md, paddingBottom: space.sm, paddingTop: space.xs, gap: space.sm },
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.xs },
  busyHint: { fontSize: font.caption, flexShrink: 1 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderRadius: 22,
    paddingLeft: space.lg,
    paddingRight: 5,
    paddingVertical: 5,
    gap: space.sm,
  },
  input: { flex: 1, minHeight: 36, maxHeight: 140, fontSize: font.body, paddingVertical: 7 },
  roundBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  sendGlyph: { fontSize: 19, fontWeight: '700', marginTop: -2 },
  stopSquare: { width: 12, height: 12, borderRadius: 2 },
});
