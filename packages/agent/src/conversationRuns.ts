import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import type { SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent';
import type { UiConversationRun, UiMessage, UiToolActivity } from '@pidesktop/shared';

export const CONVERSATION_RUN_ENTRY = 'pi-desktop:conversation-run-v1';
type Outcome = Exclude<UiConversationRun['status'], 'running'>;

export function isConversationRunEntry(entry: SessionEntry): boolean { return entry.type === 'custom' && entry.customType === CONVERSATION_RUN_ENTRY; }

function storedRun(entry: SessionEntry): UiConversationRun | undefined {
  if (!isConversationRunEntry(entry) || entry.type !== 'custom') return;
  const data = entry.data as { version?: unknown; run?: UiConversationRun } | undefined, run = data?.run;
  if (data?.version !== 1 || !run || typeof run.id !== 'string' || !/^[\w-]{1,100}$/.test(run.id) ||
    !Number.isFinite(run.startedAt) || run.startedAt < 0 || !['running', 'completed', 'cancelled', 'failed', 'interrupted'].includes(run.status) ||
    run.finishedAt !== null && (!Number.isFinite(run.finishedAt) || run.finishedAt < run.startedAt) ||
    run.status === 'running' && run.finishedAt !== null) return;
  return { id: run.id, startedAt: run.startedAt, finishedAt: run.finishedAt, status: run.status };
}

/** Only records on the selected branch establish membership and completion. */
export function readConversationRuns(entries: SessionEntry[], live?: UiConversationRun | null): { runs: UiConversationRun[]; entryRuns: Map<string, string> } {
  const runs = new Map<string, UiConversationRun>(), entryRuns = new Map<string, string>(); let current: string | undefined;
  for (const entry of entries) {
    const run = storedRun(entry);
    if (run) {
      const previous = runs.get(run.id);
      if (previous && previous.startedAt !== run.startedAt) continue;
      runs.set(run.id, run);
      if (run.status === 'running') current = run.id;
      else if (current === run.id) current = undefined;
    } else if (current) entryRuns.set(entry.id, current);
  }
  if (live) runs.set(live.id, { ...live });
  return { runs: [...runs.values()].map(run => run.status === 'running' && run.id !== live?.id ? { ...run, status: 'interrupted', finishedAt: null } : run), entryRuns };
}

/** A preflight/handled-command result may have no transcript row to anchor it. */
export function latestUnassociatedRunId(timeline: { runs?: UiConversationRun[]; messages: UiMessage[]; activities: UiToolActivity[] }): string | undefined {
  const last = timeline.runs?.at(-1);
  return last && !timeline.messages.some(message => message.runId === last.id) && !timeline.activities.some(activity => activity.runId === last.id) ? last.id : undefined;
}

export function selectConversationRuns(runs: UiConversationRun[] | undefined, messages: UiMessage[], activities: UiToolActivity[], unassociatedRunId?: string): UiConversationRun[] {
  const selected = new Set([...messages, ...activities].map(item => item.runId).filter(Boolean));
  return (runs ?? []).filter(run => selected.has(run.id) || run.status === 'running' || run.id === unassociatedRunId).map(run => ({ ...run }));
}

/** Per-runtime lifecycle state. Custom entries never enter the model's context. */
export class ConversationRunTracker {
  active: UiConversationRun | null = null;
  private outcome: Outcome = 'completed';
  private cancelled = false;
  private cancelledRunId: string | null = null;
  hasMessages = false;
  readonly manager: SessionManager;
  private publish: (run: UiConversationRun) => void;
  private failed: (error: unknown) => void;
  constructor(manager: SessionManager, publish: (run: UiConversationRun) => void, failed: (error: unknown) => void) {
    this.manager = manager; this.publish = publish; this.failed = failed;
  }

  begin(): UiConversationRun {
    if (this.active) return this.active;
    this.outcome = 'completed'; this.cancelled = false; this.hasMessages = false;
    this.active = { id: randomUUID(), startedAt: Date.now(), finishedAt: null, status: 'running' };
    this.record(this.active); return this.active;
  }
  assistantEnd(stopReason: string): void {
    this.outcome = stopReason === 'aborted' ? 'cancelled' : stopReason === 'error' ? 'failed' : 'completed';
  }
  requestCancel(): void { if (this.active) { this.cancelled = true; this.cancelledRunId = this.active.id; } }
  wasCancelled(id: string): boolean { return this.cancelledRunId === id; }
  finish(status?: Outcome): void {
    if (!this.active) return;
    const run = { ...this.active, finishedAt: Math.max(this.active.startedAt, Date.now()), status: this.cancelled ? 'cancelled' as const : status ?? this.outcome };
    this.active = null; this.record(run);
  }
  private record(run: UiConversationRun): void {
    try {
      this.manager.appendCustomEntry(CONVERSATION_RUN_ENTRY, { version: 1, run });
      // Pi defers a fresh JSONL until the first assistant. Persist the observed
      // start now so a crash while authenticating/waiting for a token is recoverable.
      const path = this.manager.getSessionFile(), header = this.manager.getHeader();
      if (this.manager.isPersisted() && path && header && !existsSync(path)) {
        writeFileSync(path, [header, ...this.manager.getEntries()].map(entry => JSON.stringify(entry)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
        this.manager.setSessionFile(path);
      }
    } catch (error) { this.failed(error); }
    this.publish({ ...run });
  }
}
