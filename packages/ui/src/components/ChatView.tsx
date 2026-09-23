import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { UiMessage, UiToolActivity } from '@pidesktop/shared';
import { useT } from '../i18n';
import { useChatStore } from '../store';
import { Composer } from './Composer';
import { ExtensionDialogHost } from './ExtensionDialogHost';
import { Icon } from './Icons';
import { MessageItem } from './MessageItem';

function ToolActivityItem({ activity }: { activity: UiToolActivity }) {
	const { t, locale } = useT();
	const detailId = useId();
	const [expanded, setExpanded] = useState(activity.status === 'error');
	const [showAll, setShowAll] = useState(false);
	const [wrapLines, setWrapLines] = useState(true);
	const [copyStatus, setCopyStatus] = useState('');
	const detail = activity.detail ?? '';
	const previewLength = 12000;
	const isLong = detail.length > previewLength;
	const visibleDetail = showAll ? detail : detail.slice(0, previewLength);

	useEffect(() => {
		if (activity.status === 'error') setExpanded(true);
	}, [activity.status]);

	async function copyDetail() {
		try {
			await navigator.clipboard.writeText(visibleDetail);
			setCopyStatus(t('chat.tool.copied'));
		} catch {
			setCopyStatus(t('chat.tool.copyFailed'));
		}
	}

	return (
		<div className={`pd-tool-item is-${activity.status}`}>
			<button type="button" className="pd-tool-item-head" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls={detailId}>
				<span className={`pd-tool-state is-${activity.status}`} aria-hidden="true" />
				<span className="pd-tool-item-copy">
					<span className="pd-tool-item-name">{activity.tool}</span>
					<span className="pd-tool-item-title" title={activity.title}>{activity.title}</span>
				</span>
				<span className={`pd-tool-status is-${activity.status}`}>{t(`chat.tool.${activity.status}`)}</span>
				<Icon name="chevronDown" className={`pd-chevron${expanded ? ' is-open' : ''}`} width="16" height="16" />
			</button>
			{expanded && (
				<div className="pd-tool-item-detail" id={detailId}>
					{detail ? (
						<>
							<div className="pd-tool-output-heading">
								<span>{t(activity.status === 'error' ? 'chat.tool.errorOutput' : activity.status === 'running' ? 'chat.tool.liveOutput' : 'chat.tool.result')}</span>
								<div className="pd-tool-output-actions">
									<button type="button" onClick={() => setWrapLines((value) => !value)} aria-label={t('chat.tool.wrapLabel', { tool: activity.tool })} aria-pressed={wrapLines}>{t(wrapLines ? 'chat.tool.unwrap' : 'chat.tool.wrap')}</button>
									<button type="button" onClick={() => void copyDetail()} aria-label={t('chat.tool.copyLabel', { tool: activity.tool })}>{t('chat.tool.copy')}</button>
								</div>
							</div>
							<pre className={`pd-tool-output${wrapLines ? ' is-wrapped' : ''}`}>{visibleDetail}</pre>
							{isLong && <button type="button" className="pd-tool-show-all" onClick={() => setShowAll((value) => !value)}>{showAll ? t('chat.tool.collapseOutput') : t('chat.tool.expandOutput', { count: detail.length.toLocaleString(locale) })}</button>}
							{activity.detailTruncated && <p className="pd-tool-truncated">{t('chat.tool.truncated')}</p>}
							{copyStatus && <span className="pd-tool-copy-status" role="status">{copyStatus}</span>}
						</>
					) : <p className="pd-tool-no-output">{t(activity.status === 'running' ? 'chat.tool.waiting' : 'chat.tool.noOutput')}</p>}
				</div>
			)}
		</div>
	);
}

function ToolActivityPanel({ activities }: { activities: UiToolActivity[] }) {
	const { t } = useT();
	const [expanded, setExpanded] = useState(() => activities.some((activity) => activity.status === 'running' || activity.status === 'error'));
	const runningCount = activities.filter((activity) => activity.status === 'running').length;
	const failedCount = activities.filter((activity) => activity.status === 'error').length;

	useEffect(() => {
		if (runningCount > 0 || failedCount > 0) setExpanded(true);
	}, [runningCount, failedCount]);

	if (activities.length === 0) return null;

	return (
		<section className="pd-tool-panel" aria-label={t('chat.tool.activity')}>
			<button type="button" className="pd-tool-summary" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
				<Icon name="spark" width="16" height="16" />
				<span>{t('chat.tool.activity')}</span>
				<span className="pd-tool-summary-count">{t('chat.tool.count', { count: activities.length })}{runningCount > 0 ? ` · ${t('chat.tool.runningCount', { count: runningCount })}` : failedCount > 0 ? ` · ${t('chat.tool.failedCount', { count: failedCount })}` : ''}</span>
				<Icon name="chevronDown" className={`pd-chevron pd-tool-chevron${expanded ? ' is-open' : ''}`} width="16" height="16" />
			</button>
			{expanded && (
				<div className="pd-tool-list">
					{activities.map((activity) => <ToolActivityItem key={activity.id} activity={activity} />)}
				</div>
			)}
		</section>
	);
}

type TimelineEntry =
	| { kind: 'message'; id: string; order: number; message: UiMessage }
	| { kind: 'tools'; id: string; order: number; activities: UiToolActivity[] };

function buildTimeline(messages: UiMessage[], activities: UiToolActivity[]): TimelineEntry[] {
	const ordered = [
		...messages.map((message) => ({ kind: 'message' as const, order: message.order, message })),
		...activities.map((activity) => ({ kind: 'tool' as const, order: activity.order, activity })),
	].sort((a, b) => a.order - b.order);
	const timeline: TimelineEntry[] = [];
	for (const item of ordered) {
		if (item.kind === 'message') {
			timeline.push({ kind: 'message', id: item.message.id, order: item.order, message: item.message });
			continue;
		}
		const previous = timeline.at(-1);
		if (previous?.kind === 'tools') previous.activities.push(item.activity);
		else timeline.push({ kind: 'tools', id: item.activity.id, order: item.order, activities: [item.activity] });
	}
	return timeline;
}

function EmptyState() {
	const { t } = useT();
	return (
		<div className="pd-empty-state">
			<div className="pd-empty-mark" aria-hidden="true">π</div>
			<h1>{t('chat.empty.title')}</h1>
			<p>{t('chat.empty.description')}</p>
			<div className="pd-empty-hints"><span>{t('chat.empty.sendHint')}</span><span>{t('chat.empty.newlineHint')}</span></div>
		</div>
	);
}

export function ChatView({ onToggleSidebar }: { onToggleSidebar(): void }) {
	const { t } = useT();
	const messages = useChatStore((s) => s.messages);
	const activities = useChatStore((s) => s.activities);
	const sessions = useChatStore((s) => s.sessions);
	const sessionPath = useChatStore((s) => s.sessionPath);
	const cwd = useChatStore((s) => s.cwd);
	const error = useChatStore((s) => s.error);
	const timeline = useMemo(() => buildTimeline(messages, activities), [messages, activities]);
	const scrollRef = useRef<HTMLDivElement>(null);
	const followsBottomRef = useRef(true);
	const [showBackToBottom, setShowBackToBottom] = useState(false);
	const activeSession = sessions.find((session) => session.path === sessionPath);
	const firstUserText = messages.find((message) => message.role === 'user')?.text;
	const title = activeSession?.name?.trim() || activeSession?.firstMessage?.trim().split(/\r?\n/)[0] || firstUserText?.trim().split(/\r?\n/)[0] || t('chat.newSession');
	useLayoutEffect(() => {
		if (followsBottomRef.current && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [messages, activities, error]);

	useLayoutEffect(() => {
		followsBottomRef.current = true;
		setShowBackToBottom(false);
		if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
	}, [sessionPath]);

	function handleScroll() {
		const node = scrollRef.current;
		if (!node) return;
		const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 72;
		followsBottomRef.current = nearBottom;
		setShowBackToBottom(!nearBottom);
	}

	function scrollToBottom() {
		const node = scrollRef.current;
		if (!node) return;
		followsBottomRef.current = true;
		setShowBackToBottom(false);
		node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
	}

	return (
		<main className="pd-main">
			<header className="pd-chat-header">
				<button type="button" className="pd-icon-button pd-header-sidebar-toggle" onClick={onToggleSidebar} aria-label={t('chat.toggleSidebar')} title={t('chat.toggleSidebar')}><Icon name="panel" /></button>
				<div className="pd-chat-heading"><span className="pd-chat-workspace-icon" title={cwd || t('chat.workspace')}><Icon name="folder" width="16" height="16" /></span><h1 title={title}>{title}</h1></div>
			</header>

			<div className="pd-chat-content">
				<div ref={scrollRef} className="pd-transcript" onScroll={handleScroll}>
					{timeline.length === 0 ? <EmptyState /> : (
						<div className="pd-message-list">
							{timeline.map((entry) => entry.kind === 'message'
								? <MessageItem key={`message-${entry.id}`} message={entry.message} />
								: <div className="pd-timeline-tool-group" key={`tools-${entry.id}`}><div className="pd-message-column"><ToolActivityPanel activities={entry.activities} /></div></div>)}
						</div>
					)}
					{error && <div className="pd-transcript-end">
						<div className="pd-error-banner" role="alert"><strong>{t('chat.error')}</strong><span>{error}</span></div>
					</div>}
				</div>
				{showBackToBottom && <button type="button" className="pd-back-to-bottom" onClick={scrollToBottom}>{t('chat.backToBottom')}</button>}
			</div>
			<Composer />
			<ExtensionDialogHost />
		</main>
	);
}
