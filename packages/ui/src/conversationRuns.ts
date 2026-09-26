import type { UiConversationRun } from '@pidesktop/shared';

/** Older pages must not restart a run which a newer live event already finished. */
export function mergeConversationRuns(current: UiConversationRun[], incoming: UiConversationRun[]): UiConversationRun[] {
  const result = new Map(current.map(run => [run.id, run]));
  for (const run of incoming) {
    const previous = result.get(run.id);
    if (previous && previous.status !== 'running' && run.status === 'running') continue;
    result.set(run.id, run);
  }
  return [...result.values()];
}

export function formatRunDuration(milliseconds: number, locale: string): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60, rest = seconds % 60;
  if (locale === 'zh-CN') return `${hours ? `${hours}小时 ` : ''}${hours || minutes ? `${minutes}分 ` : ''}${rest}秒`;
  return `${hours ? `${hours}h ` : ''}${hours || minutes ? `${minutes}m ` : ''}${rest}s`;
}
