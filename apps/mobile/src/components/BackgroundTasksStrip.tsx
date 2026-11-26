import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { UiBackgroundTask } from '@pidesktop/shared';
import { useTheme } from '../theme';

interface BackgroundTasksStripProps {
  tasks: readonly UiBackgroundTask[];
  canOperate: boolean;
  onStop: (taskId: string) => Promise<void>;
}

function taskTitle(task: UiBackgroundTask): string {
  if (task.note && task.note.trim()) return task.note.trim();
  return task.command.split(/\r?\n/)[0]?.trim() || task.taskId;
}

export function BackgroundTasksStrip({ tasks, canOperate, onStop }: BackgroundTasksStripProps) {
  const theme = useTheme();
  const visible = tasks.filter((t) => t.status === 'running' || !t.delivered);
  if (visible.length === 0) return null;

  return (
    <View style={[styles.container, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <Text style={[styles.heading, { color: theme.textSubtle }]}>
        Background Tasks ({visible.length})
      </Text>
      {visible.map((task) => {
        const running = task.status === 'running';
        const statusColor = running ? theme.brand : task.status === 'completed' ? theme.success : theme.danger;
        return (
          <View key={task.taskId} style={[styles.row, { borderTopColor: theme.border }]}>
            <View style={[styles.dot, { backgroundColor: statusColor }]} />
            <View style={styles.copy}>
              <Text style={[styles.title, { color: theme.text }]} numberOfLines={1}>
                {taskTitle(task)}
              </Text>
              <Text style={[styles.meta, { color: theme.textMuted }]} numberOfLines={1}>
                {running ? 'Running' : `${task.status}${task.exitCode !== undefined && task.exitCode !== null ? ` (exit ${task.exitCode})` : ''}`}
              </Text>
            </View>
            {running && canOperate && (
              <Pressable
                onPress={() => void onStop(task.taskId)}
                style={[styles.stopBtn, { borderColor: theme.danger }]}
              >
                <Text style={{ color: theme.danger, fontSize: 12, fontWeight: '600' }}>Stop</Text>
              </Pressable>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: 12,
    marginBottom: 8,
    borderRadius: 10,
    borderWidth: 1,
    overflow: 'hidden',
  },
  heading: { fontSize: 11, fontWeight: '700', paddingHorizontal: 12, paddingVertical: 6, textTransform: 'uppercase' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  copy: { flex: 1, gap: 2 },
  title: { fontSize: 13, fontWeight: '500' },
  meta: { fontSize: 11 },
  stopBtn: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, borderWidth: 1 },
});
