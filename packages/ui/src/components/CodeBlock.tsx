import { isValidElement, useMemo, useState, type ReactNode } from 'react';
import hljs from 'highlight.js/lib/common';
import { useT } from '../i18n';
import './codeBlock.css';

const COLLAPSE_LINES = 30;
/** Beyond this size highlighting is skipped so one huge block cannot block input. */
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
	const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
	const collapsed = collapsible && (userExpanded ?? true);
	const shown = collapsed ? lines.slice(0, COLLAPSE_LINES).join('\n') : source;
	const resolved = language && hljs.getLanguage(language) ? language : '';
	const html = useMemo(() => {
		if (!resolved || lines.length > HIGHLIGHT_LINE_LIMIT) return escapeHtml(shown);
		try {
			return hljs.highlight(shown, { language: resolved, ignoreIllegals: true }).value;
		} catch {
			return escapeHtml(shown);
		}
	}, [shown, resolved, lines.length]);
	const [copied, setCopied] = useState(false);
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
				<span className="pd-code-block-language">{resolved || t('chat.code.plain')}</span>
				<div className="pd-code-block-actions">
					<button type="button" onClick={() => void copy()}>{t(copied ? 'chat.code.copied' : 'chat.code.copy')}</button>
				</div>
			</div>
			<pre className="pd-code-block-body"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
			{collapsible && (
				<button type="button" className="pd-code-block-toggle" aria-expanded={!collapsed} onClick={() => setUserExpanded(!collapsed)}>
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
