import { useEffect, useRef, useState } from 'react';
import type { UiUpdateState } from '@pidesktop/shared';
import { useT } from '../i18n';
import { useChatStore } from '../store';

/**
 * Global update toast: makes the background startup check visible outside the
 * settings dialog. Shows download progress while fetching, then a one-click
 * "update now" action that installs and restarts without further prompts.
 */
export function UpdateNotice() {
	const { t } = useT();
	const bridge = useChatStore((s) => s.bridge);
	const [state, setState] = useState<UiUpdateState | null>(null);
	const [dismissed, setDismissed] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const seenVersion = useRef<string | null>(null);

	useEffect(() => {
		if (!bridge) return;
		let active = true;
		let receivedEvent = false;
		const unsubscribe = bridge.onUpdateStateChanged((next) => {
			receivedEvent = true;
			if (active) setState(next);
		});
		void bridge.getUpdateState().then((next) => { if (active && !receivedEvent) setState(next); }).catch(() => {});
		return () => { active = false; unsubscribe(); };
	}, [bridge]);

	// A new available version re-opens a dismissed toast; a fresh check cycle
	// (checking) also clears stale dismissal so the next readiness is announced.
	useEffect(() => {
		if (!state) return;
		if (state.phase === 'checking') { setDismissed(false); setError(null); return; }
		const version = state.availableVersion ?? null;
		if (version && version !== seenVersion.current) { seenVersion.current = version; setDismissed(false); }
	}, [state]);

	if (!bridge || !state || dismissed || pending) return null;
	if (state.phase === 'installing' || state.installRequested) {
		return (
			<aside className="pd-update-notice" role="status" aria-live="polite">
				<p>{t('settings.updateRequestedNotice')}</p>
			</aside>
		);
	}
	if (state.phase === 'downloading') {
		return (
			<aside className="pd-update-notice" role="status" aria-live="polite">
				<p>{t('update.noticeDownloading', { version: state.availableVersion ?? '', percent: String(Math.round(state.progressPercent ?? 0)) })}</p>
				<progress max={100} value={state.progressPercent ?? 0} aria-label={t('settings.updateProgress')} />
			</aside>
		);
	}
	if (state.phase === 'ready') {
		return (
			<aside className="pd-update-notice" role="status" aria-live="polite">
				<p>{t('update.noticeReady', { version: state.availableVersion ?? '' })}</p>
				{error && <p className="pd-update-notice-error">{error}</p>}
				<div className="pd-update-notice-actions">
					<button type="button" className="pd-update-notice-secondary" onClick={() => setDismissed(true)}>{t('update.noticeLater')}</button>
					<button type="button" className="pd-update-notice-primary" onClick={() => {
						setPending(true);
						setError(null);
						void bridge.installUpdate().catch((cause: unknown) => {
							setPending(false);
							setError(cause instanceof Error ? cause.message : String(cause));
						});
					}}>{t('update.noticeInstall')}</button>
				</div>
			</aside>
		);
	}
	return null;
}
