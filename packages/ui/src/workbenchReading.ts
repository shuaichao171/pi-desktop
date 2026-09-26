import type { WorkspaceCommandEvent, WorkspaceGitStatus } from '@pidesktop/shared';

export type DiffSource = 'staged' | 'unstaged';
export interface ReadingRow { text: string; offset: number; oldLine?: number; newLine?: number; kind: 'plain' | 'context' | 'added' | 'removed' | 'meta' }

/** Section labels and truncation notices remain metadata, never fabricated patch lines. */
export function readingRows(text: string, diff = false): ReadingRow[] {
  let offset = 0, oldLine = 0, newLine = 0, oldRemaining = 0, newRemaining = 0;
  return text.split('\n').map((raw, index) => {
    const row: ReadingRow = { text: raw.replace(/\r$/, ''), offset, kind: diff ? 'meta' : 'plain' };
    offset += raw.length + 1;
    if (!diff) { row.newLine = index + 1; return row; }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[3]);
      oldRemaining = Number(hunk[2] ?? 1); newRemaining = Number(hunk[4] ?? 1);
    } else if (raw.startsWith('+') && newRemaining > 0) {
      row.kind = 'added'; row.newLine = newLine++; newRemaining--;
    } else if (raw.startsWith('-') && oldRemaining > 0) {
      row.kind = 'removed'; row.oldLine = oldLine++; oldRemaining--;
    } else if (raw.startsWith(' ') && oldRemaining > 0 && newRemaining > 0) {
      row.kind = 'context'; row.oldLine = oldLine++; row.newLine = newLine++; oldRemaining--; newRemaining--;
    } else if (!raw.startsWith('\\')) { oldRemaining = 0; newRemaining = 0; }
    return row;
  });
}

export function literalMatches(text: string, query: string): Array<{ start: number; end: number }> {
  if (!query) return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...text.matchAll(new RegExp(escaped, 'giu'))].map(match => ({ start: match.index, end: match.index + match[0].length }));
}

export function groupGitEntries(entries: WorkspaceGitStatus['entries']): Record<DiffSource, WorkspaceGitStatus['entries']> {
  return {
    staged: entries.filter(entry => entry.status[0] !== ' ' && entry.status[0] !== '?' && entry.status[0] !== '!'),
    unstaged: entries.filter(entry => entry.status[1] !== ' ' && entry.status[1] !== '!'),
  };
}

export function clampWorkbenchWidth(width: number, viewport: number): number {
  return Math.max(Math.min(320, viewport), Math.min(width, 800, viewport <= 1100 ? Math.max(320, viewport - 24) : viewport - 480));
}

export function appendCommandOutput(previous: WorkspaceCommandEvent[], event: WorkspaceCommandEvent, previousLength = previous.reduce((sum, item) => sum + (item.data?.length ?? 0), 0)): { events: WorkspaceCommandEvent[]; length: number; omitted: boolean } {
  const events = [...previous];
  const last = events.at(-1);
  if ((event.type === 'stdout' || event.type === 'stderr') && last?.type === event.type && (last.data?.length ?? 0) < 16_000) events[events.length - 1] = { ...last, data: (last.data ?? '') + (event.data ?? '') };
  else events.push(event);
  let length = previousLength + (event.data?.length ?? 0), omitted = false;
  while ((length > 120_000 || events.length > 512) && events.length > 1) { length -= events.shift()?.data?.length ?? 0; omitted = true; }
  if (length > 120_000) { events[0] = { ...events[0]!, data: events[0]!.data!.slice(-120_000) }; length = 120_000; omitted = true; }
  return { events, length, omitted };
}

export function commandOutput(events: WorkspaceCommandEvent[]): { text: string; errorRanges: Array<{ start: number; end: number }> } {
  let text = '';
  const errorRanges: Array<{ start: number; end: number }> = [];
  for (const event of events) {
    if (!['stdout', 'stderr', 'error'].includes(event.type)) continue;
    const start = text.length;
    text += event.data ?? '';
    if (event.type !== 'stdout') errorRanges.push({ start, end: text.length });
  }
  return { text, errorRanges };
}
