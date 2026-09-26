import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { UiSessionStats } from '@pidesktop/shared';
import { useT } from '../i18n';
import { useChatStore } from '../store';
import { Icon } from './Icons';

function formatTokens(value: number, locale: string): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toLocaleString(locale, { maximumFractionDigits: 2 })}M`;
	if (value >= 1_000) return `${(value / 1_000).toLocaleString(locale, { maximumFractionDigits: 1 })}K`;
	return value.toLocaleString(locale);
}

/** Aggregate session usage (Pi /session parity) behind the chat title menu. */
export function SessionInfoPanel({ returnFocus, onClose }: { returnFocus: HTMLElement | null; onClose(): void }) {
	const { t, locale } = useT();
	const bridge = useChatStore((s) => s.bridge);
	const sessionId = useChatStore((s) => s.sessionId);
	const [stats, setStats] = useState<UiSessionStats | null>(null);
	const [error, setError] = useState<string | null>(null);
	const ref = useRef<HTMLDialogElement>(null);
	const titleId = useId();
	useEffect(() => {
		const dialog = ref.current;
		dialog?.showModal();
		return () => {
			dialog?.close();
			const anotherDialog = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).some((element) => element !== dialog);
			if (!anotherDialog && returnFocus?.isConnected && returnFocus.getClientRects().length > 0 && !returnFocus.closest('[inert]')) returnFocus.focus({ preventScroll: true });
		};
	}, [returnFocus]);
	useEffect(() => {
		if (!bridge) return;
		let active = true;
		setStats(null);
		setError(null);
		void bridge.getSessionStats()
			.then((value) => { if (active) setStats(value); })
			.catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
		return () => { active = false; };
	}, [bridge, sessionId]);
	const row = (label: string, value: string) => <div className="pd-session-info-row"><span>{label}</span><strong>{value}</strong></div>;
	return createPortal(<dialog ref={ref} className="pd-session-info" role="dialog" aria-modal="true" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={(event) => event.stopPropagation()}>
		<header className="pd-session-info-header">
			<h2 id={titleId}>{t('chat.stats.title')}</h2>
			<button type="button" className="pd-icon-button" aria-label={t('settings.close')} onClick={onClose} autoFocus><Icon name="close" width="18" height="18" /></button>
		</header>
		{error && <p className="pd-session-info-error" role="alert">{t('chat.stats.failed', { message: error })}</p>}
		{stats ? <div className="pd-session-info-body">
			<section aria-label={t('chat.stats.messages')}>
				<h3>{t('chat.stats.messages')}</h3>
				{row(t('chat.stats.userMessages'), stats.userMessages.toLocaleString(locale))}
				{row(t('chat.stats.assistantMessages'), stats.assistantMessages.toLocaleString(locale))}
				{row(t('chat.stats.toolCalls'), stats.toolCalls.toLocaleString(locale))}
				{row(t('chat.stats.toolResults'), stats.toolResults.toLocaleString(locale))}
				{row(t('chat.stats.totalMessages'), stats.totalMessages.toLocaleString(locale))}
			</section>
			<section aria-label={t('chat.stats.tokens')}>
				<h3>{t('chat.stats.tokens')}</h3>
				{row(t('chat.stats.tokensInput'), formatTokens(stats.tokens.input, locale))}
				{row(t('chat.stats.tokensOutput'), formatTokens(stats.tokens.output, locale))}
				{row(t('chat.stats.tokensCacheRead'), formatTokens(stats.tokens.cacheRead, locale))}
				{row(t('chat.stats.tokensCacheWrite'), formatTokens(stats.tokens.cacheWrite, locale))}
				{row(t('chat.stats.tokensTotal'), formatTokens(stats.tokens.total, locale))}
			</section>
			<section aria-label={t('chat.stats.cost')}>
				<h3>{t('chat.stats.cost')}</h3>
				{row(t('chat.stats.cost'), stats.cost.toLocaleString(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }))}
			</section>
		</div> : !error && <p className="pd-session-info-error" role="status">{t('chat.stats.loading')}</p>}
	</dialog>, document.body);
}
