import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { operationFeedback, type OperationNotice } from '../operationFeedback';
import { useT } from '../i18n';
import { operationNoticeTimeoutMs, useOperationNoticeTimeoutSeconds } from '../operationNoticeTimeout';
import { Icon } from './Icons';
import './operationFeedback.css';

function Notice({ notice }: { notice: OperationNotice }) {
	const { t } = useT();
	const [timeoutSeconds] = useOperationNoticeTimeoutSeconds();
	const [held, setHeld] = useState(false);
	// Remaining time survives a pause: hovering or focusing holds the countdown
	// instead of restarting it, so a card never disappears mid-read.
	const remaining = useRef(0);
	const timeout = operationNoticeTimeoutMs(notice.kind, timeoutSeconds);
	useEffect(() => {
		if (timeout === null) return;
		remaining.current = timeout;
	}, [notice, timeout]);
	useEffect(() => {
		if (timeout === null || held) return;
		const started = performance.now();
		const timer = window.setTimeout(() => operationFeedback.dismiss(notice.id), remaining.current);
		return () => {
			window.clearTimeout(timer);
			remaining.current = Math.max(0, remaining.current - (performance.now() - started));
		};
	}, [notice, timeout, held]);
	// Errors lead with what failed and why; only a longer trace stays behind "details".
	const error = notice.kind === 'error';
	const [reason = '', ...rest] = (notice.detail ?? '').trim().split(/\r?\n/);
	const shortReason = reason.length > 160 ? `${reason.slice(0, 157)}…` : reason;
	const hasMore = rest.some(line => line.trim()) || shortReason !== reason;
	const title = error ? t('operation.failed', { title: notice.title }) : notice.title;
	return <section className={`pd-operation-notice is-${notice.kind}`} role={error ? 'alert' : 'status'} aria-busy={notice.kind === 'pending'} onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)} onFocusCapture={() => setHeld(true)} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false); }}>
		<div className="pd-operation-notice-heading"><Icon name={error ? 'alert' : notice.kind === 'success' ? 'check' : 'clock'} width="15" height="15" className="pd-operation-notice-icon" /><strong>{title}</strong><button type="button" className="pd-operation-notice-close" aria-label={t('operation.dismiss')} onClick={() => operationFeedback.dismiss(notice.id)}><Icon name="close" width="14" height="14" /></button></div>
		{/* Retry sits beside the reason instead of adding a row of its own. */}
		{(shortReason || notice.retry) && <div className="pd-operation-notice-body">
			{shortReason && <p className="pd-operation-notice-reason">{shortReason}</p>}
			{notice.retry && <button type="button" className="pd-operation-notice-retry" onClick={() => void notice.retry?.().catch(cause => operationFeedback.show({ ...notice, kind: 'error', detail: cause instanceof Error ? cause.message : String(cause) }))}>{t('operation.retry')}</button>}
		</div>}
		{hasMore && <details><summary>{t('operation.fullMessage')}</summary><p>{notice.detail}</p></details>}
	</section>;
}

export function OperationFeedback() {
	const notices = useSyncExternalStore(operationFeedback.subscribe, operationFeedback.getSnapshot, operationFeedback.getSnapshot);
	return notices.length ? <div className="pd-operation-feedback" aria-label="Notifications">{notices.map(notice => <Notice key={notice.id} notice={notice} />)}</div> : null;
}
