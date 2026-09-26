import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import hljs from 'highlight.js/lib/common';
import { useT } from '../i18n';
import { literalMatches, readingRows } from '../workbenchReading';

const LANGUAGES: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', py: 'python', sh: 'bash', ps1: 'powershell', yml: 'yaml', md: 'markdown', h: 'cpp', rs: 'rust', cs: 'csharp' };

/** The copy action always uses the original text; line numbers and marks are presentation only. */
export function WorkbenchTextView({ text, path = '', diff = false, command = false, omitted = false, errorRanges = [], onClear }: { text: string; path?: string; diff?: boolean; command?: boolean; omitted?: boolean; errorRanges?: Array<{ start: number; end: number }>; onClear?(): void }) {
  const { locale } = useT();
  const label = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  const [query, setQuery] = useState('');
  const [match, setMatch] = useState(0);
  const [limit, setLimit] = useState(2000);
  const [notice, setNotice] = useState('');
  const [following, setFollowing] = useState(true);
  const body = useRef<HTMLDivElement>(null);
  const find = useRef<HTMLInputElement>(null);
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
  const extension = path.split('.').at(-1)?.toLowerCase() ?? '';
  const language = LANGUAGES[extension] ?? extension;
  useEffect(() => { setMatch(0); }, [query]);
  useLayoutEffect(() => {
    if (active) body.current?.querySelector('[data-current-match]')?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [active?.start, active?.end]);
  useLayoutEffect(() => {
    if (command && following && !query && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [text, following, command, query]);
  const move = (delta: number) => { setFollowing(false); setMatch((index + delta + matches.length) % Math.max(1, matches.length)); };
  const copy = async () => { try { await navigator.clipboard.writeText(text); setNotice(label('已复制', 'Copied')); } catch { setNotice(label('复制失败，请选择文本复制', 'Copy failed; select the text to copy')); } };
  function content(row: typeof rows[number]): ReactNode {
    if (query) {
      const ranges = matchesByRow.get(row.offset) ?? [];
      const parts: ReactNode[] = []; let offset = 0;
      for (const range of ranges) {
        const start = Math.max(0, range.start - row.offset), end = Math.min(row.text.length, range.end - row.offset);
        parts.push(row.text.slice(offset, start), <mark key={range.start} data-current-match={range === active || undefined}>{row.text.slice(start, end)}</mark>); offset = end;
      }
      parts.push(row.text.slice(offset)); return parts;
    }
    if (!diff && !command && text.length <= 100_000 && hljs.getLanguage(language)) {
      try { return <span dangerouslySetInnerHTML={{ __html: hljs.highlight(row.text, { language, ignoreIllegals: true }).value }} />; } catch { /* Plain text remains readable. */ }
    }
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
    <div ref={body} className="pd-workbench-reader-body" tabIndex={0} aria-label={label('文本内容', 'Text content')} onScroll={() => { const element = body.current; if (command && element) setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 24); }}>
      <div className="pd-workbench-reader-lines">{rows.slice(0, command ? rows.length : shown).map((row, i) => <div key={i} className={`pd-workbench-code-line is-${row.kind}${errorRanges.some(range => range.start < row.offset + row.text.length && range.end > row.offset) ? ' is-stderr' : ''}`}>
        {diff && <span className="pd-workbench-line-number" aria-hidden="true">{row.oldLine}</span>}<span className="pd-workbench-line-number" aria-hidden="true">{row.newLine}</span><code>{content(row)}</code>
      </div>)}</div>
      {!command && shown < rows.length && <button type="button" className="pd-workbench-show-lines" onClick={() => setLimit(value => value + 2000)}>{label('继续显示后续行', 'Show more lines')} ({Math.min(shown, rows.length)}/{rows.length})</button>}
    </div>
  </div>;
}
