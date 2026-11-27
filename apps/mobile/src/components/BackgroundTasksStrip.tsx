import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { UiBackgroundTask } from '@pidesktop/shared';
import { font, radius, space, useTheme } from '../theme';
import { t } from '../i18n';
import { FadeIn, StatusDot, TextAction } from './ui';

interface BackgroundTasksStripProps {
  tasks: readonly UiBackgroundTask[];
  canOperate: boolean;
  onStop: (taskId: string) => Promise<void>;
}

function taskTitle(task: UiBackgroundTask): string {
  if (task.note && task.note.trim()) return task.note.trim();
  return task.command.split(/\r?\n/)[0]?.trim() || task.taskId;
}

/** Collapsed to one line by default so it never pushes the conversation out of view. */
export function BackgroundTasksStrip({ tasks, canOperate, onStop }: BackgroundTasksStripProps) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [stoppingIds, setStoppingIds] = useState<Record<string, boolean>>({});
  const [stopError, setStopError] = useState<string | null>(null);
  const visible = tasks.filter((task) => task.status === 'running' || !task.delivered);
  if (visible.length === 0) return null;
  const running = visible.filter((task) => task.status === 'running').length;

  const handleStop = async (taskId: string) => {
    if (stoppingIds[taskId]) return;
    setStoppingIds((prev) => ({ ...prev, [taskId]: true }));
    setStopError(null);
    try {
      await onStop(taskId);
    } catch (err) {
      setStopError(err instanceof Error ? err.message : String(err));
    } finally {
      setStoppingIds((prev) => {
        const next = { ...prev };
        delete next[taskId];
        return next;
      });
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.surface }]}>
      <Pressable onPress={() => setOpen((value) => !value)} style={styles.summary} hitSlop={4}>
        <StatusDot color={running > 0 ? theme.brand : theme.success} size={6} />
        <Text style={[styles.summaryText, { color: theme.textSubtle }]} numberOfLines={1}>
          {t('chat.background', { n: visible.length })}
          {open ? '' : ` · ${taskTitle(visible[0])}`}
        </Text>
        <Text style={{ color: theme.textMuted, fontSize: font.small }}>{open ? '▴' : '▾'}</Text>
      </Pressable>
      {stopError ? (
        <View style={styles.row}>
          <Text style={[styles.error, { color: theme.danger }]}>{stopError}</Text>
          <TextAction label={t('common.dismiss')} tone="muted" onPress={() => setStopError(null)} />
        </View>
      ) : null}
      {open ? (
        <FadeIn>
          {visible.map((task) => {
            const isRunning = task.status === 'running';
            const stopping = Boolean(stoppingIds[task.taskId]);
            const color = isRunning ? theme.brand : task.status === 'completed' ? theme.success : theme.danger;
            const exit = task.exitCode !== undefined && task.exitCode !== null ? ` · ${t('chat.exit', { n: task.exitCode })}` : '';
            return (
              <View key={task.taskId} style={styles.row}>
                <StatusDot color={color} size={6} />
                <View style={styles.copy}>
                  <Text style={[styles.title, { color: theme.text }]} numberOfLines={1}>
                    {taskTitle(task)}
                  </Text>
                  <Text style={[styles.meta, { color: theme.textMuted }]} numberOfLines={1}>
                    {isRunning ? t('chat.toolRunning') : `${task.status}${exit}`}
                  </Text>
                </View>
                {isRunning && canOperate ? (
                  <TextAction
                    label={stopping ? t('common.stopping') : t('common.stop')}
                    tone="danger"
                    disabled={stopping}
                    onPress={() => void handleStop(task.taskId)}
                  />
                ) : null}
              </View>
            );
          })}
        </FadeIn>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginHorizontal: space.lg, marginBottom: space.sm, borderRadius: radius.md, paddingHorizontal: space.md },
  summary: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 9 },
  summaryText: { flex: 1, fontSize: font.small },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm },
  copy: { flex: 1, gap: 1 },
  title: { fontSize: font.small, fontWeight: '500' },
  meta: { fontSize: font.caption },
  error: { flex: 1, fontSize: font.caption },
});
