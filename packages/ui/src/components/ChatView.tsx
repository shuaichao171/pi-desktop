import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useT } from '../i18n';
import { useChatStore } from '../store';
import { bindingKeysFor, matchesShortcut } from '../shortcuts/bindings';
import type { ModelManagementTarget } from '../modelManagement';
import { buildConversationTimeline, entryContainsMessage, type ConversationTimelineEntry } from '../conversationTimeline';
import { ConversationDisclosureProvider } from '../conversationDisclosure';
import { ConversationRail } from './ConversationRail';
import { Composer } from './Composer';
import { ComposerChanges } from './ComposerChanges';
import { RunStatusBar } from './RunStatusBar';
import { ComposerContextBar } from './ComposerContextBar';
import { ChatTitle, type ChatTitleHandle } from './ChatTitle';
import { ChatHeaderMenu } from './ChatHeaderMenu';
import { ChatCommitDialog } from './ChatCommitDialog';
import { WorkspaceOpenButton } from './WorkspaceOpenButton';
import { WorkspaceFolderButton } from './WorkspaceFolderButton';
import { Icon } from './Icons';
import { HoverTooltip } from './HoverTooltip';
import { MessageItem } from './MessageItem';
import { ConversationTurn } from './ConversationTurn';
import { ActivityLabel } from './ActivityDisclosure';
import { TranscriptFind } from './TranscriptFind';
import { useConversationCopy } from '../conversationCopy';
import { findOccurrences, readReading, recentReading, readingKey, saveReading, type ReadingPosition } from '../conversationState';
import { locateHistoryMessage } from '../conversationNavigation';
import { TranscriptSearchContext, paintTranscriptMatches, revealTranscriptRange } from '../transcriptSearch';
import './conversationEnhancements.css';

const BOTTOM_THRESHOLD = 24;
const SCROLL_TO_BOTTOM_DURATION = 260;
/** Beyond this many timeline entries the transcript renders through a virtual window. */
const VIRTUALIZE_THRESHOLD = 250;
/** Scrolling closer than this to the top loads one more history page (2.6). */
const LOAD_OLDER_TRIGGER_PX = 600;

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

function SessionLoading() {
	const { t } = useT();
	return (
		<div className="pd-session-loading" role="status" aria-live="polite">
			<svg className="pd-session-loading-mark" viewBox="0 0 224 224" aria-hidden="true" focusable="false">
				<path d="M52 72h120v24H52zM68 92h24v76c0 12-8 20-20 20h-4V92zm72 0h24v76c0 12-8 20-20 20h-4V92z" />
				<circle cx="168" cy="164" r="12" />
			</svg>
			<span>{t('chat.loadingSession')}</span>
		</div>
	);
}

export interface SearchMessageTarget { sessionPath: string; messageId: string; snippet?: string; requestId: number }

export function ChatView({ onToggleSidebar, onOpenModelManagement, searchTarget, historyControls, navigationError }: { onToggleSidebar(): void; onOpenModelManagement(target: ModelManagementTarget): void; searchTarget?: SearchMessageTarget | null; historyControls?: ReactNode; navigationError?: string | null }) {
	const { t } = useT();
	const messages = useChatStore((s) => s.messages);
	const c = useConversationCopy();
	const historyGeneration = useChatStore((s) => s.historyGeneration);
	const activities = useChatStore((s) => s.activities);
	const runs = useChatStore((s) => s.runs);
	const fileChanges = useChatStore((s) => s.fileChanges);
	const [changesDock, setChangesDock] = useState<HTMLDivElement | null>(null);
	const changesRegionRef = useRef<HTMLDivElement>(null);
	const sessions = useChatStore((s) => s.sessions);
	const sessionPath = useChatStore((s) => s.sessionPath);
	const sessionId = useChatStore((s) => s.sessionId);
	const cwd = useChatStore((s) => s.cwd);
	const agentError = useChatStore((s) => s.error);
	const agentStatus = useChatStore((s) => s.status);
	const error = navigationError ?? agentError;
	const timelineRevision = useChatStore((s) => s.timelineRevision);
	const sessionLoading = useChatStore((s) => s.sessionLoading);
	const historyTotal = useChatStore((s) => s.historyTotal);
	const loadingOlder = useChatStore((s) => s.loadingOlder);
	const loadOlderMessages = useChatStore((s) => s.loadOlderMessages);
	const timelineRef = useRef<{ revision: number; runs: typeof runs; entries: ConversationTimelineEntry[] } | null>(null);
	if (timelineRef.current?.revision !== timelineRevision || timelineRef.current.runs !== runs) {
		timelineRef.current = { revision: timelineRevision, runs, entries: buildConversationTimeline(messages, activities, runs) };
	}
	const timeline = timelineRef.current.entries;
	const hasOlderHistory = historyTotal > messages.length + activities.length;
	const isEmpty = timeline.length === 0 && !error && fileChanges.length === 0;
	const awaitingResponse = agentStatus === 'busy' && !runs.some(run => run.status === 'running') && !error && !messages.some((message) => message.status === 'streaming') && !activities.some((activity) => activity.status === 'running');
	const disclosureScope = `${cwd}\0${sessionPath}\0${sessionId}`;
	const [revealMessage, setRevealMessage] = useState<{ id: string; request: number; scope: string } | null>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const messageListRef = useRef<HTMLDivElement>(null);
	const followsBottomRef = useRef(true);
	const scrollAnimationRef = useRef<number | null>(null);
	const [showBackToBottom, setShowBackToBottom] = useState(false);
	const handledSearchRequest = useRef<number | null>(null);
	const [highlightedMessage, setHighlightedMessage] = useState<SearchMessageTarget | null>(null);
	const [locationStatus, setLocationStatus] = useState<'loading' | 'missing' | null>(null);
	const [locationTarget, setLocationTarget] = useState<{ id: string; snippet?: string } | null>(null);
	const locationRequest = useRef<AbortController | null>(null);
	const restoring = useRef(false);
	const readingAnchor = useRef<ReadingPosition | null>(null);
	const memoryKey = readingKey(cwd, sessionPath, messages.at(-1)?.id ?? 'empty');
	const memoryKeyRef = useRef(memoryKey);
	const memoryIdentity = useRef({ cwd, sessionPath, historyGeneration });
	const activeSession = sessions.find((session) => session.path === sessionPath);
	const firstUserText = messages.find((message) => message.role === 'user')?.text;
	const title = activeSession?.name?.trim() || activeSession?.firstMessage?.trim().split(/\r?\n/)[0] || firstUserText?.trim().split(/\r?\n/)[0] || t('chat.newSession');

	// --- In-conversation find (2.5) ---
	const [findOpen, setFindOpen] = useState(false);
	const [findQuery, setFindQuery] = useState('');
	const [findKey, setFindKey] = useState<string | null>(null);
	const findMatches = useMemo(() => findOccurrences(messages, findQuery), [messages, findQuery]);
	const findIndex = Math.max(0, findMatches.findIndex((item) => item.key === findKey));
	const activeFind = findOpen ? findMatches[findIndex] : undefined;
	const activeFindId = activeFind?.messageId ?? null;
	const findMatchSet = useMemo(() => new Set(findMatches.map((item) => item.messageId)), [findMatches]);
	useEffect(() => { if (findOpen && findMatches.length && !findMatches.some((item) => item.key === findKey)) setFindKey(findMatches[0]!.key); }, [findOpen, findMatches, findKey]);
	// Mark the user turns (rail markers) that contain a find hit.
	const railMarkedIds = useMemo(() => {
		if (!findOpen || findMatches.length === 0) return null;
		const marked = new Set<string>();
		let currentUser: string | null = null;
		let segmentHit = false;
		for (const message of messages) {
			if (message.role === 'user') {
				if (currentUser && segmentHit) marked.add(currentUser);
				currentUser = message.id;
				segmentHit = findMatchSet.has(message.id);
			} else if (findMatchSet.has(message.id)) segmentHit = true;
		}
		if (currentUser && segmentHit) marked.add(currentUser);
		return marked;
	}, [findOpen, findMatches.length, findMatchSet, messages]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.isComposing) return;
			if (matchesShortcut(event, bindingKeysFor('findInTranscript'))) {
				event.preventDefault();
				setFindOpen(true);
				return;
			}
			if (matchesShortcut(event, bindingKeysFor('stopGeneration'))) {
				const state = useChatStore.getState();
				if (state.status !== 'busy' || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
				const target = event.target as HTMLElement | null;
				if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
				event.preventDefault();
				void state.abort();
			}
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, []);

	const closeFind = useCallback(() => {
		setFindOpen(false);
		setFindQuery('');
		setFindKey(null);
		document.querySelector<HTMLTextAreaElement>('.pd-composer-shell textarea')?.focus();
	}, []);

	// --- Virtualized transcript (2.6) ---
	const virtualize = timeline.length > VIRTUALIZE_THRESHOLD;
	const estimateSize = useCallback((index: number) => (timeline[index]?.kind === 'turn' ? 180 : 100), [timeline]);
	const virtualizer = useVirtualizer({
		count: timeline.length,
		getScrollElement: () => scrollRef.current,
		useAnimationFrameWithResizeObserver: true,
		estimateSize,
		overscan: 8,
		getItemKey: (index) => {
			const entry = timeline[index]!;
			return (entry.kind === 'message' ? 'm:' : 't:') + entry.id;
		},
	});

	const scrollToRow = useCallback((id: string) => {
		const transcript = scrollRef.current;
		if (!transcript) return false;
		const row = transcript.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
		if (!row || row.closest('[inert],[hidden],[aria-hidden="true"]')) return false;
		row.scrollIntoView({ block: 'center', behavior: 'auto' });
		setShowBackToBottom(transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight > BOTTOM_THRESHOLD);
		return true;
	}, []);

	const jumpToMessage = useCallback((id: string) => {
		const transcript = scrollRef.current;
		if (!transcript) return;
		cancelScrollAnimation();
		followsBottomRef.current = false;
		readingAnchor.current = null;
		setRevealMessage(previous => ({ id, request: (previous?.request ?? 0) + 1, scope: disclosureScope }));
		if (!virtualize) {
			window.requestAnimationFrame(() => window.requestAnimationFrame(() => scrollToRow(id)));
			return;
		}
		const index = timelineRef.current?.entries.findIndex((entry) => entryContainsMessage(entry, id)) ?? -1;
		if (index >= 0) virtualizer.scrollToIndex(index, { align: 'center' });
		// The row mounts after the virtual window moves; settle it precisely on the next frames.
		window.requestAnimationFrame(() => window.requestAnimationFrame(() => scrollToRow(id)));
	}, [virtualize, virtualizer, scrollToRow, disclosureScope]);

	useEffect(() => {
		if (activeFindId) jumpToMessage(activeFindId);
		let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => {
			const node = scrollRef.current; if (!node) return;
			const range = paintTranscriptMatches(node, findOpen ? findQuery : '', activeFindId, activeFind?.ordinal ?? 0);
			if (range) revealTranscriptRange(range, node);
		}); });
		return () => cancelAnimationFrame(frame);
	}, [activeFind?.key, findQuery, findOpen]);
	useLayoutEffect(() => {
		if (scrollRef.current) paintTranscriptMatches(scrollRef.current, findOpen ? findQuery : '', activeFindId, activeFind?.ordinal ?? 0);
	});

	useLayoutEffect(() => {
		if (followsBottomRef.current && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [messages, activities, runs, fileChanges, error, awaitingResponse]);

	useLayoutEffect(() => {
		const list = messageListRef.current;
		if (!list) return;
		// Disclosure transitions keep changing layout after the data update.
		let frame: number | null = null;
		const observer = new ResizeObserver(() => {
			// Scrolling can mount and measure virtual rows. Let this observer delivery finish first.
			if (frame !== null) return;
			frame = requestAnimationFrame(() => {
				frame = null;
				const node = scrollRef.current;
				if (!node) return;
				if (followsBottomRef.current) node.scrollTop = node.scrollHeight;
				else if (!restoring.current && readingAnchor.current?.messageId) {
					const row = node.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(readingAnchor.current.messageId)}"]`);
					if (row && !row.closest('[inert],[hidden],[aria-hidden="true"]')) {
						const delta = row.getBoundingClientRect().top - node.getBoundingClientRect().top - readingAnchor.current.offset;
						if (Math.abs(delta) > .5) node.scrollTop += delta;
					}
				}
				setShowBackToBottom(node.scrollHeight - node.scrollTop - node.clientHeight > BOTTOM_THRESHOLD);
			});
		});
		observer.observe(list);
		if (changesRegionRef.current) observer.observe(changesRegionRef.current);
		if (scrollRef.current) observer.observe(scrollRef.current);
		return () => { observer.disconnect(); if (frame !== null) cancelAnimationFrame(frame); };
	}, [isEmpty]);

	useLayoutEffect(() => {
		cancelScrollAnimation(); locationRequest.current?.abort(); setLocationStatus(null); setLocationTarget(null); readingAnchor.current = null;
		memoryKeyRef.current = memoryKey;
		const exact = readReading(memoryKey);
		const earlier = exact ? undefined : recentReading(cwd, sessionPath);
		const saved = exact ?? earlier?.position;
		followsBottomRef.current = saved?.followsBottom ?? true;
		setShowBackToBottom(!followsBottomRef.current);
		if (sessionLoading || (searchTarget?.sessionPath === sessionPath && handledSearchRequest.current !== searchTarget.requestId)) return;
		if (!saved || saved.followsBottom || !saved.messageId) { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; return; }
		const controller = new AbortController(); locationRequest.current = controller; restoring.current = true;
		void (async () => {
			if (earlier && !await locateHistoryMessage(earlier.tailId, controller.signal)) return null;
			return locateHistoryMessage(saved.messageId!, controller.signal);
		})().then((id) => {
			if (controller.signal.aborted) return;
			if (!id) { restoring.current = false; followsBottomRef.current = true; if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; return; }
			jumpToMessage(id);
			requestAnimationFrame(() => requestAnimationFrame(() => {
				if (controller.signal.aborted) return;
				const node = scrollRef.current; const row = node?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
				if (node && row) node.scrollTop += row.getBoundingClientRect().top - node.getBoundingClientRect().top - saved.offset;
				readingAnchor.current = saved; restoring.current = false;
			}));
		});
		return () => { controller.abort(); restoring.current = false; };
	}, [cwd, sessionId, sessionPath, historyGeneration, sessionLoading]);
	useLayoutEffect(() => {
		const previous = memoryIdentity.current;
		if (previous.cwd === cwd && previous.sessionPath === sessionPath && previous.historyGeneration === historyGeneration && readingAnchor.current && !restoring.current) saveReading(memoryKey, readingAnchor.current);
		memoryKeyRef.current = memoryKey; memoryIdentity.current = { cwd, sessionPath, historyGeneration };
	}, [memoryKey, cwd, sessionPath, historyGeneration]);

	useEffect(() => () => cancelScrollAnimation(), []);

	useLayoutEffect(() => {
		// Empty drafts can scroll as a whole; clear that offset when the dock moves.
		if (bodyRef.current) bodyRef.current.scrollTop = 0;
	}, [isEmpty, sessionId]);

	const jumpRef = useRef(jumpToMessage); jumpRef.current = jumpToMessage;
	const locate = useCallback((id: string, snippet?: string) => {
		locationRequest.current?.abort(); const controller = new AbortController(); locationRequest.current = controller;
		setLocationTarget({ id, snippet });
		followsBottomRef.current = false; restoring.current = true; setLocationStatus('loading');
		void locateHistoryMessage(id, controller.signal, snippet).then((found) => {
			if (controller.signal.aborted) return;
			restoring.current = false; setLocationStatus(found ? null : 'missing');
			if (found) { jumpRef.current(found); setHighlightedMessage({ sessionPath: useChatStore.getState().sessionPath ?? '', messageId: found, requestId: Date.now() }); }
		});
	}, []);
	useEffect(() => {
		if (sessionLoading || !searchTarget || searchTarget.sessionPath !== sessionPath || handledSearchRequest.current === searchTarget.requestId) return;
		handledSearchRequest.current = searchTarget.requestId;
		locate(searchTarget.messageId, searchTarget.snippet);
	}, [searchTarget, sessionPath, sessionLoading, locate]);
	useEffect(() => () => locationRequest.current?.abort(), []);

	useEffect(() => {
		if (!highlightedMessage) return;
		const timer = window.setTimeout(() => setHighlightedMessage(null), 3000);
		return () => window.clearTimeout(timer);
	}, [highlightedMessage]);

	function handleScroll() {
		const node = scrollRef.current;
		if (!node) return;
		if (restoring.current) return;
		const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_THRESHOLD;
		if (scrollAnimationRef.current === null) followsBottomRef.current = nearBottom;
		setShowBackToBottom(!nearBottom);
		const row = Array.from(node.querySelectorAll<HTMLElement>('[data-message-id]')).find((item) => !item.closest('[inert],[hidden],[aria-hidden="true"]') && item.getBoundingClientRect().bottom > node.getBoundingClientRect().top);
		readingAnchor.current = { messageId: row?.dataset.messageId ?? null, offset: row ? row.getBoundingClientRect().top - node.getBoundingClientRect().top : 0, followsBottom: nearBottom };
		saveReading(memoryKeyRef.current, readingAnchor.current);
		// Long sessions fetch the next older slice as the reader approaches the top.
		if (hasOlderHistory && !loadingOlder && node.scrollTop < LOAD_OLDER_TRIGGER_PX) void loadOlderMessages();
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


	// Regeneration rewinds to the latest user turn; offered only on the last reply while idle (3.4).
	let lastReplyId: string | null = null;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i]!;
		if (message.role === 'user') break;
		if (message.role === 'assistant' && (message.text.trim() || message.status === 'error')) { lastReplyId = message.id; break; }
	}
	const canRegenerateLatest = agentStatus === 'idle' && lastReplyId !== null;
	const renderEntry = (entry: ConversationTimelineEntry) => entry.kind === 'message'
		? <MessageItem
			key={`message-${entry.id}`}
			message={messages[entry.index]!}
			highlighted={(highlightedMessage?.sessionPath === sessionPath && highlightedMessage.messageId === entry.id) || activeFindId === entry.id}
			findMatch={findOpen && entry.id !== activeFindId && findMatchSet.has(entry.id)}
			showHeading={entry.showAssistantHeading}
			canRegenerate={canRegenerateLatest && entry.id === lastReplyId}
		/>
		: <ConversationTurn key={`${disclosureScope}:${entry.id}`} entry={entry} messages={messages} activities={activities}
			run={runs.find(run => run.id === entry.runId)} legacyRunning={agentStatus === 'busy' && entry === timeline.at(-1)}
			highlightedId={activeFindId ?? (highlightedMessage?.sessionPath === sessionPath ? highlightedMessage.messageId : null)}
			findIds={findOpen ? findMatchSet : new Set()} query={findOpen ? findQuery : ''} reveal={revealMessage?.scope === disclosureScope ? revealMessage : null}
			canRegenerateId={canRegenerateLatest ? lastReplyId : null} />;

	return (
		<main className={`pd-main${isEmpty ? ' is-empty' : ''}`}>
			<header className="pd-chat-header">
				{historyControls}
				<HoverTooltip title={t('chat.toggleSidebar')}><button type="button" className="pd-icon-button pd-header-sidebar-toggle" onClick={onToggleSidebar} aria-label={t('chat.toggleSidebar')}><Icon name="panel" /></button></HoverTooltip>
				<div className="pd-chat-heading"><WorkspaceFolderButton key={`folder:${cwd}\0${sessionId}`} cwd={cwd} /><ChatTitle key={`${cwd}\0${sessionId}`} ref={titleRef} title={title} sessionPath={sessionPath} /><ChatHeaderMenu title={title} sessionPath={sessionPath} cwd={cwd} onRename={() => titleRef.current?.beginRename()} onOpenCommit={() => setCommitOpen(true)} /></div>
				<div className="pd-chat-header-actions"><WorkspaceOpenButton cwd={cwd} /></div>
			</header>

			<div ref={bodyRef} className={`pd-conversation-body${isEmpty ? ' is-empty' : ''}`}>
				<div className="pd-chat-content">
					{findOpen && <div className="pd-transcript-find-anchor">
						<TranscriptFind
							query={findQuery}
							onQueryChange={(query) => { setFindQuery(query); setFindKey(null); }}
							index={findMatches.length > 0 ? Math.min(findIndex, findMatches.length - 1) : null}
							total={findMatches.length}
							loadedMessages={messages.length}
							hasOlder={hasOlderHistory}
							loadingOlder={loadingOlder}
							onLoadOlder={() => { void loadOlderMessages(); }}
							onStep={(delta) => { if (findMatches.length === 0) return; setFindKey(findMatches[(findIndex + delta + findMatches.length) % findMatches.length]!.key); }}
							onClose={closeFind}
						/>
					</div>}
					{locationStatus && <div className="pd-conversation-location" role="status">{c(locationStatus === 'loading' ? 'locating' : 'missing')}{locationStatus === 'missing' && locationTarget && <button type="button" onClick={() => locate(locationTarget.id, locationTarget.snippet)}>{c('retry')}</button>}</div>}
					<TranscriptSearchContext.Provider value={findOpen ? findQuery : ''}>
					<ConversationDisclosureProvider scope={disclosureScope}>
					<div ref={scrollRef} className="pd-transcript" onScroll={handleScroll} onWheel={cancelScrollAnimation} onTouchStart={cancelScrollAnimation} onPointerDown={cancelScrollAnimation} onKeyDown={(event) => {
						if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) cancelScrollAnimation();
					}}>
						{sessionLoading ? <SessionLoading /> : isEmpty ? <EmptyState /> : (
							<div ref={messageListRef} className="pd-message-list" style={virtualize ? { display: 'block', position: 'relative', height: `${virtualizer.getTotalSize()}px` } : undefined}>
								{virtualize && hasOlderHistory && <div className="pd-load-older" role="status"><ActivityLabel active={loadingOlder}>{t(loadingOlder ? 'chat.loadingOlder' : 'chat.hasOlder')}</ActivityLabel></div>}
								{virtualize
									? virtualizer.getVirtualItems().map((item) => (
										<div className="pd-virtual-row" key={item.key} ref={virtualizer.measureElement} data-index={item.index} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}>
											{renderEntry(timeline[item.index]!)}
										</div>
									))
									: timeline.map((entry) => renderEntry(entry))}
							</div>
						)}
						<div ref={changesRegionRef} className="pd-transcript-end pd-transcript-changes">{!sessionLoading && <ComposerChanges key={`changes:${disclosureScope}`} items={fileChanges} running={agentStatus === 'busy'} liveTarget={changesDock} />}</div>
						{awaitingResponse && <div className="pd-transcript-end"><div className="pd-message-column"><div className="pd-response-pending" role="status"><ActivityLabel active>{t('message.preparing')}</ActivityLabel></div></div></div>}
						{error && <div className="pd-transcript-end">
							{navigationError
								? <div className="pd-error-banner" role="alert"><strong>{t('navigation.error')}</strong><span>{error}</span></div>
								: <RunStatusBar onOpenModelManagement={() => onOpenModelManagement({ kind: 'manage' })} />}
						</div>}
						{!error && <div className="pd-transcript-end"><RunStatusBar onOpenModelManagement={() => onOpenModelManagement({ kind: 'manage' })} /></div>}
					</div>
					</ConversationDisclosureProvider>
					</TranscriptSearchContext.Provider>
					<button type="button" className={`pd-back-to-bottom${showBackToBottom ? ' is-visible' : ''}`} aria-label={t('chat.backToBottom')} aria-hidden={!showBackToBottom} tabIndex={showBackToBottom ? 0 : -1} onClick={showBackToBottom ? scrollToBottom : undefined}>
						{agentStatus === 'busy' ? <span className="pd-back-to-bottom-dots" aria-hidden="true"><span /><span /><span /></span> : <Icon name="arrowDown" width="20" height="20" />}
					</button>
					{!isEmpty && !sessionLoading && <ConversationRail messages={messages} getScrollElement={() => scrollRef.current} markedIds={railMarkedIds ?? undefined} onJumpToMessage={jumpToMessage} />}
				</div>
				<Composer header={isEmpty ? <ComposerContextBar /> : undefined} onOpenModelManagement={onOpenModelManagement} changesSlotRef={setChangesDock} />
			</div>
			{commitOpen && <ChatCommitDialog onClose={() => setCommitOpen(false)} />}
		</main>
	);
}
