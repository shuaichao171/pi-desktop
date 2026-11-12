import { useEffect, useRef } from 'react';
import { useT } from '../i18n';
import { Icon } from './Icons';

/**
 * In-conversation find bar (Ctrl+F): counts matches across visible messages,
 * steps through them with Enter/Shift+Enter and returns focus on Escape.
 */
export function TranscriptFind({ query, onQueryChange, index, total, onStep, onClose, loadedMessages, hasOlder = false, loadingOlder = false, onLoadOlder, focusRequest, scope = 'conversation', onScopeChange, hasChanges = false, changesSummary }: {
	query: string;
	onQueryChange(query: string): void;
	/** Zero-based active match; null when there is no active match. */
	index: number | null;
	total: number;
	onStep(delta: 1 | -1): void;
	onClose(): void;
	loadedMessages?: number;
	hasOlder?: boolean;
	loadingOlder?: boolean;
	onLoadOlder?(): void;
	/** Increments on every Ctrl+F; a rising edge re-focuses and re-selects the input (bar already open). */
	focusRequest?: number;
	/** Find scope: visible conversation text or recorded file changes (12). */
	scope?: 'conversation' | 'changes';
	onScopeChange?(scope: 'conversation' | 'changes'): void;
	/** Whether any conversation change carries a diff worth searching. */
	hasChanges?: boolean;
	/** Match summary for the changes scope: files with hits and total hits. */
	changesSummary?: { files: number; total: number } | null;
}) {
	const { t } = useT();
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		inputRef.current?.focus();
		inputRef.current?.select();
	}, []);
	useEffect(() => {
		if (!focusRequest) return;
		inputRef.current?.focus();
		inputRef.current?.select();
	}, [focusRequest]);
	const count = scope === 'changes'
		? query.trim()
			? (changesSummary && changesSummary.total > 0
				? t('chat.find.changesCount', { files: String(changesSummary.files), total: String(changesSummary.total) })
				: t('chat.find.noResults'))
			: t('chat.find.changesHint')
		: query.trim()
			? (total > 0 && index != null ? t('chat.find.count', { current: String(index + 1), total: String(total) }) : t('chat.find.noResults'))
			: t('chat.find.hint');
	return (
		<div className="pd-transcript-find" role="search">
			<Icon name="search" width="14" height="14" />
			<input
				ref={inputRef}
				className="pd-transcript-find-input"
				type="text"
				value={query}
				placeholder={t('chat.find.placeholder')}
				aria-label={t('chat.find.label')}
				onChange={(event) => onQueryChange(event.target.value)}
				onKeyDown={(event) => {
					if (event.nativeEvent.isComposing) return;
					if (event.key === 'Enter') { event.preventDefault(); onStep(event.shiftKey ? -1 : 1); }
					else if (event.key === 'Escape') { event.preventDefault(); onClose(); }
				}}
			/>
			{onScopeChange && hasChanges && <span className="pd-transcript-find-scopes" role="group" aria-label={t('chat.find.scopeLabel')}>
				<button type="button" className={scope === 'conversation' ? 'is-active' : ''} aria-pressed={scope === 'conversation'} onClick={() => onScopeChange('conversation')}>{t('chat.find.scopeConversation')}</button>
				<button type="button" className={scope === 'changes' ? 'is-active' : ''} aria-pressed={scope === 'changes'} onClick={() => onScopeChange('changes')}>{t('chat.find.scopeChanges')}</button>
			</span>}
			<span className={'pd-transcript-find-count' + (query.trim() && (scope === 'changes' ? !changesSummary || changesSummary.total === 0 : total === 0) ? ' is-empty' : '')} aria-live="polite">{count}</span>
			<button type="button" className="pd-transcript-find-step" onClick={() => onStep(-1)} disabled={scope === 'changes' ? !changesSummary || changesSummary.total === 0 : total === 0} aria-label={t('chat.find.previous')}><Icon name="chevronUp" width="14" height="14" /></button>
			<button type="button" className="pd-transcript-find-step" onClick={() => onStep(1)} disabled={scope === 'changes' ? !changesSummary || changesSummary.total === 0 : total === 0} aria-label={t('chat.find.next')}><Icon name="chevronDown" width="14" height="14" /></button>
			<button type="button" className="pd-transcript-find-close" onClick={onClose} aria-label={t('chat.find.close')}><Icon name="close" width="14" height="14" /></button>
			{hasOlder && <div className="pd-transcript-find-scope" role="status">
				<span>{t('chat.find.loadedOnly', { count: String(loadedMessages ?? 0) })}</span>
				{onLoadOlder && <button type="button" className="pd-transcript-find-load" disabled={loadingOlder} onClick={onLoadOlder}>{t(loadingOlder ? 'chat.loadingOlder' : 'chat.find.loadOlder')}</button>}
			</div>}
		</div>
	);
}
