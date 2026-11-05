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

/**
 * Match core over plain paths and raw diff text. Runs on the render thread and
 * inside the diff worker, so both sides always count identically.
 */
export function findPathMatches(paths: readonly string[], query: string, diffs: ReadonlyMap<string, string> | null): ChangeFindResult {
  const trimmed = query.trim();
  if (!trimmed) return { files: [], total: 0 };
  const files: ChangeFindFile[] = [];
  let total = 0;
  for (const path of paths) {
    // Binary/too-large changes carry no readable diff; their path still counts.
    const haystack = `${path}\n${diffs?.get(path) ?? ''}`;
    const count = countOccurrences(haystack, trimmed);
    if (count > 0) {
      files.push({ path, count });
      total += count;
    }
  }
  return { files, total };
}

export function findChangeMatches(changes: readonly UiFileChange[], query: string, diffs: ReadonlyMap<string, UiFileDiff> | null): ChangeFindResult {
  if (!query.trim()) return { files: [], total: 0 };
  const diffTexts = diffs ? new Map([...diffs].map(([path, diff]) => [path, diff.diff ?? ''])) : null;
  return findPathMatches(changes.map((change) => change.path), query, diffTexts);
}
