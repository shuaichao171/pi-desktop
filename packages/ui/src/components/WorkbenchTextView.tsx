import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { literalMatches, readingRows } from '../workbenchReading';

import { useReadingAnalysis } from '../useReadingAnalysis';
import { WordDiffText } from './WordDiffText';

/** Whole selected lines with their numbers, for "add to chat" (ZCode code comments). */
export interface TextViewQuote { text: string; startLine?: number; endLine?: number }

/** The copy action always uses the original text; line numbers and marks are presentation only. */
export function WorkbenchTextView({ text, path = '', diff = false, command = false, omitted = false, errorRanges = [], onClear, onQuote, onTopLineChange }: { text: string; path?: string; diff?: boolean; command?: boolean; omitted?: boolean; errorRanges?: Array<{ start: number; end: number }>; onClear?(): void; onQuote?(quote: TextViewQuote): void; onTopLineChange?(line: number): void }) {
  const { locale } = useT();
  const label = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  const [query, setQuery] = useState('');
  const [match, setMatch] = useState(0);
  const [limit, setLimit] = useState(400);
  const [notice, setNotice] = useState('');
  const [following, setFollowing] = useState(true);
  const body = useRef<HTMLDivElement>(null);
  const find = useRef<HTMLInputElement>(null);
  // zcode code-viewer line anchor: report the first visible logical line
  // (diff rows report the new-file line, falling back to the old line) so
  // "open in editor" can land where the user is reading. rAF-throttled.
  const topFrame = useRef<number | null>(null);
  const reportTopLine = () => {
    const element = body.current;
    if (!element || !onTopLineChange) return;
    // Viewport-relative rects are immune to the offsetParent chain: the reader
    // body is not positioned, so offsetTop would resolve against the page.
    const containerTop = element.getBoundingClientRect().top;
    const lines = element.querySelectorAll<HTMLElement>('[data-row]');
    let index: number | null = null;
    for (const line of lines) {
      if (line.getBoundingClientRect().bottom > containerTop + 2) { index = Number(line.dataset.row); break; }
    }
    const row = rows[index ?? Math.max(0, lines.length - 1)];
    const logical = row?.newLine ?? row?.oldLine;
    if (typeof logical === 'number') onTopLineChange(logical);
  };
  const scheduleTopLine = () => {
    if (topFrame.current !== null) return;
    topFrame.current = requestAnimationFrame(() => { topFrame.current = null; reportTopLine(); });
  };
  useEffect(() => () => { if (topFrame.current !== null) cancelAnimationFrame(topFrame.current); }, []);
  const rows = useMemo(() => readingRows(text, diff), [text, diff]);
  const matches = useMemo(() => literalMatches(text, query), [text, query]);
  const matchesByRow = useMemo(() => {
    const result = new Map<number, typeof matches>(); let cursor = 0;
    for (const row of rows) {
      while (matches[cursor] && matches[cursor]!.end <= row.offset) cursor++;
      const ranges: typeof matches = [];
      for (let i = cursor; matches[i] && matches[i]!.start < row.offset + row.text.length; i++) ranges.push(matches[i]!);
      if (ranges.length) result.set(row.offset, ranges);
    }
    return result;
  }, [rows, matches]);
  const index = matches.length ? Math.min(match, matches.length - 1) : 0;
  const active = matches[index];
  const activeRow = active ? rows.findIndex((row, i) => row.offset <= active.start && (rows[i + 1]?.offset ?? Infinity) > active.start) : -1;
  const shown = Math.max(limit, activeRow + 1);
  const analysis = useReadingAnalysis(text, path, diff ? 'diff' : 'text', !command);
  useEffect(() => { setLimit(400); setMatch(0); }, [path, diff]);
  useEffect(() => { setMatch(0); }, [query]);
  useLayoutEffect(() => {
    if (active) body.current?.querySelector('[data-current-match]')?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [active?.start, active?.end]);
  useLayoutEffect(() => {
    if (command && following && !query && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [text, following, command, query]);
  useLayoutEffect(() => { if (onTopLineChange) scheduleTopLine(); }, [rows, shown, onTopLineChange]);
  // Selecting code offers "Add to chat" with the selected rows (always whole lines).
  const [selectedRows, setSelectedRows] = useState<{ start: number; end: number; left: number; top: number } | null>(null);
  const inspectSelection = () => {
    const element = body.current;
    const selection = window.getSelection();
    if (!onQuote || !element || !selection || selection.isCollapsed || !selection.rangeCount) { setSelectedRows(null); return; }
    const range = selection.getRangeAt(0);
    if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) { setSelectedRows(null); return; }
    const rowOf = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('[data-row]');
    const first = rowOf(range.startContainer), last = rowOf(range.endContainer);
    if (!first || !last) { setSelectedRows(null); return; }
    let start = Number(first.dataset.row), end = Number(last.dataset.row);
    // A triple-click selection ends at offset 0 of the following row.
    if (end > start) {
      const probe = document.createRange();
      probe.setStart(last, 0);
      probe.setEnd(range.endContainer, range.endOffset);
      if (!probe.toString()) end -= 1;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) { setSelectedRows(null); return; }
    if (start > end) [start, end] = [end, start];
    const box = range.getBoundingClientRect();
    setSelectedRows({ start, end, left: Math.max(8, Math.min(box.left, window.innerWidth - 160)), top: Math.max(8, Math.min(box.bottom + 6, window.innerHeight - 44)) });
  };
  useEffect(() => {
    if (!onQuote) return;
    const clear = () => setSelectedRows(null);
    document.addEventListener('selectionchange', inspectSelection);
    window.addEventListener('scroll', clear, true);
    return () => { document.removeEventListener('selectionchange', inspectSelection); window.removeEventListener('scroll', clear, true); };
  });
  const quoteSelection = () => {
    if (!onQuote || !selectedRows) return;
    const picked = rows.slice(selectedRows.start, selectedRows.end + 1);
    const numbers = picked.map(row => row.newLine ?? row.oldLine).filter((line): line is number => typeof line === 'number');
    onQuote({ text: picked.map(row => row.text).join('\n'), startLine: numbers[0], endLine: numbers.at(-1) });
    window.getSelection()?.removeAllRanges();
    setSelectedRows(null);
  };
  const move = (delta: number) => { setFollowing(false); setMatch((index + delta + matches.length) % Math.max(1, matches.length)); };
  const copy = async () => { try { await navigator.clipboard.writeText(text); setNotice(label('已复制', 'Copied')); } catch { setNotice(label('复制失败，请选择文本复制', 'Copy failed; select the text to copy')); } };
  function content(row: typeof rows[number], index: number): ReactNode {
    if (query) {
      const ranges = matchesByRow.get(row.offset) ?? [];
      const parts: ReactNode[] = []; let offset = 0;
      for (const range of ranges) {
        const start = Math.max(0, range.start - row.offset), end = Math.min(row.text.length, range.end - row.offset);
        parts.push(row.text.slice(offset, start), <mark key={range.start} data-current-match={range === active || undefined}>{row.text.slice(start, end)}</mark>); offset = end;
      }
      parts.push(row.text.slice(offset)); return parts;
    }
    const words = analysis.words[index];
    if (words?.length) return <WordDiffText text={row.text} ranges={words} />;
    if (analysis.html[index]) return <span dangerouslySetInnerHTML={{ __html: analysis.html[index] }} />;
    return row.text || '\u200b';
  }
  return <div className={`pd-workbench-reader${command ? ' is-command' : ''}`} onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); find.current?.focus(); }
  }}>
    <div className="pd-workbench-reader-tools">
      <input ref={find} type="search" aria-label={label('查找内容', 'Find in content')} placeholder={label('查找', 'Find')} value={query} onChange={event => { setQuery(event.target.value); setFollowing(false); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); move(event.shiftKey ? -1 : 1); } }} />
      <span role="status">{matches.length ? `${index + 1}/${matches.length}` : query ? '0/0' : ''}</span>
      <button type="button" disabled={!matches.length} aria-label={label('上一处', 'Previous match')} onClick={() => move(-1)}>↑</button><button type="button" disabled={!matches.length} aria-label={label('下一处', 'Next match')} onClick={() => move(1)}>↓</button>
      <button type="button" onClick={() => void copy()}>{label('复制原文', 'Copy raw')}</button>
      {onClear && <button type="button" onClick={onClear}>{label('清空显示', 'Clear display')}</button>}
      {command && <button type="button" aria-pressed={following} onClick={() => { setQuery(''); setLimit(rows.length); setFollowing(true); }}>{label('回到底部', 'Follow output')}</button>}
    </div>
    {(omitted || diff && /… (?:仅显示|输出已截断)|Diff preview limited|Output truncated/.test(text)) && <p className="pd-workbench-reader-notice" role="status">{label('较早输出或超限内容已省略；当前预览并非完整内容。', 'Earlier output or content beyond the limit was omitted; this preview is incomplete.')}</p>}
    {notice && <p className="pd-workbench-reader-notice" role="status">{notice}</p>}
    <div ref={body} className="pd-workbench-reader-body" tabIndex={0} aria-label={label('文本内容', 'Text content')} onScroll={() => { const element = body.current; if (command && element) setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 24); scheduleTopLine(); }}>
      <div className="pd-workbench-reader-lines">{rows.slice(0, command ? rows.length : shown).map((row, i) => <div key={i} data-row={i} className={`pd-workbench-code-line is-${row.kind}${errorRanges.some(range => range.start < row.offset + row.text.length && range.end > row.offset) ? ' is-stderr' : ''}`}>
        {diff && <span className="pd-workbench-line-number" aria-hidden="true">{row.oldLine}</span>}<span className="pd-workbench-line-number" aria-hidden="true">{row.newLine}</span><code>{content(row, i)}</code>
      </div>)}</div>
      {selectedRows && onQuote && createPortal(<button type="button" className="pd-quote-selection" style={{ position: 'fixed', zIndex: 'var(--pd-z-selection-action)', left: selectedRows.left, top: selectedRows.top }} onMouseDown={event => event.preventDefault()} onClick={quoteSelection}>{label('添加到对话', 'Add to chat')}</button>, document.body)}
      {!command && shown < rows.length && <button type="button" className="pd-workbench-show-lines" onClick={() => setLimit(value => value + 400)}>{label('继续显示后续行', 'Show more lines')} ({Math.min(shown, rows.length)}/{rows.length})</button>}
    </div>
  </div>;
}
