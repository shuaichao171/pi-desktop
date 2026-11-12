import type { UiMessage, UiToolActivity } from '@pidesktop/shared';
import type { ConversationTimelineEntry } from './conversationTimeline';
import { findOccurrences, type FindOccurrence } from './conversationState.ts';
import { activityTitleSummary } from './activityCopy.ts';

/** A hit inside a tool activity title; the row it reveals is the owning turn. */
export interface ToolFindOccurrence { kind: 'tool'; key: string; turnId: string; activityId: string; ordinal: number }
export type TranscriptFindMatch = FindOccurrence | ToolFindOccurrence;

/** Searchable text of one tool activity head: tool kind plus title line, newline-separated so phrases never bridge the two. */
export function toolFindText(activity: UiToolActivity): string {
	const lines = [activity.tool, activityTitleSummary(activity)];
	if (activity.subagent) lines.push(activity.subagent.agent, activity.subagent.task ?? '');
	return lines.filter(Boolean).join('\n');
}

/** Case-insensitive pure substring (escaped) — same matcher family as message find. */
function findRegExp(query: string): RegExp | null {
	const needle = query.trim();
	if (!needle) return null;
	return new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
}

export function toolFindOccurrences(activity: UiToolActivity, query: string, turnId: string): ToolFindOccurrence[] {
	const expression = findRegExp(query);
	if (!expression) return [];
	return Array.from(toolFindText(activity).matchAll(expression), (hit, ordinal) =>
		({ kind: 'tool' as const, key: `tool:${activity.id}:${hit.index}`, turnId, activityId: activity.id, ordinal }));
}

/**
 * Ordered find domain of the loaded transcript window: user/assistant/system
 * message text plus tool activity titles, in timeline (chronological) order.
 * Extension notices are transient popups, never transcript rows. Tool hits carry
 * the owning turn id — their content only renders inside the turn's fold.
 */
export function transcriptFindMatches(timeline: readonly ConversationTimelineEntry[], messages: readonly UiMessage[], activities: readonly UiToolActivity[], query: string): TranscriptFindMatch[] {
	if (!query.trim()) return [];
	const matches: TranscriptFindMatch[] = [];
	const visitMessage = (index: number) => {
		const message = messages[index];
		if (!message || message.systemKind === 'extension-notice') return;
		matches.push(...findOccurrences([message], query));
	};
	for (const entry of timeline) {
		if (entry.kind === 'message') { visitMessage(entry.index); continue; }
		for (const item of entry.entries) {
			if (item.kind === 'message') visitMessage(item.index);
			else for (const index of item.indices) {
				const activity = activities[index];
				if (activity) matches.push(...toolFindOccurrences(activity, query, entry.id));
			}
		}
	}
	return matches;
}

/** Wrap-around stepping over the ordered match list; empty sets and stale indexes clamp to the first match. */
export function stepFindIndex(current: number, total: number, delta: 1 | -1): number {
	if (total <= 0) return 0;
	const base = current >= 0 && current < total ? current : 0;
	return (base + delta + total) % total;
}

/** Cap for the sr-only placeholder: screen-reader brevity only — matching is data-driven, never limited by it. */
export const OMITTED_FIND_TEXT_LIMIT = 4000;

/**
 * sr-only placeholder text for a folded turn (data-find-omitted, Claude-style):
 * the searchable content the fold omits — tool title lines, then process texts.
 */
export function omittedFindText(parts: readonly string[]): string | null {
	const text = parts.map((part) => part.trim()).filter(Boolean).join('\n').replace(/\n{3,}/g, '\n\n').trim();
	if (!text) return null;
	return text.length > OMITTED_FIND_TEXT_LIMIT ? `${text.slice(0, OMITTED_FIND_TEXT_LIMIT)}…` : text;
}
