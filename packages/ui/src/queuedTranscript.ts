import type { UiQueuedMessage } from '@pidesktop/shared';
import type { UiInputQueue, UiInputQueueItem } from '../../shared/src/inputFeatures';

/**
 * How a not-yet-delivered input is presented at the end of the transcript.
 * - queued:    waiting for the current turn to finish (follow-up)
 * - steering:  will be injected at the next tool boundary of the current turn
 * - paused:    follow-ups are paused; it stays until the queue resumes
 * - editing:   held in the composer editor, withheld from delivery
 * - recovered: survived a restart unconfirmed; the user must confirm or cancel
 */
export type QueuedBubbleStatus = 'queued' | 'steering' | 'paused' | 'editing' | 'recovered';

export interface QueuedBubble {
	id: string;
	text: string;
	attachments: NonNullable<UiQueuedMessage['attachments']>;
	status: QueuedBubbleStatus;
	/** "Send now" = steer: interrupt the current turn at the next safe point. */
	canSendNow: boolean;
	canConfirm: boolean;
	canCancel: boolean;
}

/**
 * Synthesizes transcript bubbles from the live queue. They exist only in the UI: nothing is
 * written to the session, and an entry disappears as soon as the SDK consumes it (the real
 * user message replaces it in the same event burst), so it can never show twice.
 */
export function buildQueuedBubbles(items: readonly UiQueuedMessage[], queue: UiInputQueue | null): QueuedBubble[] {
	const rows = new Map<string, UiInputQueueItem>((queue?.items ?? []).map((row) => [row.id, row]));
	return items.map((item) => {
		// The queue event already carries the ledger state; the controller snapshot may be newer.
		const state = rows.get(item.id)?.state ?? (item as Partial<UiInputQueueItem>).state ?? 'accepted';
		const status: QueuedBubbleStatus = state === 'editing' ? 'editing'
			: state === 'recovered' ? 'recovered'
			: item.behavior === 'steer' ? 'steering'
			: queue?.paused ? 'paused' : 'queued';
		return {
			id: item.id,
			text: item.text,
			attachments: item.attachments ?? [],
			status,
			canSendNow: status === 'queued' || status === 'paused',
			canConfirm: status === 'recovered',
			canCancel: status !== 'editing',
		};
	});
}
