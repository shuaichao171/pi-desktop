import type { UiFileChange, UiFileDiff } from '@pidesktop/shared';

/**
 * "Changes" find scope for the transcript find bar (zcode TaskFindDialog):
 * the query matches inside each file's lazily loaded diff plus its path, and
 * the caller steps file-by-file, opening the review dialog on the active file.
 * Diffs load on demand from the agent; until the map arrives only paths match.
 */

export interface ChangeFindFile {
  path: string;
  /** Match count within this file's diff and path text. */
  count: number;
}

export interface ChangeFindResult {
  files: ChangeFindFile[];
  total: number;
}

/** Literal case-insensitive matching, consistent with transcriptSearch. */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  const lowered = haystack.toLocaleLowerCase();
  const target = needle.toLocaleLowerCase();
  while ((offset = lowered.indexOf(target, offset)) !== -1) {
    count += 1;
    offset += target.length;
  }
  return count;
}

export function findChangeMatches(changes: readonly UiFileChange[], query: string, diffs: ReadonlyMap<string, UiFileDiff> | null): ChangeFindResult {
  const trimmed = query.trim();
  if (!trimmed) return { files: [], total: 0 };
  const files: ChangeFindFile[] = [];
  let total = 0;
  for (const change of changes) {
    // Binary/too-large changes carry no readable diff; their path still counts.
    const haystack = `${change.path}\n${diffs?.get(change.path)?.diff ?? ''}`;
    const count = countOccurrences(haystack, trimmed);
    if (count > 0) {
      files.push({ path: change.path, count });
      total += count;
    }
  }
  return { files, total };
}
