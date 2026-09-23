import type { UiMessage, UiToolActivity } from '@pidesktop/shared';

export type TimelineEntry =
	| { kind: 'message'; id: string; order: number; index: number }
	| { kind: 'tools'; id: string; order: number; indices: number[] };

/** Build only the timeline layout; streaming text and tool progress keep their indices. */
export function buildTimelineLayout(messages: UiMessage[], activities: UiToolActivity[]): TimelineEntry[] {
	const ordered = [
		...messages.map((message, index) => ({ kind: 'message' as const, id: message.id, order: message.order, index })),
		...activities.map((activity, index) => ({ kind: 'tool' as const, id: activity.id, order: activity.order, index })),
	].sort((a, b) => a.order - b.order);
	const timeline: TimelineEntry[] = [];
	for (const item of ordered) {
		if (item.kind === 'message') {
			timeline.push({ kind: 'message', id: item.id, order: item.order, index: item.index });
			continue;
		}
		const previous = timeline.at(-1);
		if (previous?.kind === 'tools') previous.indices.push(item.index);
		else timeline.push({ kind: 'tools', id: item.id, order: item.order, indices: [item.index] });
	}
	return timeline;
}
