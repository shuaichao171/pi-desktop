import type { UiQueuedMessage } from '@pidesktop/shared';

export interface SdkQueueSnapshot {
	steering: readonly string[];
	followUp: readonly string[];
}

export interface QueuedMessageRecord {
	raw: string;
	item: UiQueuedMessage;
}

/** Pi appends messages and consumes the first matching text in each queue.
 * Keep duplicate prompts distinct, including when the first duplicate is delivered. */
export function reconcileQueuedMessages(
	previous: QueuedMessageRecord[],
	queue: SdkQueueSnapshot,
	create: (raw: string, behavior: UiQueuedMessage['behavior']) => UiQueuedMessage,
): QueuedMessageRecord[] {
	const result: QueuedMessageRecord[] = [];
	for (const behavior of ['steer', 'followUp'] as const) {
		const values = behavior === 'steer' ? queue.steering : queue.followUp;
		const available = new Map<string, QueuedMessageRecord[]>();
		for (const record of previous) {
			if (record.item.behavior !== behavior) continue;
			const entries = available.get(record.raw) ?? [];
			entries.push(record);
			available.set(record.raw, entries);
		}
		const counts = new Map<string, number>();
		for (const raw of values) counts.set(raw, (counts.get(raw) ?? 0) + 1);
		for (const [raw, entries] of available) {
			const consumed = entries.length - (counts.get(raw) ?? 0);
			if (consumed > 0) entries.splice(0, consumed);
		}
		for (const raw of values) result.push(available.get(raw)?.shift() ?? { raw, item: create(raw, behavior) });
	}
	return result;
}

export function cloneQueuedMessage(item: UiQueuedMessage): UiQueuedMessage {
	return { ...item, ...(item.attachments ? { attachments: item.attachments.map((attachment) => ({ ...attachment })) } : {}) };
}
