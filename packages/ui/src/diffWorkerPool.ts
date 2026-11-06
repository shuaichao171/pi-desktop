import { findPathMatches, type ChangeFindResult } from './changesFind.ts';
import { parsePiEditDiff, parseUnifiedDiff } from './unifiedDiff.ts';
import type { DiffRequest, DiffResponse } from './diffWorkerTypes.ts';
import { literalMatchRanges } from './workbenchReading.ts';
import { createWorkerTaskPool, type WorkerTaskPool } from './workerTaskPool.ts';

/**
 * Diffs up to this many characters parse synchronously: parsing costs ~1-2 ms
 * here, so a worker round trip would only add a loading flash. Larger review
 * and edit diffs parse off the render thread so one huge diff cannot block
 * input while the changes dialog or a tool card opens.
 */
export const DIFF_PARSE_CHAR_LIMIT = 200_000;

/**
 * Changes-find recomputes on every keystroke and scans every lazily loaded
 * diff (lowercasing each haystack). Past this much total diff text that scan
 * moves into the diff worker so typing in the find bar stays responsive.
 */
export const CHANGES_FIND_CHAR_LIMIT = 400_000;

/**
 * Workbench text-preview find runs on every keystroke over up to 1 MB (the
 * preview cap). Below this size the scan costs a few ms and stays synchronous;
 * above it a one-letter query costs ~20 ms on the render thread (2026-11-06
 * microbenchmark: 1 MB, 113k matches ≈ 19 ms), so it moves to the worker.
 */
export const READING_FIND_CHAR_LIMIT = 200_000;

// A failed, timed-out or unsupported worker falls back to the same pure
// functions on the main thread, so callers always get the exact same result.
const local = (request: DiffRequest): DiffResponse => {
  if (request.type === 'unified') return { type: 'unified', lines: parseUnifiedDiff(request.text) };
  if (request.type === 'pi-edit') return { type: 'pi-edit', lines: parsePiEditDiff(request.text) };
  if (request.type === 'reading-find') return { type: 'reading-find', ranges: literalMatchRanges(request.text, request.query) };
  return { type: 'changes-find', result: findPathMatches(request.paths, request.query, new Map(request.diffTexts)) };
};

const pool: WorkerTaskPool<DiffRequest, DiffResponse> = createWorkerTaskPool({
  create: () => new Worker(new URL('./diff.worker.ts', import.meta.url), { type: 'module' }),
  fallback: local,
  timeoutMs: 10_000,
});

/** Parses one diff in the worker; the fallback path answers synchronously. */
export function requestDiffParse(request: Extract<DiffRequest, { type: 'unified' | 'pi-edit' }>, done: (response: DiffResponse) => void): () => void {
  if (typeof Worker === 'undefined') { done(local(request)); return () => {}; }
  return pool.request(request, done);
}

/** Scans the conversation's diffs in the worker; the fallback path answers synchronously. */
export function requestChangesFind(request: Extract<DiffRequest, { type: 'changes-find' }>, done: (result: ChangeFindResult) => void): () => void {
  const deliver = (response: DiffResponse) => { if (response.type === 'changes-find') done(response.result); };
  if (typeof Worker === 'undefined') { deliver(local(request)); return () => {}; }
  return pool.request(request, deliver);
}

/** Finds a literal query in a large text preview in the worker; the fallback path answers synchronously. */
export function requestReadingFind(request: Extract<DiffRequest, { type: 'reading-find' }>, done: (ranges: Int32Array) => void): () => void {
  const deliver = (response: DiffResponse) => { if (response.type === 'reading-find') done(response.ranges); };
  if (typeof Worker === 'undefined') { deliver(local(request)); return () => {}; }
  return pool.request(request, deliver);
}
