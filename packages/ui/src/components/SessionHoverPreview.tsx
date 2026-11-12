import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { UiSessionPreview } from '@pidesktop/shared';
import type { SidebarSession } from '../sidebarOrganization';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { firstSummaryLine, loadSessionPreview, sessionPreviewCache, sessionPreviewCacheKey } from '../sessionPreview';
import { HoverTooltip } from './HoverTooltip';

/** Pointer hints wait briefly, so swiping across the list never loads summaries. */
export const SESSION_PREVIEW_OPEN_DELAY_MS = 300;

/**
 * Hover card for one sidebar session row: the title plus lazily loaded summary
 * lines (the last user and last assistant message of the viewed branch). The
 * first actual hover triggers a single cached read through the search index;
 * the visible conversation is summarized straight from memory. Any failure
 * degrades silently to the title-only hint — no error, no spinner, no flash.
 */
export function SessionHoverPreview({ session, title, row }: { session: SidebarSession; title: string; row: ReactElement }) {
	const { t } = useT();
	const bridge = useChatStore((s) => s.bridge);
	// Derived string selector (like hasUserMessage above): streaming updates
	// re-render this row only when the summarized lines themselves change.
	const inlineSummary = useChatStore((s) => {
		if (session.workspace !== s.cwd || session.path !== s.sessionPath) return '';
		let lastUser = '', lastAssistant = '';
		for (let index = s.messages.length - 1; index >= 0; index -= 1) {
			const message = s.messages[index]!;
			if (!lastUser && message.role === 'user') lastUser = firstSummaryLine(message.text);
			else if (!lastAssistant && message.role === 'assistant') lastAssistant = firstSummaryLine(message.text);
			if (lastUser && lastAssistant) break;
		}
		return JSON.stringify([lastUser, lastAssistant]);
	});
	const key = sessionPreviewCacheKey(session.path, session.modified);
	const [fetched, setFetched] = useState<UiSessionPreview | null>(() => sessionPreviewCache.peek(key) ?? null);
	const requested = useRef(false);
	// A new revision (the conversation changed) starts a fresh lazy cycle.
	useEffect(() => { setFetched(sessionPreviewCache.peek(key) ?? null); requested.current = false; }, [key]);
	const open = useCallback(() => {
		if (requested.current) return;
		requested.current = true;
		void loadSessionPreview(bridge, session.workspace, session.path, session.modified).then((value) => { if (value) setFetched(value); });
	}, [bridge, session.workspace, session.path, session.modified]);
	const [lastUser, lastAssistant] = JSON.parse(inlineSummary || '["",""]') as [string, string];
	const summary: UiSessionPreview | null = inlineSummary ? { ...(lastUser ? { lastUser } : {}), ...(lastAssistant ? { lastAssistant } : {}) } : fetched;
	const description = summary?.lastUser || summary?.lastAssistant ? (
		<div className="pd-session-preview">
			{summary?.lastUser && <p className="pd-session-preview-line"><span className="pd-session-preview-role">{t('sidebar.previewUser')}</span><span className="pd-session-preview-text">{summary.lastUser}</span></p>}
			{summary?.lastAssistant && <p className="pd-session-preview-line"><span className="pd-session-preview-role">{t('sidebar.previewAssistant')}</span><span className="pd-session-preview-text">{summary.lastAssistant}</span></p>}
		</div>
	) : undefined;
	return <HoverTooltip title={title} description={description} side="right" interactive={false} openDelayMs={SESSION_PREVIEW_OPEN_DELAY_MS} onOpen={open}>{row}</HoverTooltip>;
}
