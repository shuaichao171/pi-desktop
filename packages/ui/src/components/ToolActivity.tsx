import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { UiToolActivity } from '@pidesktop/shared';
import { useT } from '../i18n';
import { activityCopy, activityPresentation } from '../activityCopy';
import { useDisclosureChoice } from '../conversationDisclosure';
import { ActivityDisclosure, ActivityLabel } from './ActivityDisclosure';
import { Icon } from './Icons';
import { ToolDiffView } from './toolRenderers/ToolDiffView';
import { countToolGroup, isExplorationGroup, toolGroupSummaryParts } from '../toolGroupSummary';

function formatDuration(ms: number): string {
	if (ms < 0) ms = 0;
	const seconds = ms / 1000;
	if (seconds < 10) return `${seconds.toFixed(1)}s`;
	if (seconds < 60) return `${Math.round(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, '0')}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Elapsed label for one activity; ticks once per second while it runs. */
function useDurationLabel(activity: UiToolActivity): string | null {
	const running = activity.status === 'running';
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!running || activity.startedAt == null) return;
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [running, activity.startedAt]);
	if (activity.startedAt == null) return null;
	const end = running ? now : activity.endedAt;
	if (end == null) return null;
	return formatDuration(end - activity.startedAt);
}

function ActivityFiles({ files }: { files: string[] }) {
	const { t } = useT();
	const [copied, setCopied] = useState('');
	const copyPath = async (path: string) => {
		try {
			await navigator.clipboard.writeText(path);
			setCopied(path);
			window.setTimeout(() => setCopied((current) => (current === path ? '' : current)), 1200);
		} catch {
			// Clipboard refusal is non-fatal; the path stays selectable as text.
		}
	};
	return <div className="pd-activity-files">{files.map((file) => (
		<button type="button" key={file} className="pd-activity-file" title={file} onClick={() => void copyPath(file)} aria-label={t('chat.tool.copyPath', { path: file })}>
			<Icon name="file" width="12" height="12" />
			<span>{file}</span>
			{copied === file && <span className="pd-activity-file-copied" role="status">{t('chat.tool.pathCopied')}</span>}
		</button>
	))}</div>;
}

export function ToolActivityItem({ activity, onInteract }: { activity: UiToolActivity; onInteract?(): void }) {
	const { t, locale } = useT();
	const detailId = useId();
	// null follows the default. Either user choice wins over every later update.
	const [userExpanded, setUserExpanded] = useDisclosureChoice(`tool:${activity.id}`);
	// Failures stay collapsed like any finished tool (zcode): the head already
	// flags the error via icon, exit code and status; the detail opens on demand.
	const expanded = userExpanded ?? false;
	const [showAll, setShowAll] = useState(false);
	const [wrapLines, setWrapLines] = useState(true);
	const [copyStatus, setCopyStatus] = useState('');
	const [commandCopyStatus, setCommandCopyStatus] = useState('');
	const outputRef = useRef<HTMLPreElement>(null);
	const followsOutput = useRef(true);
	const detail = activity.detail ?? '';
	const command = activity.command?.trim();
	const copy = activityCopy(locale);
	const presentation = activityPresentation(activity, locale);
	const previewLength = 12000;
	const isLong = detail.length > previewLength;
	const duration = useDurationLabel(activity);
	// Keep the newest output visible during execution; allow access to all retained content.
	const showingTail = !showAll && isLong && activity.status === 'running';
	const visibleDetail = showAll ? detail : showingTail ? detail.slice(-previewLength) : detail.slice(0, previewLength);
	useLayoutEffect(() => {
		if (expanded && activity.status === 'running' && followsOutput.current && outputRef.current) {
			outputRef.current.scrollTop = outputRef.current.scrollHeight;
		}
	}, [expanded, visibleDetail, activity.status]);

	async function copyDetail() {
		try {
			await navigator.clipboard.writeText(activity.diff ?? visibleDetail);
			setCopyStatus(t('chat.tool.copied'));
		} catch {
			setCopyStatus(t('chat.tool.copyFailed'));
		}
	}
	async function copyCommand() {
		if (!command) return;
		try { await navigator.clipboard.writeText(command); setCommandCopyStatus(t('chat.tool.copied')); }
		catch { setCommandCopyStatus(t('chat.tool.copyFailed')); }
	}

	const files = activity.files ?? [];
	return (
		<div className={'pd-activity-item is-' + activity.status}>
			<button type="button" className="pd-activity-head" onClick={() => { setUserExpanded(!expanded); onInteract?.(); }} aria-expanded={expanded} aria-controls={detailId}>
				<span className={'pd-activity-icon is-' + activity.status} aria-hidden="true"><Icon name={activity.status === 'done' ? 'check' : activity.status === 'error' ? 'close' : activity.status === 'interrupted' ? 'square' : activity.tool === 'bash' ? 'terminal' : 'file'} width="14" height="14" /></span>
				<span className="pd-activity-copy"><span className="pd-activity-kind" title={activity.tool}><ActivityLabel active={activity.status === 'running'}>{presentation.label}</ActivityLabel></span>{presentation.summary && <span className="pd-activity-title" title={presentation.summary}>{presentation.summary}</span>}</span>
				{activity.exitCode != null && activity.exitCode !== 0 && <span className="pd-activity-exit is-error">{t('chat.tool.exitCode', { code: activity.exitCode })}</span>}
				{duration && <span className="pd-activity-duration">{duration}</span>}
				<span className={'pd-activity-status is-' + activity.status}>{t('chat.tool.' + activity.status)}</span>
				<Icon name="chevronDown" className={'pd-chevron' + (expanded ? ' is-open' : '')} width="14" height="14" />
			</button>
			<ActivityDisclosure id={detailId} expanded={expanded}>
				<div className="pd-activity-detail">
					{command && <div className="pd-activity-command">
						<div className="pd-activity-output-heading"><span>{copy.command}</span><div className="pd-activity-output-actions"><button type="button" onClick={() => setWrapLines(value => !value)} aria-label={copy.wrapCommand} aria-pressed={wrapLines}>{t(wrapLines ? 'chat.tool.unwrap' : 'chat.tool.wrap')}</button><button type="button" onClick={() => void copyCommand()} aria-label={copy.copyCommand}>{t('chat.tool.copy')}</button></div></div>
						<pre className={'pd-activity-output pd-activity-command-text' + (wrapLines ? ' is-wrapped' : '')}>{command}</pre>
						{commandCopyStatus && <span className="pd-activity-copy-status" role="status">{commandCopyStatus}</span>}
					</div>}
					{files.length > 0 && <ActivityFiles files={files} />}
					{activity.diff ? <>
						<div className="pd-activity-output-heading">
							<span>{t('chat.tool.diffOutput')}</span>
							<div className="pd-activity-output-actions">
								<button type="button" onClick={() => void copyDetail()} aria-label={t('chat.tool.copyLabel', { tool: activity.tool })}>{t('chat.tool.copy')}</button>
							</div>
						</div>
						<ToolDiffView diff={activity.diff} />
						{copyStatus && <span className="pd-activity-copy-status" role="status">{copyStatus}</span>}
					</> : detail ? <>
						<div className="pd-activity-output-heading">
							<span>{t(activity.status === 'error' ? 'chat.tool.errorOutput' : activity.status === 'interrupted' ? 'chat.tool.interruptedOutput' : activity.status === 'running' ? 'chat.tool.liveOutput' : 'chat.tool.result')}</span>
							<div className="pd-activity-output-actions">
								<button type="button" onClick={() => setWrapLines((value) => !value)} aria-label={t('chat.tool.wrapLabel', { tool: activity.tool })} aria-pressed={wrapLines}>{t(wrapLines ? 'chat.tool.unwrap' : 'chat.tool.wrap')}</button>
								<button type="button" onClick={() => void copyDetail()} aria-label={t('chat.tool.copyLabel', { tool: activity.tool })}>{t('chat.tool.copy')}</button>
							</div>
						</div>
						{showingTail && <p className="pd-activity-note">{t('chat.tool.latestOutput')}</p>}
						<pre ref={outputRef} className={'pd-activity-output' + (wrapLines ? ' is-wrapped' : '')} onScroll={() => {
							const node = outputRef.current;
							if (node) followsOutput.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
						}}>{visibleDetail}</pre>
						{isLong && <button type="button" className="pd-activity-show-all" onClick={() => setShowAll((value) => !value)}>{showAll ? t('chat.tool.collapseOutput') : t('chat.tool.expandOutput', { count: detail.length.toLocaleString(locale) })}</button>}
						{activity.detailTruncated && <p className="pd-activity-note is-warning">{t('chat.tool.truncated')}</p>}
						{copyStatus && <span className="pd-activity-copy-status" role="status">{copyStatus}</span>}
					</> : <p className="pd-activity-no-output">{t(activity.status === 'running' ? 'chat.tool.waiting' : 'chat.tool.noOutput')}</p>}
				</div>
			</ActivityDisclosure>
		</div>
	);
}

/** pi-subagents child-agent card (zcode-style): agent, task, live progress, output reference. */
const SubagentActivityItem = memo(function SubagentActivityItem({ activity }: { activity: UiToolActivity }) {
	const { t } = useT();
	const detailId = useId();
	const [userExpanded, setUserExpanded] = useDisclosureChoice(`tool:${activity.id}`);
	const running = activity.status === 'running';
	const expanded = userExpanded ?? running;
	const sub = activity.subagent!;
	const duration = useDurationLabel(activity);
	const detail = activity.detail ?? '';
	const tokens = sub.tokens != null ? (sub.tokens >= 1000 ? `${(sub.tokens / 1000).toFixed(1)}K` : String(sub.tokens)) : null;
	const recent = sub.recentTools ?? [];
	return (
		<div className={'pd-activity-item pd-subagent-item is-' + activity.status}>
			<button type="button" className="pd-activity-head" onClick={() => { setUserExpanded(!expanded); }} aria-expanded={expanded} aria-controls={detailId}>
				<span className={'pd-activity-icon is-' + activity.status} aria-hidden="true"><Icon name="plugins" width="14" height="14" /></span>
				<span className="pd-activity-copy">
					<span className="pd-activity-kind" title={activity.tool}><ActivityLabel active={running}>{t('chat.subagent.label')}</ActivityLabel></span>
					<span className="pd-subagent-agent">{sub.agent}</span>
					{sub.async === true && <span className="pd-subagent-async-tag">{t('chat.subagent.asyncTag')}</span>}
					{sub.model && <span className="pd-subagent-model" title={sub.model}>{sub.model}</span>}
				</span>
				{running && sub.turnCount != null && <span className="pd-subagent-progress">{t('chat.subagent.progress', { turn: sub.turnCount, tools: sub.toolCount ?? 0 })}</span>}
				{tokens && <span className="pd-subagent-tokens">{tokens}</span>}
				{duration && <span className="pd-activity-duration">{duration}</span>}
				<span className={'pd-activity-status is-' + activity.status}>{t(running && sub.async === true ? 'chat.subagent.background' : 'chat.tool.' + activity.status)}</span>
				<Icon name="chevronDown" className={'pd-chevron' + (expanded ? ' is-open' : '')} width="14" height="14" />
			</button>
			<ActivityDisclosure id={detailId} expanded={expanded}>
				<div className="pd-activity-detail pd-subagent-detail">
					{sub.task && <p className="pd-subagent-task" title={sub.task}>{sub.task}</p>}
					{running && sub.currentTool && <p className="pd-subagent-current">{t('chat.subagent.currentTool')}：<code>{sub.currentTool}</code></p>}
					{sub.async === true && <p className="pd-subagent-async-hint">{t('chat.subagent.asyncHint')}</p>}
					{sub.runId && <p className="pd-subagent-runid" title={sub.runId}>run {sub.runId.slice(0, 8)}</p>}
					{recent.length > 0 && <div className="pd-subagent-recent">{recent.map((item, index) => <span key={index} className="pd-subagent-recent-chip" title={item.args}>{item.tool}</span>)}</div>}
					{sub.outputReference && <div className="pd-subagent-output">
						<span>{t('chat.subagent.output')}</span>
						<code title={sub.outputReference}>{sub.outputReference}</code>
					</div>}
					{detail ? <pre className="pd-activity-output is-wrapped">{detail}</pre> : <p className="pd-activity-no-output">{t(running ? 'chat.tool.waiting' : 'chat.tool.noOutput')}</p>}
				</div>
			</ActivityDisclosure>
		</div>
	);
});

export const ToolActivityPanel = memo(function ToolActivityPanel({ sourceActivities, indices, inline = false }: { sourceActivities: UiToolActivity[]; indices: number[]; inline?: boolean }) {
	const { t, locale } = useT();
	const detailId = useId();
	const activities = indices.map((index) => sourceActivities[index]).filter((activity): activity is UiToolActivity => Boolean(activity));
	const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
	const runningCount = activities.filter((activity) => activity.status === 'running').length;
	const failedCount = activities.filter((activity) => activity.status === 'error').length;
	const interruptedCount = activities.filter((activity) => activity.status === 'interrupted').length;
	const expanded = userExpanded ?? runningCount > 0;
	// "Read 3 files · 2 searches" reads better than "5 tools" (ZCode explore grouping).
	const counts = countToolGroup(activities);
	const semantic = toolGroupSummaryParts(counts, locale);
	const exploring = isExplorationGroup(counts);
	const summary = [
		...(semantic.length ? semantic : [t('chat.tool.count', { count: activities.length })]),
		runningCount > 0 ? t('chat.tool.runningCount', { count: runningCount }) : null,
		failedCount > 0 ? t('chat.tool.failedCount', { count: failedCount }) : null,
		interruptedCount > 0 ? t('chat.tool.interruptedCount', { count: interruptedCount }) : null,
	].filter(Boolean).join(' · ');
	if (activities.length === 0) return null;
	if (inline) return <div className="pd-activity-list is-inline" aria-label={t('chat.tool.activity')}>{activities.map(activity => activity.subagent ? <SubagentActivityItem key={activity.id} activity={activity} /> : <ToolActivityItem key={activity.id} activity={activity} />)}</div>;
	return (
		<section className="pd-activity-group" aria-label={t('chat.tool.activity')}>
			<button type="button" className="pd-activity-summary" onClick={() => setUserExpanded(!expanded)} aria-expanded={expanded} aria-controls={detailId}>
				<Icon name={runningCount ? 'terminal' : failedCount ? 'close' : interruptedCount ? 'square' : 'check'} width="15" height="15" />
				<ActivityLabel active={runningCount > 0}>{t(runningCount ? (exploring ? 'chat.tool.exploring' : 'chat.tool.working') : exploring ? 'chat.tool.explored' : 'chat.tool.activity')}</ActivityLabel>
				<span className={'pd-activity-summary-count' + (failedCount ? ' is-error' : interruptedCount ? ' is-interrupted' : '')}>{summary}</span>
				<Icon name="chevronDown" className={'pd-chevron' + (expanded ? ' is-open' : '')} width="14" height="14" />
			</button>
			<ActivityDisclosure id={detailId} expanded={expanded}>
				<div className="pd-activity-list">{activities.map((activity) => activity.subagent ? <SubagentActivityItem key={activity.id} activity={activity} /> : <ToolActivityItem key={activity.id} activity={activity} onInteract={() => setUserExpanded(true)} />)}</div>
			</ActivityDisclosure>
		</section>
	);
});
