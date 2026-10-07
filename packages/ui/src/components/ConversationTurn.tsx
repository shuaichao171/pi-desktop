import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { UiConversationRun, UiFileChange, UiMessage, UiToolActivity } from '@pidesktop/shared';
import { useT } from '../i18n';
import { useExtensionNoticeDisplayEnabled } from '../extensionNoticeDisplay';
import { formatRunDuration } from '../conversationRuns';
import { turnAnswer, type ConversationTurnEntry } from '../conversationTimeline';
import { useDisclosureChoice, useDisclosureRequest } from '../conversationDisclosure';
import { ActivityDisclosure, ActivityLabel } from './ActivityDisclosure';
import { MessageItem } from './MessageItem';
import { ThinkingActivity } from './ThinkingActivity';
import { ToolActivityPanel } from './ToolActivity';
import { Icon } from './Icons';
import './conversationTurn.css';
import { ChangesCard, type ChangesReviewApi } from './ComposerChanges';
import { countToolGroup, isExplorationGroup, toolGroupSummaryParts } from '../toolGroupSummary';

function RunDuration({ run }: { run: UiConversationRun }) {
  const { locale } = useT();
  const [now, setNow] = useState(Date.now);
  const running = run.status === 'running';
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, run.id]);
  const end = running ? now : run.finishedAt;
  if (end === null || !Number.isFinite(run.startedAt) || !Number.isFinite(end)) return null;
  const elapsed = Math.max(0, end - run.startedAt);
  // The ticking text is intentionally outside a live region to avoid speaking every second.
  return <span className="pd-turn-duration" data-elapsed-ms={elapsed}>{formatRunDuration(elapsed, locale)}</span>;
}

export const ConversationTurn = memo(function ConversationTurn({ entry, messages, activities, run, changes, changesReview, legacyRunning, highlightedId, findIds, query, reveal, canRegenerateId }: {
  entry: ConversationTurnEntry; messages: UiMessage[]; activities: UiToolActivity[]; run?: UiConversationRun;
  /** This run's recorded file changes; rendered as the turn's settlement card. */
  changes?: UiFileChange[];
  /** Shared review dialog API (owned by ChatView). */
  changesReview: ChangesReviewApi;
  legacyRunning: boolean; highlightedId: string | null; findIds: Set<string>; query: string;
  reveal: { id: string; request: number } | null; canRegenerateId: string | null;
}) {
  const { locale } = useT(), zh = locale === 'zh-CN';
  const detailId = useId();
  const running = run ? run.status === 'running' : legacyRunning;
  const phase = running ? 'running' : 'settled';
  // An explicit choice during execution does not override automatic folding on completion.
  const [choice, setChoice] = useDisclosureChoice(`turn:${entry.id}:${phase}`);
  const consumeReveal = useDisclosureRequest(`turn:${entry.id}`);
  const answer = turnAnswer(entry, messages, running);
  const ownMessages = entry.entries.flatMap(item => item.kind === 'message' ? [messages[item.index]!] : []);
  const ownTools = entry.entries.flatMap(item => item.kind === 'tools' ? item.indices.map(index => activities[index]!) : []);
  // Plugin notices ride inside the run's fold: while the run is live they are
  // visible in chronological position among the steps, and once the run
  // settles they fold away with the process instead of staying expanded
  // beside the answer. The display setting hides them entirely.
  const [noticesVisible] = useExtensionNoticeDisplayEnabled();
  const notices = ownMessages.filter(message => message.systemKind === 'extension-notice');
  const shownNotices = noticesVisible ? notices : [];
  const processMessages = ownMessages.filter(message => message.id !== answer?.id && message.systemKind !== 'extension-notice');
  const foldMessages = noticesVisible ? [...processMessages, ...notices] : processMessages;
  const hasProcess = ownTools.length > 0 || shownNotices.length > 0 || processMessages.some(message => message.text || message.thinking || message.thinkingStatus || message.status === 'error') || Boolean(answer?.thinking || answer?.thinkingStatus);
  const searchExpands = Boolean(query && foldMessages.some(message => `${message.text}\n${message.thinking ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  const expanded = hasProcess && (searchExpands || (choice ?? running));
  const mountedProcess = useRef(false);
  if (expanded) mountedProcess.current = true;
  useLayoutEffect(() => {
    if (reveal && ownMessages.some(message => message.id === reveal.id) && consumeReveal(reveal.request)
      && foldMessages.some(message => message.id === reveal.id)) setChoice(true);
    // A new navigation request opens a folded result; terminal updates still fold the run.
  }, [reveal?.request]);
  const status = run?.status ?? (running ? 'running' : ownMessages.some(message => message.status === 'error') ? 'failed' : 'completed');
  // The turn header is where tool groups are summarized: "Read 3 files · 2 searches"
  // instead of "5 tool calls" (ZCode explore grouping); exploration-only turns say so.
  const toolCounts = countToolGroup(ownTools);
  const toolSummary = toolGroupSummaryParts(toolCounts, locale).join(' · ');
  const exploring = isExplorationGroup(toolCounts) && !processMessages.some(message => message.status === 'error');
  const label = ({ running: zh ? (exploring ? '正在探索' : '进行中') : (exploring ? 'Exploring' : 'Working'), completed: zh ? (exploring ? '已探索' : '已完成') : (exploring ? 'Explored' : 'Worked'), cancelled: zh ? '已停止' : 'Stopped', failed: zh ? '运行失败' : 'Failed', interrupted: zh ? '运行中断' : 'Interrupted' })[status];
  const failureCount = ownTools.filter(tool => tool.status === 'error').length;
  const header = <>
    <Icon name={running ? 'clock' : status === 'completed' ? 'check' : status === 'failed' ? 'close' : 'square'} width="14" height="14" />
    <ActivityLabel active={running}>{label}</ActivityLabel>
    {run && entry.lastForRun && <RunDuration run={run} />}
    {ownTools.length > 0 && <span className="pd-turn-count" title={zh ? `${ownTools.length} 次工具调用` : `${ownTools.length} tool ${ownTools.length === 1 ? 'call' : 'calls'}`}>{toolSummary || (zh ? `${ownTools.length} 次工具调用` : `${ownTools.length} tool ${ownTools.length === 1 ? 'call' : 'calls'}`)}</span>}
    {failureCount > 0 && <span className="pd-turn-failures">{zh ? `${failureCount} 次失败` : `${failureCount} failed`}</span>}
    {hasProcess && <Icon name="chevronDown" className={`pd-chevron${expanded ? ' is-open' : ''}`} width="14" height="14" />}
  </>;
  // Legacy direct replies have no timing information: do not invent a duration or extra status row.
  const showHeader = Boolean(run) || hasProcess || running;
  return <section className={`pd-conversation-turn is-${status}`} data-run-id={entry.runId}>
    <div className="pd-message-column">
      {showHeader && (hasProcess
        ? <button type="button" className="pd-turn-summary" aria-expanded={expanded} aria-controls={detailId} onClick={() => setChoice(!expanded)}>{header}</button>
        : <div className="pd-turn-summary">{header}</div>)}
      {hasProcess && <div className="pd-turn-process"><ActivityDisclosure id={detailId} expanded={expanded}>
        {(running || mountedProcess.current) && <div className="pd-turn-steps">{entry.entries.map(item => {
          if (item.kind === 'tools') return <ToolActivityPanel key={`tools:${item.id}`} sourceActivities={activities} indices={item.indices} inline />;
          const message = messages[item.index]!;
          if (message.systemKind === 'extension-notice') return noticesVisible
            ? <MessageItem key={message.id} message={message} process showHeading={false} highlighted={highlightedId === message.id} findMatch={findIds.has(message.id)} />
            : null;
          if (message.id === answer?.id && !message.thinking && !message.thinkingStatus) return null;
          // Thinking and live prose share a stable position throughout the run.
          // Only the final answer moves out when the whole run has settled.
          return <div key={message.id}>
            {(message.thinking || message.thinkingStatus) && <div data-thinking-for={message.id}><ThinkingActivity message={message} /></div>}
            {message.id !== answer?.id && <MessageItem message={message} process hideThinking showHeading={false} hidePending highlighted={highlightedId === message.id} findMatch={findIds.has(message.id)} />}
          </div>;
        })}</div>}
      </ActivityDisclosure></div>}
      {answer && <div className="pd-turn-answer"><MessageItem message={answer} hideThinking hidePending showHeading={false} highlighted={highlightedId === answer.id} findMatch={findIds.has(answer.id)} canRegenerate={canRegenerateId === answer.id} /></div>}
      {!running && changes && changes.length > 0 && entry.runId && <div className="pd-turn-changes"><ChangesCard items={changes} scope={{ kind: 'turn', runId: entry.runId }} variant="turn" review={changesReview} /></div>}
    </div>
  </section>;
});
