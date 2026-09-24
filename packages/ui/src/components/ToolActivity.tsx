import { memo, useId, useLayoutEffect, useRef, useState } from 'react';
import type { UiToolActivity } from '@pidesktop/shared';
import { useT } from '../i18n';
import { ActivityDisclosure, ActivityLabel } from './ActivityDisclosure';
import { Icon } from './Icons';

export function ToolActivityItem({ activity, onInteract }: { activity: UiToolActivity; onInteract?(): void }) {
	const { t, locale } = useT();
	const detailId = useId();
	// null follows the default. Either user choice wins over every later update.
	const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
	const expanded = userExpanded ?? (activity.status === 'error' || activity.status === 'interrupted');
	const [showAll, setShowAll] = useState(false);
	const [wrapLines, setWrapLines] = useState(true);
	const [copyStatus, setCopyStatus] = useState('');
	const outputRef = useRef<HTMLPreElement>(null);
	const followsOutput = useRef(true);
	const detail = activity.detail ?? '';
	const previewLength = 12000;
	const isLong = detail.length > previewLength;
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
			await navigator.clipboard.writeText(visibleDetail);
			setCopyStatus(t('chat.tool.copied'));
		} catch {
			setCopyStatus(t('chat.tool.copyFailed'));
		}
	}

	return (
		<div className={'pd-activity-item is-' + activity.status}>
			<button type="button" className="pd-activity-head" onClick={() => { setUserExpanded(!expanded); onInteract?.(); }} aria-expanded={expanded} aria-controls={detailId}>
				<span className={'pd-activity-icon is-' + activity.status} aria-hidden="true"><Icon name={activity.status === 'done' ? 'check' : activity.status === 'error' ? 'close' : activity.status === 'interrupted' ? 'square' : activity.tool === 'bash' ? 'terminal' : 'file'} width="14" height="14" /></span>
				<span className="pd-activity-copy"><ActivityLabel active={activity.status === 'running'}>{activity.tool}</ActivityLabel><span className="pd-activity-title" title={activity.title}>{activity.title}</span></span>
				<span className={'pd-activity-status is-' + activity.status}>{t('chat.tool.' + activity.status)}</span>
				<Icon name="chevronDown" className={'pd-chevron' + (expanded ? ' is-open' : '')} width="14" height="14" />
			</button>
			<ActivityDisclosure id={detailId} expanded={expanded}>
				<div className="pd-activity-detail">
					{detail ? <>
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

export const ToolActivityPanel = memo(function ToolActivityPanel({ sourceActivities, indices }: { sourceActivities: UiToolActivity[]; indices: number[] }) {
	const { t } = useT();
	const detailId = useId();
	const activities = indices.map((index) => sourceActivities[index]).filter((activity): activity is UiToolActivity => Boolean(activity));
	const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
	const runningCount = activities.filter((activity) => activity.status === 'running').length;
	const failedCount = activities.filter((activity) => activity.status === 'error').length;
	const interruptedCount = activities.filter((activity) => activity.status === 'interrupted').length;
	const expanded = userExpanded ?? (runningCount > 0 || failedCount > 0 || interruptedCount > 0);
	const summary = [
		t('chat.tool.count', { count: activities.length }),
		runningCount > 0 ? t('chat.tool.runningCount', { count: runningCount }) : null,
		failedCount > 0 ? t('chat.tool.failedCount', { count: failedCount }) : null,
		interruptedCount > 0 ? t('chat.tool.interruptedCount', { count: interruptedCount }) : null,
	].filter(Boolean).join(' · ');
	if (activities.length === 0) return null;
	return (
		<section className="pd-activity-group" aria-label={t('chat.tool.activity')}>
			<button type="button" className="pd-activity-summary" onClick={() => setUserExpanded(!expanded)} aria-expanded={expanded} aria-controls={detailId}>
				<Icon name={runningCount ? 'terminal' : failedCount ? 'close' : interruptedCount ? 'square' : 'check'} width="15" height="15" />
				<ActivityLabel active={runningCount > 0}>{t(runningCount ? 'chat.tool.working' : 'chat.tool.activity')}</ActivityLabel>
				<span className={'pd-activity-summary-count' + (failedCount ? ' is-error' : interruptedCount ? ' is-interrupted' : '')}>{summary}</span>
				<Icon name="chevronDown" className={'pd-chevron' + (expanded ? ' is-open' : '')} width="14" height="14" />
			</button>
			<ActivityDisclosure id={detailId} expanded={expanded}>
				<div className="pd-activity-list">{activities.map((activity) => <ToolActivityItem key={activity.id} activity={activity} onInteract={() => setUserExpanded(true)} />)}</div>
			</ActivityDisclosure>
		</section>
	);
});
