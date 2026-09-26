import { useState } from 'react';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { classifyAgentError, type UiErrorKind } from '../errorAttribution';

/**
 * Run-status bar (4.4): surfaces the four run states at the transcript end —
 * running/auto-retry with attempt counts, rate-limit waiting, and actionable
 * failure hints (fix credentials / compact context / retry) instead of one
 * generic red banner for every error.
 */
export function RunStatusBar({ onOpenModelManagement }: { onOpenModelManagement?: () => void }) {
	const { t } = useT();
	const status = useChatStore((s) => s.status);
	const statusMessage = useChatStore((s) => s.statusMessage);
	const retryAttempt = useChatStore((s) => s.retryAttempt);
	const retryMaxAttempts = useChatStore((s) => s.retryMaxAttempts);
	const error = useChatStore((s) => s.error);
	const [busy, setBusy] = useState(false);

	const retrying = status === 'busy' && retryAttempt !== undefined;
	if (!retrying && !error) return null;

	if (retrying) {
		return (
			<div className="pd-run-status is-retrying" role="status">
				<span className="pd-run-status-dot" aria-hidden="true" />
				<span>{t('chat.runStatus.retrying', { attempt: String(retryAttempt), max: String(retryMaxAttempts ?? retryAttempt) })}</span>
				{statusMessage ? <span className="pd-run-status-detail">{statusMessage}</span> : null}
			</div>
		);
	}

	const kind: UiErrorKind = classifyAgentError(error ?? '');
	const action = busy ? null : (
		kind === 'auth' ? (
			<button type="button" className="pd-run-status-action" onClick={() => { setBusy(true); try { onOpenModelManagement?.(); } finally { setBusy(false); } }}>{t('chat.runStatus.openSettings')}</button>
		) : kind === 'context' ? (
			<button type="button" className="pd-run-status-action" disabled={!onCompactAvailable()} onClick={() => { void runCompact(); }}>{t('chat.runStatus.compact')}</button>
		) : kind === 'network' || kind === 'unknown' ? (
			<button type="button" className="pd-run-status-action" onClick={() => { setBusy(true); void useChatStore.getState().retryAgent().finally(() => setBusy(false)); }}>{t('chat.runStatus.retry')}</button>
		) : null
	);
	return (
		<div className={`pd-run-status is-error pd-run-error-${kind}`} role="alert">
			<strong>{t(`chat.runStatus.${kind}`)}</strong>
			<span>{error}</span>
			<span className="pd-run-status-hint">{t(`chat.runStatus.${kind}Hint`)}</span>
			{action}
		</div>
	);
}

function onCompactAvailable(): boolean {
	const state = useChatStore.getState();
	return Boolean(state.bridge && state.cwd && state.sessionId);
}

async function runCompact(): Promise<void> {
	const state = useChatStore.getState();
	if (!state.bridge || !state.cwd || !state.sessionId) return;
	try {
		await state.bridge.executeSlashCommand({ cwd: state.cwd, sessionId: state.sessionId, name: 'compact' });
	} catch (error) {
		useChatStore.setState({ error: error instanceof Error ? error.message : String(error) });
	}
}
