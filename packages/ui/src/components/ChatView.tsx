import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n';
import { useChatStore } from '../store';
import type { ModelManagementTarget } from '../modelManagement';
import { buildTimelineLayout, type TimelineEntry } from '../timeline';
import { Composer } from './Composer';
import { ChatTitle, type ChatTitleHandle } from './ChatTitle';
import { ChatHeaderMenu } from './ChatHeaderMenu';
import { ChatCommitDialog } from './ChatCommitDialog';
import { WorkspaceFolderButton } from './WorkspaceFolderButton';
import { Icon } from './Icons';
import { HoverTooltip } from './HoverTooltip';
import { MessageItem } from './MessageItem';
import { ToolActivityPanel } from './ToolActivity';
import { ActivityLabel } from './ActivityDisclosure';

const BOTTOM_THRESHOLD = 24;
const SCROLL_TO_BOTTOM_DURATION = 260;

function EmptyState() {
	const { t } = useT();
	return (
		<div className="pd-empty-state">
			<svg className="pd-empty-mark" viewBox="0 0 224 224" aria-hidden="true" focusable="false">
				<path d="M52 72h120v24H52zM68 92h24v76c0 12-8 20-20 20h-4V92zm72 0h24v76c0 12-8 20-20 20h-4V92z" />
				<circle cx="168" cy="164" r="12" />
			</svg>
			<h1>{t('chat.empty.title')}</h1>
		</div>
	);
}

export interface SearchMessageTarget { sessionPath: string; messageId: string; snippet?: string; requestId: number }

export function ChatView({ onToggleSidebar, onOpenModelManagement, searchTarget, historyControls, navigationError }: { onToggleSidebar(): void; onOpenModelManagement(target: ModelManagementTarget): void; searchTarget?: SearchMessageTarget | null; historyControls?: ReactNode; navigationError?: string | null }) {
	const { t } = useT();
	const messages = useChatStore((s) => s.messages);
	const activities = useChatStore((s) => s.activities);
	const sessions = useChatStore((s) => s.sessions);
	const sessionPath = useChatStore((s) => s.sessionPath);
	const sessionId = useChatStore((s) => s.sessionId);
	const cwd = useChatStore((s) => s.cwd);
	const agentError = useChatStore((s) => s.error);
	const agentStatus = useChatStore((s) => s.status);
	const error = navigationError ?? agentError;
	const timelineRevision = useChatStore((s) => s.timelineRevision);
	const timelineRef = useRef<{ revision: number; entries: TimelineEntry[] } | null>(null);
	if (timelineRef.current?.revision !== timelineRevision) {
		timelineRef.current = { revision: timelineRevision, entries: buildTimelineLayout(messages, activities) };
	}
	const timeline = timelineRef.current.entries;
	const isEmpty = timeline.length === 0 && !error;
	const awaitingResponse = agentStatus === 'busy' && !error && !messages.some((message) => message.status === 'streaming') && !activities.some((activity) => activity.status === 'running');
	const bodyRef = useRef<HTMLDivElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const messageListRef = useRef<HTMLDivElement>(null);
	const followsBottomRef = useRef(true);
	const scrollAnimationRef = useRef<number | null>(null);
	const [showBackToBottom, setShowBackToBottom] = useState(false);
	const handledSearchRequest = useRef<number | null>(null);
	const [highlightedMessage, setHighlightedMessage] = useState<SearchMessageTarget | null>(null);
	const activeSession = sessions.find((session) => session.path === sessionPath);
	const firstUserText = messages.find((message) => message.role === 'user')?.text;
	const title = activeSession?.name?.trim() || activeSession?.firstMessage?.trim().split(/\r?\n/)[0] || firstUserText?.trim().split(/\r?\n/)[0] || t('chat.newSession');
	useLayoutEffect(() => {
		if (followsBottomRef.current && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [messages, activities, error, awaitingResponse]);

	useLayoutEffect(() => {
		const list = messageListRef.current;
		if (!list) return;
		// Disclosure transitions keep changing layout after the data update.
		const observer = new ResizeObserver(() => {
			const node = scrollRef.current;
			if (!node) return;
			if (followsBottomRef.current) node.scrollTop = node.scrollHeight;
			setShowBackToBottom(node.scrollHeight - node.scrollTop - node.clientHeight > BOTTOM_THRESHOLD);
		});
		observer.observe(list);
		if (scrollRef.current) observer.observe(scrollRef.current);
		return () => observer.disconnect();
	}, [isEmpty]);

	useLayoutEffect(() => {
		cancelScrollAnimation();
		followsBottomRef.current = true;
		setShowBackToBottom(false);
		if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
	}, [sessionId, sessionPath]);

	useEffect(() => () => cancelScrollAnimation(), []);

	useLayoutEffect(() => {
		// Empty drafts can scroll as a whole; clear that offset when the dock moves.
		if (bodyRef.current) bodyRef.current.scrollTop = 0;
	}, [isEmpty, sessionId]);

	useLayoutEffect(() => {
		if (!searchTarget || searchTarget.sessionPath !== sessionPath || handledSearchRequest.current === searchTarget.requestId) return;
		const transcript = scrollRef.current;
		// Live messages have transient IDs until history is reloaded. Locate the
		// same visible text when a persisted search hit points at such a message.
		const normalize = (text: string) => text.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
		const snippet = normalize((searchTarget.snippet ?? '').replace(/^(?:…|\.{3})|(?:…|\.{3})$/g, ''));
		const targetId = messages.some((message) => message.id === searchTarget.messageId)
			? searchTarget.messageId
			: snippet ? messages.find((message) => normalize(message.text).includes(snippet))?.id : undefined;
		const message = targetId ? transcript?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(targetId)}"]`) : null;
		if (!transcript || !message) return;
		cancelScrollAnimation();
		handledSearchRequest.current = searchTarget.requestId;
		followsBottomRef.current = false;
		setHighlightedMessage({ ...searchTarget, messageId: targetId! });
		message.scrollIntoView({ block: 'center', behavior: 'auto' });
		setShowBackToBottom(transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight > BOTTOM_THRESHOLD);
	}, [searchTarget, sessionPath, messages]);

	useEffect(() => {
		if (!highlightedMessage) return;
		const timer = window.setTimeout(() => setHighlightedMessage(null), 3000);
		return () => window.clearTimeout(timer);
	}, [highlightedMessage]);

	function handleScroll() {
		const node = scrollRef.current;
		if (!node) return;
		const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_THRESHOLD;
		if (scrollAnimationRef.current === null) followsBottomRef.current = nearBottom;
		setShowBackToBottom(!nearBottom);
	}

	function cancelScrollAnimation() {
		if (scrollAnimationRef.current === null) return;
		cancelAnimationFrame(scrollAnimationRef.current);
		scrollAnimationRef.current = null;
	}

	function scrollToBottom() {
		const node = scrollRef.current;
		if (!node) return;
		cancelScrollAnimation();
		const start = node.scrollTop;
		const finish = () => {
			scrollAnimationRef.current = null;
			followsBottomRef.current = true;
			node.scrollTop = node.scrollHeight;
			setShowBackToBottom(false);
		};
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || node.scrollHeight - node.clientHeight - start <= BOTTOM_THRESHOLD) {
			finish();
			return;
		}
		// Keep stream/layout updates from jumping ahead of the scroll animation.
		followsBottomRef.current = false;
		const started = performance.now();
		const tick = (now: number) => {
			const progress = Math.min(1, (now - started) / SCROLL_TO_BOTTOM_DURATION);
			if (progress >= 1) { finish(); return; }
			const target = Math.max(0, node.scrollHeight - node.clientHeight);
			node.scrollTop = start + (target - start) * (1 - (1 - progress) ** 3);
			scrollAnimationRef.current = requestAnimationFrame(tick);
		};
		scrollAnimationRef.current = requestAnimationFrame(tick);
	}

	const titleRef = useRef<ChatTitleHandle>(null);
	const [commitOpen, setCommitOpen] = useState(false);

	return (
		<main className={`pd-main${isEmpty ? ' is-empty' : ''}`}>
			<header className="pd-chat-header">
				{historyControls}
				<HoverTooltip title={t('chat.toggleSidebar')}><button type="button" className="pd-icon-button pd-header-sidebar-toggle" onClick={onToggleSidebar} aria-label={t('chat.toggleSidebar')}><Icon name="panel" /></button></HoverTooltip>
				<div className="pd-chat-heading"><WorkspaceFolderButton key={`folder:${cwd}\0${sessionId}`} cwd={cwd} /><ChatTitle key={`${cwd}\0${sessionId}`} ref={titleRef} title={title} sessionPath={sessionPath} /><ChatHeaderMenu title={title} sessionPath={sessionPath} cwd={cwd} onRename={() => titleRef.current?.beginRename()} onOpenCommit={() => setCommitOpen(true)} /></div>
			</header>

			<div ref={bodyRef} className={`pd-conversation-body${isEmpty ? ' is-empty' : ''}`}>
				<div className="pd-chat-content">
					<div ref={scrollRef} className="pd-transcript" onScroll={handleScroll} onWheel={cancelScrollAnimation} onTouchStart={cancelScrollAnimation} onPointerDown={cancelScrollAnimation} onKeyDown={(event) => {
						if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) cancelScrollAnimation();
					}}>
						{isEmpty ? <EmptyState /> : (
							<div ref={messageListRef} className="pd-message-list">
								{timeline.map((entry) => entry.kind === 'message'
									? <MessageItem key={`message-${entry.id}`} message={messages[entry.index]!} highlighted={highlightedMessage?.sessionPath === sessionPath && highlightedMessage.messageId === entry.id} />
									: <div className="pd-timeline-tool-group" key={`tools-${entry.id}`}><div className="pd-message-column"><ToolActivityPanel sourceActivities={activities} indices={entry.indices} /></div></div>)}
							</div>
						)}
						{awaitingResponse && <div className="pd-transcript-end"><div className="pd-message-column"><div className="pd-response-pending" role="status"><ActivityLabel active>{t('message.preparing')}</ActivityLabel></div></div></div>}
						{error && <div className="pd-transcript-end">
							<div className="pd-error-banner" role="alert"><strong>{t(navigationError ? 'navigation.error' : 'chat.error')}</strong><span>{error}</span></div>
						</div>}
					</div>
					<button type="button" className={`pd-back-to-bottom${showBackToBottom ? ' is-visible' : ''}`} aria-label={t('chat.backToBottom')} aria-hidden={!showBackToBottom} tabIndex={showBackToBottom ? 0 : -1} onClick={showBackToBottom ? scrollToBottom : undefined}>
						{agentStatus === 'busy' ? <span className="pd-back-to-bottom-dots" aria-hidden="true"><span /><span /><span /></span> : <Icon name="arrowDown" width="20" height="20" />}
					</button>
				</div>
				<Composer onOpenModelManagement={onOpenModelManagement} />
			</div>
			{commitOpen && <ChatCommitDialog onClose={() => setCommitOpen(false)} />}
		</main>
	);
}
