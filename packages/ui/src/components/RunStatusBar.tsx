import { useRef, useState } from 'react';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { attributeAgentError, type UiErrorKind } from '../errorAttribution';
import { useConversationCopy } from '../conversationCopy';
import { ErrorDetails } from './ErrorDetails';

/**
 * Run-status bar (4.4): surfaces the four run states at the transcript end —
 * running/auto-retry with attempt counts, rate-limit waiting, and actionable
 * failure hints (fix credentials / compact context / retry) instead of one
 * generic red banner for every error.
 */
export function RunStatusBar({ onOpenModelManagement }: { onOpenModelManagement?: () => void }) {
	const { t } = useT();
	const c = useConversationCopy();
	const lastMessage = useChatStore((s) => s.messages.at(-1));
	const status = useChatStore((s) => s.status);
	const statusMessage = useChatStore((s) => s.statusMessage);
	const retryAttempt = useChatStore((s) => s.retryAttempt);
	const retryMaxAttempts = useChatStore((s) => s.retryMaxAttempts);
	const error = useChatStore((s) => s.error);
	const errorInfo = useChatStore((s) => s.errorInfo);
	const bridge = useChatStore((s) => s.bridge);
	const [busy, setBusy] = useState(false);
	const pending = useRef(false);
	const runAction = async (action: () => Promise<void>) => {
		if (pending.current) return;
		pending.current = true;
		setBusy(true);
		try { await action(); }
		catch { /* Store actions retain the failure in the error banner. */ }
		finally { pending.current = false; setBusy(false); }
	};

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

	// Session-list and other UI failures must not offer an agent restart that
	// retryAgent cannot perform while the agent is healthy. Model-availability
	// gate failures keep the draft, so settings remain reachable from the banner.
	if (status !== 'error') {
		const bannerKind = attributeAgentError(error ?? '', errorInfo);
		const settingsEntry = Boolean(onOpenModelManagement && (bannerKind === 'auth' || bannerKind === 'model-unavailable'));
		const regenerateEntry = status === 'idle' && lastMessage?.role === 'assistant' && lastMessage.status === 'error';
		return <div className="pd-error-banner" role="alert"><span>{error}</span>{(regenerateEntry || settingsEntry) && <div>{regenerateEntry && <button type="button" className="pd-run-status-action" disabled={busy} onClick={() => void runAction(() => useChatStore.getState().regenerate())}>{busy ? c('regenerating') : t('message.regenerate')}</button>}{settingsEntry && <button type="button" className="pd-run-status-action" onClick={onOpenModelManagement}>{t('chat.runStatus.openSettings')}</button>}</div>}<ErrorDetails error={error ?? ''} status={status} info={errorInfo} /></div>;
	}
	const kind: UiErrorKind = attributeAgentError(error ?? '', errorInfo);
	const action = !bridge ? null : (
		kind === 'auth' || kind === 'model-unavailable' ? (
			onOpenModelManagement ? <button type="button" className="pd-run-status-action" onClick={onOpenModelManagement}>{t('chat.runStatus.openSettings')}</button> : null
		) : kind === 'context' ? (
			<button type="button" className="pd-run-status-action" disabled={busy || !onCompactAvailable()} onClick={() => { void runAction(runCompact); }}>{t('chat.runStatus.compact')}</button>
		) : kind === 'network' || kind === 'unknown' ? (
			<button type="button" className="pd-run-status-action" disabled={busy} onClick={() => { void runAction(() => useChatStore.getState().retryAgent()); }}>{c('reconnect')}</button>
		) : null
	);
	return (
		<div className={`pd-run-status is-error pd-run-error-${kind}`} role="alert">
			<strong>{t(`chat.runStatus.${kind}`)}</strong>
			<span>{error}</span>
			<span className="pd-run-status-hint">{t(`chat.runStatus.${kind}Hint`)}</span>
			{action}
			<ErrorDetails error={error ?? ''} status={status} info={errorInfo} />
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
