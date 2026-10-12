export interface WordRange { start: number; end: number }
export interface WordDiffRow { text: string; kind: string }
function tokens(text: string) { return [...text.matchAll(/[\p{Script=Han}]|[\p{L}\p{N}_]+|\s+|[^\s]/gu)].map(match => ({ text: match[0], start: match.index!, end: match.index! + match[0].length })); }
/** Bounded token LCS. Large/minified lines keep the existing line-level diff. */
export function changedWords(before: string, after: string): [WordRange[], WordRange[]] {
  if (before.length > 4096 || after.length > 4096) return [[], []];
  const a = tokens(before), b = tokens(after);
  if (a.length > 256 || b.length > 256) return [[], []];
  const width = b.length + 1, table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i * width + j] = a[i]!.text === b[j]!.text ? 1 + table[(i + 1) * width + j + 1]! : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
  const removed: WordRange[] = [], added: WordRange[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i]!.text === b[j]!.text) { i++; j++; }
    else if (i < a.length && (j === b.length || table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) { const token = a[i++]!; removed.push({ start: token.start, end: token.end }); }
    else { const token = b[j++]!; added.push({ start: token.start, end: token.end }); }
  }
  return [removed, added];
}
/** Join ranges separated only by whitespace so one edit reads as one mark. */
function mergeRanges(text: string, ranges: WordRange[]): WordRange[] {
  const merged: WordRange[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && !text.slice(last.end, range.start).trim()) last.end = range.end;
    else merged.push({ ...range });
  }
  return merged;
}
/** Share of a line's visible characters covered by the ranges. */
function changedShare(text: string, ranges: WordRange[]): number {
  const visible = text.replace(/\s/g, '').length;
  if (!visible) return 0;
  return ranges.reduce((sum, range) => sum + text.slice(range.start, range.end).replace(/\s/g, '').length, 0) / visible;
}
/** Word marks only help when most of the line survived; a rewritten line keeps its line-level colour. */
const REWRITE_SHARE = 0.6;
export function diffWordRanges(rows: WordDiffRow[], prefix = 0): Record<number, WordRange[]> {
  const result: Record<number, WordRange[]> = {}; let pairs = 0;
  const removed = (kind: string) => kind === 'removed' || kind === 'deletion';
  const added = (kind: string) => kind === 'added' || kind === 'addition';
  for (let i = 0; i < rows.length && pairs < 200;) {
    if (!removed(rows[i]!.kind)) { i++; continue; }
    const start = i;
    while (i < rows.length && removed(rows[i]!.kind)) i++;
    const middle = i;
    while (i < rows.length && added(rows[i]!.kind)) i++;
    for (let n = 0; n < Math.min(middle - start, i - middle) && pairs < 200; n++, pairs++) {
      const before = rows[start + n]!.text.slice(prefix), after = rows[middle + n]!.text.slice(prefix);
      const [rawOld, rawNew] = changedWords(before, after);
      const oldRanges = mergeRanges(before, rawOld), newRanges = mergeRanges(after, rawNew);
      if (changedShare(before, oldRanges) >= REWRITE_SHARE || changedShare(after, newRanges) >= REWRITE_SHARE) continue;
      result[start + n] = oldRanges.map(range => ({ start: range.start + prefix, end: range.end + prefix }));
      result[middle + n] = newRanges.map(range => ({ start: range.start + prefix, end: range.end + prefix }));
    }
  }
  return result;
}
