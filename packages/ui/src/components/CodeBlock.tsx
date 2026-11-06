import { isValidElement, useContext, useMemo, useState, type ReactNode } from 'react';
import { TranscriptSearchContext } from '../transcriptSearch';
import { useHighlighter } from '../codeHighlighter';
import { useWorkerHighlight, WORKER_HIGHLIGHT_LINE_LIMIT } from '../codeHighlightWorkerPool';
import { StreamingContentContext } from '../streamingContent';
import { useT } from '../i18n';
import { MermaidDiagram } from './MermaidDiagram';
import { useCodeWrap } from '../codeWrapPreference';
import './codeBlock.css';

const COLLAPSE_LINES = 30;
/** Beyond this size synchronous highlighting is skipped so one huge block cannot block input. */
const HIGHLIGHT_LINE_LIMIT = 2000;

function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Fenced code block with a language label, copy action and long-block folding. */
export function CodeBlock({ code, language }: { code: string; language?: string }) {
	const { t, locale } = useT();
	const source = useMemo(() => code.replace(/\n$/, ''), [code]);
	const lines = useMemo(() => source.split('\n'), [source]);
	const collapsible = lines.length > COLLAPSE_LINES;
	const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null);
	const findQuery = useContext(TranscriptSearchContext).trim().toLocaleLowerCase();
	const collapsed = collapsible && (userCollapsed ?? true) && !(findQuery && source.toLocaleLowerCase().includes(findQuery));
	const shown = collapsed ? lines.slice(0, COLLAPSE_LINES).join('\n') : source;
	const isMermaid = (language ?? '').trim().toLowerCase() === 'mermaid';
	const streaming = useContext(StreamingContentContext);
	// Plain text first: the highlighter chunk loads on demand (codeHighlighter.ts).
	const hljs = useHighlighter(Boolean(language) && !isMermaid && lines.length <= HIGHLIGHT_LINE_LIMIT);
	const trimmedLanguage = (language ?? '').trim();
	const resolved = trimmedLanguage && hljs?.getLanguage(trimmedLanguage) ? trimmedLanguage : '';
	// Over-limit blocks highlight in a worker — but only once the message stopped
	// streaming; re-highlighting every streamed token would flicker.
	const workerHtml = useWorkerHighlight(shown, trimmedLanguage, !streaming && Boolean(language) && !isMermaid && lines.length > HIGHLIGHT_LINE_LIMIT && lines.length <= WORKER_HIGHLIGHT_LINE_LIMIT);
	const html = useMemo(() => {
		if (!hljs || !resolved || lines.length > HIGHLIGHT_LINE_LIMIT) {
			// Worker markup wraps the same text in spans, so replacing the escaped
			// plain text never changes line heights; '' keeps the plain rendering.
			return lines.length > HIGHLIGHT_LINE_LIMIT ? workerHtml || escapeHtml(shown) : escapeHtml(shown);
		}
		try {
			return hljs.highlight(shown, { language: resolved, ignoreIllegals: true }).value;
		} catch {
			return escapeHtml(shown);
		}
	}, [hljs, shown, resolved, lines.length, workerHtml]);
	const [copied, setCopied] = useState(false);
	const [wrap, setWrap] = useCodeWrap();
	const [view, setView] = useState<'chart' | 'source'>('chart');
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(source);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1200);
		} catch {
			// Clipboard refusal is non-fatal; the code stays selectable as text.
		}
	};
	return (
		<div className="pd-code-block">
			<div className="pd-code-block-header">
				<span className="pd-code-block-language">{isMermaid ? 'Mermaid' : resolved || (!hljs && language?.trim()) || t('chat.code.plain')}</span>
				<div className="pd-code-block-actions">
					{isMermaid && <button type="button" aria-pressed={view === 'source'} onClick={() => setView(current => current === 'chart' ? 'source' : 'chart')}>{t(view === 'chart' ? 'chat.diagram.showSource' : 'chat.diagram.showChart')}</button>}
					{(!isMermaid || view === 'source') && <button type="button" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>{t(wrap ? 'chat.code.noWrap' : 'chat.code.wrap')}</button>}
					<button type="button" onClick={() => void copy()}>{t(copied ? 'chat.code.copied' : 'chat.code.copy')}</button>
				</div>
			</div>
			{isMermaid && view === 'chart' ? <div className="pd-mermaid-body"><MermaidDiagram source={source} /></div> : <pre className={`pd-code-block-body${wrap ? ' is-wrapped' : ''}`}><code dangerouslySetInnerHTML={{ __html: html }} /></pre>}
			{collapsible && (!isMermaid || view === 'source') && (
				<button type="button" className="pd-code-block-toggle" aria-expanded={!collapsed} onClick={() => setUserCollapsed(!collapsed)}>
					{collapsed ? t('chat.code.expand', { count: lines.length.toLocaleString(locale) }) : t('chat.code.collapse')}
				</button>
			)}
		</div>
	);
}

/** Extract fenced-block source from react-markdown's `<pre>` children. */
export function extractCodeBlock(children: ReactNode): { code: string; language?: string } | null {
	const child = Array.isArray(children) ? children.find((item) => isValidElement(item)) : children;
	if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return null;
	const className = child.props.className ?? '';
	const language = /language-([^\s]+)/.exec(className)?.[1];
	const text = child.props.children;
	if (typeof text !== 'string') return null;
	return { code: text, language };
}

/** Shared react-markdown renderer: fenced blocks become CodeBlock, inline stays. */
export function renderMarkdownPre({ children }: { children?: ReactNode }): ReactNode {
	const block = extractCodeBlock(children);
	return block ? <CodeBlock code={block.code} language={block.language} /> : <pre>{children}</pre>;
}
