import hljs from 'highlight.js/lib/common';
import { readingRows } from './workbenchReading.ts';
import { parsePiEditDiff } from './unifiedDiff.ts';
import { diffWordRanges } from './wordDiff.ts';
import type { ReadingAnalysis, ReadingInput } from './readingWorkerTypes';
const LANGUAGES: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', py: 'python', sh: 'bash', ps1: 'powershell', yml: 'yaml', md: 'markdown', markdown: 'markdown', mdx: 'markdown', h: 'cpp', rs: 'rust', cs: 'csharp' };
/** Retain multiline tokens while making every line an independently valid HTML fragment. */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = []; const stack: string[] = []; let line = '';
  for (const piece of html.split(/(<span\b[^>]*>|<\/span>|\n)/g)) {
    if (piece === '\n') { lines.push(line + '</span>'.repeat(stack.length)); line = stack.join(''); }
    else { line += piece; if (piece.startsWith('<span')) stack.push(piece); else if (piece === '</span>') stack.pop(); }
  }
  lines.push(line + '</span>'.repeat(stack.length)); return lines;
}
const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const fenceLanguage = (info: string) => { const word = info.trim().split(/\s+/)[0]?.toLowerCase() ?? ''; return LANGUAGES[word] ?? word; };
/**
 * highlight.js colors a markdown fence as one flat code span. Fenced bodies are
 * highlighted with their own info-string language instead (when known), and
 * every source line still maps to exactly one HTML fragment.
 *
 * VSCode alignment fixes applied on top of hljs's markdown grammar:
 * - intra-word underscores never open emphasis (CommonMark, e.g. mbeditor_app);
 *   hljs wrongly paints the rest of the line as italic orange otherwise
 * - link text renders green with the URL blue (hljs marks the text as a string)
 * - ~~strikethrough~~, ==highlight== and thematic breaks (---) get their own hues
 */
const INTRA_WORD_UNDERSCORE = /(?<=[A-Za-z0-9])_(?=[A-Za-z0-9])/g;
const UNDERSCORE_PLACEHOLDER = '\u0000';
const RESTORE_UNDERSCORE = (html: string) => html.split(UNDERSCORE_PLACEHOLDER).join('_');
const LINK_TEXT = /\[<span class="hljs-string">([^\]\n]*)<\/span>\]\(<span class="hljs-link">([^)\n]*)<\/span>\)/g;
const STRIKE = /~~(?=\S)(.+?)(?<=\S)~~/g;
const MARK = /==(?=\S)(.+?)(?<=\S)==/g;
const THEMATIC_BREAK = /^ {0,3}((-{3,})|(\*{3,})|(_{3,}))[ \t]*$/;
/**
 * Applies VSCode-alignment passes to one already-highlighted markdown fragment.
 * The underscore placeholder survives the escape+highlight round trip, so
 * restoration is exact and no escaped entity ever gets rewritten.
 *
 * LINK_TEXT only matches hljs's own string/link wrapping — plain-text brackets
 * stay untouched, and the captured groups are already escaped inner text.
 */
function refineMarkdownHtml(html: string): string {
  return RESTORE_UNDERSCORE(html)
    .replace(LINK_TEXT, '<span class="hljs-symbol">[$1]</span>(<span class="hljs-link">$2</span>)')
    .replace(STRIKE, '<span class="pd-md-strike">~~$1~~</span>')
    .replace(MARK, '<span class="pd-md-mark">==$1==</span>');
}
export function highlightMarkdownLines(text: string): string[] {
  const source = text.split('\n').map(line => line.replace(/\r$/, ''));
  const lines: string[] = [];
  let prose: string[] = [];
  const flushProse = () => {
    if (!prose.length) return;
    lines.push(...splitHighlightedLines(refineMarkdownHtml(hljs.highlight(prose.join('\n').replace(INTRA_WORD_UNDERSCORE, UNDERSCORE_PLACEHOLDER), { language: 'markdown', ignoreIllegals: true }).value)));
    prose = [];
  };
  for (let index = 0; index < source.length; index++) {
    const line = source[index]!;
    if (THEMATIC_BREAK.test(line)) {
      flushProse();
      lines.push(`<span class="pd-md-break">${escapeHtml(line)}</span>`);
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    // A backtick fence's info string may not contain backticks (CommonMark).
    if (!open || (open[1]!.startsWith('`') && open[2]!.includes('`'))) { prose.push(line); continue; }
    flushProse();
    const marker = open[1]!;
    const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`);
    let end = index + 1;
    while (end < source.length && !close.test(source[end]!)) end++;
    const body = source.slice(index + 1, end);
    const language = fenceLanguage(open[2]!);
    lines.push(`<span class="hljs-code pd-md-fence-marker">${escapeHtml(line)}</span>`);
    if (body.length) {
      const code = body.join('\n');
      const highlighted = language && hljs.getLanguage(language) ? hljs.highlight(code, { language, ignoreIllegals: true }).value : `<span class="hljs-code">${escapeHtml(code)}</span>`;
      lines.push(...splitHighlightedLines(`<span class="pd-md-fence">${highlighted}</span>`));
    }
    if (end < source.length) lines.push(`<span class="hljs-code pd-md-fence-marker">${escapeHtml(source[end]!)}</span>`);
    index = end;
  }
  flushProse();
  return lines;
}
export function analyzeReading(input: ReadingInput): ReadingAnalysis {
  const { text, path, mode } = input;
  if (text.length > 1_000_000) return { html: [], words: {} };
  const extension = path.split('.').at(-1)?.toLowerCase() ?? '';
  const language = LANGUAGES[extension] ?? extension;
  const rows = mode === 'edit' ? parsePiEditDiff(text) : readingRows(text, mode === 'diff');
  const words = mode === 'text' ? {} : diffWordRanges(rows, mode === 'diff' ? 1 : 0);
  let html: string[] = [];
  if (text.length <= 300_000 && rows.length <= 10_000 && hljs.getLanguage(language)) {
    if (mode === 'text' && language === 'markdown') html = highlightMarkdownLines(text);
    else if (mode === 'text') html = splitHighlightedLines(hljs.highlight(text, { language, ignoreIllegals: true }).value);
    else html = rows.map(row => row.text.length > 4096 ? '' : hljs.highlight(row.text, { language, ignoreIllegals: true }).value);
  }
  return { html, words };
}
