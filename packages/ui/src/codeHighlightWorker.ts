import hljs from 'highlight.js/lib/common';

/**
 * Worker-side twin of the synchronous highlight in CodeBlock: same
 * highlight.js build, same options, so both paths emit identical markup. An
 * unknown language or a highlight failure answers with '' — the caller keeps
 * its escaped plain text, never a broken half-highlighted block.
 */
export function workerHighlight(source: string, language: string): string {
	if (!hljs.getLanguage(language)) return '';
	try { return hljs.highlight(source, { language, ignoreIllegals: true }).value; }
	catch { return ''; }
}
