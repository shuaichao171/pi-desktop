import type { UiMessage, UiToolActivity } from '@pidesktop/shared';

export type TimelineEntry =
	| { kind: 'message'; id: string; order: number; index: number; showAssistantHeading: boolean }
	| { kind: 'tools'; id: string; order: number; indices: number[] };

/** Build only the timeline layout; streaming text and tool progress keep their indices. */
export function buildTimelineLayout(messages: UiMessage[], activities: UiToolActivity[]): TimelineEntry[] {
	// The "π Pi" heading marks the start of each assistant block, not every reply.
	const headingStarts = new Set<string>();
	let previousRole: UiMessage['role'] | undefined;
	for (const message of messages) {
		if (message.role === 'assistant' && previousRole !== 'assistant') headingStarts.add(message.id);
		// System notices are furniture, not turns: they never start an assistant block.
		if (message.role !== 'system') previousRole = message.role;
	}
	const ordered = [
		...messages.map((message, index) => ({ kind: 'message' as const, id: message.id, order: message.order, index, heading: message.role === 'assistant' && headingStarts.has(message.id) })),
		...activities.map((activity, index) => ({ kind: 'tool' as const, id: activity.id, order: activity.order, index })),
	].sort((a, b) => a.order - b.order);
	const timeline: TimelineEntry[] = [];
	for (const item of ordered) {
		if (item.kind === 'message') {
			timeline.push({ kind: 'message', id: item.id, order: item.order, index: item.index, showAssistantHeading: item.heading });
			continue;
		}
		const previous = timeline.at(-1);
		if (previous?.kind === 'tools') previous.indices.push(item.index);
		else timeline.push({ kind: 'tools', id: item.id, order: item.order, indices: [item.index] });
	}
	return timeline;
}
