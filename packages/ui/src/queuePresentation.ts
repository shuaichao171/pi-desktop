import type { UiQueuedMessage } from '@pidesktop/shared';
import type { UiInputQueue, UiInputQueueItem } from '../../shared/src/inputFeatures';

/**
 * How a not-yet-delivered input is presented in the composer queue.
 * - queued:    waiting for the current turn to finish (follow-up)
 * - steering:  will be injected at the next tool boundary of the current turn
 * - paused:    follow-ups are paused; it stays until the queue resumes
 * - editing:   held in the composer editor, withheld from delivery
 * - recovered: survived a restart unconfirmed; the user must confirm or cancel
 */
export type QueueRowStatus = 'queued' | 'steering' | 'paused' | 'editing' | 'recovered';

export interface QueueRowPresentation {
	id: string;
	text: string;
	preview: string;
	attachments: NonNullable<UiQueuedMessage['attachments']>;
	status: QueueRowStatus;
	/** "Send now" = steer: deliver at the next input point without aborting a tool. */
	canSendNow: boolean;
	canConfirm: boolean;
	canCancel: boolean;
}

/**
 * Keep the full text for reading/editing and collapse whitespace only in the row preview.
 * The composer is the single display of pending inputs; delivered messages come from the
 * session transcript. Controller state takes precedence over the last queue event.
 */
export function buildQueueRows(items: readonly UiQueuedMessage[], queue: UiInputQueue | null): QueueRowPresentation[] {
	const rows = new Map<string, UiInputQueueItem>((queue?.items ?? []).map((row) => [row.id, row]));
	return items.map((item) => {
		// The queue event already carries the ledger state; the controller snapshot may be newer.
		const state = rows.get(item.id)?.state ?? (item as Partial<UiInputQueueItem>).state ?? 'accepted';
		const status: QueueRowStatus = state === 'editing' ? 'editing'
			: state === 'recovered' ? 'recovered'
			: item.behavior === 'steer' ? 'steering'
			: queue?.paused ? 'paused' : 'queued';
		return {
			id: item.id,
			text: item.text,
			preview: item.text.replace(/\s+/g, ' ').trim(),
			attachments: item.attachments ?? [],
			status,
			canSendNow: status === 'queued' || status === 'paused',
			canConfirm: status === 'recovered',
			canCancel: status !== 'editing',
		};
	});
}
