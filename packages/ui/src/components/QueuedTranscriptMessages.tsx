import { memo, useMemo } from 'react';
import { useT } from '../i18n';
import { buildQueuedBubbles, type QueuedBubbleStatus } from '../queuedTranscript';
import { useChatStore } from '../store';
import { useInputQueue } from '../useInputQueue';
import { Icon } from './Icons';
import './queuedTranscript.css';

const STATUS_KEY: Record<QueuedBubbleStatus, string> = {
	queued: 'queue.bubbleQueued',
	steering: 'queue.bubbleSteering',
	paused: 'queue.bubblePaused',
	editing: 'queue.bubbleEditing',
	recovered: 'queue.bubbleRecovered',
};

/**
 * Inputs submitted while a turn runs appear right away at the end of the transcript, in the
 * same column and layout as real user turns. They are synthesized from the live queue only
 * (never written to the session) and vanish when the SDK consumes them, at which point the
 * real user message takes their place.
 */
export const QueuedTranscriptMessages = memo(function QueuedTranscriptMessages() {
	const { t } = useT();
	const items = useChatStore((s) => s.queuedMessages);
	const { queue, pendingRows, activeRow, ready, mutate } = useInputQueue(items);
	const bubbles = useMemo(() => buildQueuedBubbles(items, queue), [items, queue]);
	if (!bubbles.length) return null;
	return <div className="pd-queued-transcript" aria-label={t('composer.queuedInstructions')}>
		{bubbles.map((bubble) => {
			const rowPending = pendingRows.has(bubble.id);
			const disabled = !ready || rowPending;
			return <div key={bubble.id} className={`pd-message-row is-user is-queued is-${bubble.status}${rowPending ? ' is-pending' : ''}`} data-queued-id={bubble.id} aria-busy={rowPending}>
				<div className="pd-message-column">
					<div className="pd-user-bubble" aria-label={t('queue.bubbleLabel')}>
						{bubble.text && <p>{bubble.text}</p>}
						{bubble.attachments.length > 0 && <div className="pd-queued-attachments">{bubble.attachments.map((file, index) => <span key={`${file.name}:${index}`}><Icon name={file.kind === 'image' ? 'image' : 'file'} width="13" height="13" />{file.name}</span>)}</div>}
					</div>
					<div className="pd-queued-footer">
						<span className="pd-queued-status" role="status">
							{bubble.status === 'steering' ? <Icon name="steer" width="13" height="13" /> : <Icon name="clock" width="13" height="13" />}
							{rowPending ? t(activeRow === bubble.id ? 'queue.updating' : 'queue.waiting') : t(STATUS_KEY[bubble.status])}
						</span>
						{bubble.canConfirm && <button type="button" className="pd-queued-action is-primary" disabled={disabled} onClick={() => void mutate('confirm', bubble.id)}>{t('queue.confirmRestore')}</button>}
						{bubble.canSendNow && <button type="button" className="pd-queued-action is-primary" disabled={disabled} title={t('queue.sendNowHint')} onClick={() => void mutate('steer', bubble.id)}><Icon name="steer" width="13" height="13" />{t('queue.sendNow')}</button>}
						{bubble.canCancel && <button type="button" className="pd-queued-action" disabled={disabled} onClick={() => void mutate('remove', bubble.id)}><Icon name="close" width="13" height="13" />{t('queue.cancelSend')}</button>}
					</div>
				</div>
			</div>;
		})}
	</div>;
});
