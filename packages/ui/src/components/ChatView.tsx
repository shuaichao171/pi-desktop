import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { UiToolActivity } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { Composer } from './Composer';
import { Icon } from './Icons';
import { MessageItem } from './MessageItem';

const STATUS_LABEL: Record<string, string> = {
	uninitialized: '连接中',
	starting: '启动中',
	idle: '就绪',
	busy: '工作中',
	error: '出错',
};

function workspaceName(cwd: string): string {
	return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? '工作区';
}

const TOOL_STATUS_LABEL: Record<UiToolActivity['status'], string> = {
	running: '运行中',
	done: '已完成',
	error: '失败',
};

function ToolActivityItem({ activity }: { activity: UiToolActivity }) {
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
			setCopyStatus('已复制');
		} catch {
			setCopyStatus('复制失败');
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
				<span className={`pd-tool-status is-${activity.status}`}>{TOOL_STATUS_LABEL[activity.status]}</span>
				<Icon name="chevronDown" className={`pd-chevron${expanded ? ' is-open' : ''}`} width="16" height="16" />
			</button>
			{expanded && (
				<div className="pd-tool-item-detail" id={detailId}>
					{detail ? (
						<>
							<div className="pd-tool-output-heading">
								<span>{activity.status === 'error' ? '错误输出' : activity.status === 'running' ? '实时输出' : '工具结果'}</span>
								<div className="pd-tool-output-actions">
									<button type="button" onClick={() => setWrapLines((value) => !value)} aria-label={`${activity.tool} 输出自动换行`} aria-pressed={wrapLines}>{wrapLines ? '取消换行' : '自动换行'}</button>
									<button type="button" onClick={() => void copyDetail()} aria-label={`复制 ${activity.tool} 当前显示的输出`}>复制</button>
								</div>
							</div>
							<pre className={`pd-tool-output${wrapLines ? ' is-wrapped' : ''}`}>{visibleDetail}</pre>
							{isLong && <button type="button" className="pd-tool-show-all" onClick={() => setShowAll((value) => !value)}>{showAll ? '收起长输出' : `展开更多输出（已保留 ${detail.length.toLocaleString('zh-CN')} 字符）`}</button>}
							{activity.detailTruncated && <p className="pd-tool-truncated">输出已截断为前 48000 字符。</p>}
							{copyStatus && <span className="pd-tool-copy-status" role="status">{copyStatus}</span>}
						</>
					) : <p className="pd-tool-no-output">{activity.status === 'running' ? '正在等待工具输出…' : '该工具没有文本输出。'}</p>}
				</div>
			)}
		</div>
	);
}

function ToolActivityPanel() {
	const activities = useChatStore((s) => s.activities);
	const [expanded, setExpanded] = useState(false);
	const runningCount = activities.filter((activity) => activity.status === 'running').length;
	const failedCount = activities.filter((activity) => activity.status === 'error').length;

	useEffect(() => {
		if (runningCount > 0) setExpanded(true);
	}, [runningCount]);

	if (activities.length === 0) return null;

	return (
		<section className="pd-tool-panel" aria-label="工具活动">
			<button type="button" className="pd-tool-summary" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
				<Icon name="spark" width="16" height="16" />
				<span>工具活动</span>
				<span className="pd-tool-summary-count">{activities.length} 条{runningCount > 0 ? ` · ${runningCount} 运行中` : failedCount > 0 ? ` · ${failedCount} 失败` : ''}</span>
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

function EmptyState() {
	return (
		<div className="pd-empty-state">
			<div className="pd-empty-mark" aria-hidden="true">π</div>
			<h1>从这里开始</h1>
			<p>描述你想完成的工作。Pi 可以阅读代码、修改文件并运行命令。</p>
			<div className="pd-empty-hints"><span>Enter 发送</span><span>Shift + Enter 换行</span></div>
		</div>
	);
}

export function ChatView({ onToggleSidebar, onOpenSettings }: { onToggleSidebar(): void; onOpenSettings(): void }) {
	const messages = useChatStore((s) => s.messages);
	const activities = useChatStore((s) => s.activities);
	const sessions = useChatStore((s) => s.sessions);
	const sessionPath = useChatStore((s) => s.sessionPath);
	const status = useChatStore((s) => s.status);
	const model = useChatStore((s) => s.model);
	const statusMessage = useChatStore((s) => s.statusMessage);
	const queuedCount = useChatStore((s) => s.queuedCount);
	const cwd = useChatStore((s) => s.cwd);
	const error = useChatStore((s) => s.error);
	const scrollRef = useRef<HTMLDivElement>(null);
	const followsBottomRef = useRef(true);
	const [showBackToBottom, setShowBackToBottom] = useState(false);
	const activeSession = sessions.find((session) => session.path === sessionPath);
	const firstUserText = messages.find((message) => message.role === 'user')?.text;
	const title = activeSession?.name?.trim() || activeSession?.firstMessage?.trim().split(/\r?\n/)[0] || firstUserText?.trim().split(/\r?\n/)[0] || '新会话';
	const statusDetail = statusMessage?.replace(/^auto retry (\d+)\/(\d+)$/, '自动重试 $1/$2');
	const retryDetail = statusDetail?.startsWith('自动重试') ? statusDetail : undefined;
	const needsModel = status === 'idle' && (!model || model === 'unknown');

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
				<button type="button" className="pd-icon-button pd-header-sidebar-toggle" onClick={onToggleSidebar} aria-label="切换侧栏" title="切换侧栏"><Icon name="panel" /></button>
				<div className="pd-chat-heading"><strong title={title}>{title}</strong><span title={cwd}>{cwd ? workspaceName(cwd) : '正在准备工作区'}</span></div>
				<div className={`pd-header-status is-${needsModel ? 'needs-model' : status}`} title={statusDetail}><span className={`pd-status-dot is-${needsModel ? 'needs-model' : status}`} /><span>{needsModel ? '待配置模型' : STATUS_LABEL[status] ?? status}</span>{queuedCount > 0 ? <small>· {queuedCount} 条排队</small> : retryDetail && <small>· {retryDetail}</small>}</div>
				<button type="button" className="pd-icon-button pd-header-settings" onClick={onOpenSettings} aria-label="打开设置" title="设置"><Icon name="settings" width="17" height="17" /></button>
			</header>

			<div className="pd-chat-content">
				<div ref={scrollRef} className="pd-transcript" onScroll={handleScroll}>
					{messages.length === 0 ? <EmptyState /> : (
						<div className="pd-message-list">
							{messages.map((message) => <MessageItem key={message.id} message={message} />)}
						</div>
					)}
					{(activities.length > 0 || error) && <div className="pd-transcript-end">
						<ToolActivityPanel />
						{error && <div className="pd-error-banner" role="alert"><strong>Pi 遇到错误</strong><span>{error}</span></div>}
					</div>}
				</div>
				{showBackToBottom && <button type="button" className="pd-back-to-bottom" onClick={scrollToBottom}>回到底部 ↓</button>}
			</div>
			<Composer />
		</main>
	);
}
