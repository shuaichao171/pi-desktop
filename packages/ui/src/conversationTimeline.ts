import type { UiConversationRun, UiMessage, UiToolActivity } from '@pidesktop/shared';
import { buildTimelineLayout, type TimelineEntry } from './timeline.ts';

export interface ConversationTurnEntry {
  kind: 'turn'; id: string; runId: string | undefined; entries: TimelineEntry[]; lastForRun: boolean;
}
export type ConversationTimelineEntry = Extract<TimelineEntry, { kind: 'message' }> | ConversationTurnEntry;

/** Users and system notices always stay visible, including steering within a run. */
export function buildConversationTimeline(messages: UiMessage[], activities: UiToolActivity[], runs: UiConversationRun[]): ConversationTimelineEntry[] {
  const result: ConversationTimelineEntry[] = [];
  let anchor = 'history', inheritedRun: string | undefined;
  const append = (entry: TimelineEntry, runId: string | undefined) => {
    const previous = result.at(-1);
    if (previous?.kind === 'turn' && previous.runId === runId) previous.entries.push(entry);
    else result.push({ kind: 'turn', id: `${runId ?? 'legacy'}:${anchor}:${entry.id}`, runId, entries: [entry], lastForRun: true });
  };
  for (const entry of buildTimelineLayout(messages, activities)) {
    if (entry.kind === 'message') {
      const message = messages[entry.index]!;
      if (message.role !== 'assistant') {
        result.push(entry); anchor = message.id;
        if (message.role === 'user') inheritedRun = message.runId;
      } else append(entry, message.runId ?? inheritedRun);
    } else {
      // A restored page may contain adjacent tools from different run identities.
      let group: Extract<TimelineEntry, { kind: 'tools' }> | undefined, groupRun: string | undefined;
      for (const index of entry.indices) {
        const activity = activities[index]!, runId = activity.runId ?? inheritedRun;
        if (group && groupRun === runId) group.indices.push(index);
        else { group = { kind: 'tools', id: activity.id, order: activity.order, indices: [index] }; groupRun = runId; append(group, runId); }
      }
    }
  }
  // Keep an observed stop/failure visible even when it happened before the first
  // assistant token. Place it by its user message or the next recorded run.
  const represented = new Set(result.flatMap(entry => entry.kind === 'turn' && entry.runId ? [entry.runId] : []));
  const runOrder = new Map(runs.map((run, index) => [run.id, index]));
  const entryRun = (entry: ConversationTimelineEntry) => entry.kind === 'turn' ? entry.runId : messages[entry.index]?.runId;
  for (const run of runs) if (!represented.has(run.id)) {
    const userIndex = result.findLastIndex(entry => entryRun(entry) === run.id);
    const nextIndex = result.findIndex(entry => (runOrder.get(entryRun(entry) ?? '') ?? -1) > runOrder.get(run.id)!);
    const index = userIndex >= 0 ? userIndex + 1 : nextIndex >= 0 ? nextIndex : result.length;
    result.splice(index, 0, { kind: 'turn', id: `waiting:${run.id}`, runId: run.id, entries: [], lastForRun: true });
  }
  const seen = new Set<string>();
  for (const entry of [...result].reverse()) if (entry.kind === 'turn' && entry.runId) {
    entry.lastForRun = !seen.has(entry.runId); seen.add(entry.runId);
  }
  return result;
}

export function entryContainsMessage(entry: ConversationTimelineEntry, id: string): boolean {
  return entry.kind === 'message' ? entry.id === id : entry.entries.some(item => item.kind === 'message' && item.id === id);
}

/** A reply followed by tools is commentary. Only the last response stays outside the process. */
export function turnAnswer(entry: ConversationTurnEntry, messages: UiMessage[]): UiMessage | undefined {
  if (!entry.lastForRun) return undefined;
  const last = entry.entries.at(-1);
  if (last?.kind !== 'message') return undefined;
  const message = messages[last.index];
  return message?.role === 'assistant' && (message.text || message.status === 'error') ? message : undefined;
}
