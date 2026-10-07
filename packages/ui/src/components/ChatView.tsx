import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useT } from '../i18n';
import { useExtensionNoticeDisplayEnabled } from '../extensionNoticeDisplay';
import { useChatStore } from '../store';
import { sessionOpenMetrics } from '../sessionOpenMetrics';
import { bindingKeysFor, matchesShortcut } from '../shortcuts/bindings';
import type { ModelManagementTarget } from '../modelManagement';
import type { UiFileDiffScope } from '@pidesktop/shared';
import { buildConversationTimeline, entryContainsMessage, type ConversationTimelineEntry } from '../conversationTimeline';
import { ConversationDisclosureProvider } from '../conversationDisclosure';
import { ConversationRail } from './ConversationRail';
import { useExtensionRequestPending } from './ExtensionDialogHost';
import { Composer } from './Composer';
import { ChangesCard, LiveChangesSummary } from './ComposerChanges';
import { ChangesDialog } from './ChangesDialog';
import { useFileChangeDiffs } from '../fileChangeDiffs';
import { findChangeMatches } from '../changesFind';
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

export function ChatView({ onToggleSidebar, onOpenModelManagement, searchTarget, historyControls, navigationError, compact = false, active = true }: { onToggleSidebar(): void; onOpenModelManagement(target: ModelManagementTarget): void; searchTarget?: SearchMessageTarget | null; historyControls?: ReactNode; navigationError?: string | null; compact?: boolean; /** False while another main view hides the chat; rising edges re-apply the remembered reading position (12). */ active?: boolean }) {
	const { t } = useT();
	const extensionRequestPending = useExtensionRequestPending();
	const messages = useChatStore((s) => s.messages);
	const c = useConversationCopy();
	const historyGeneration = useChatStore((s) => s.historyGeneration);
	const activities = useChatStore((s) => s.activities);
	const runs = useChatStore((s) => s.runs);
	const fileChanges = useChatStore((s) => s.fileChanges);
	const [changesDock, setChangesDock] = useState<HTMLDivElement | null>(null);
	const changesRegionRef = useRef<HTMLDivElement>(null);
	const fileChangeTurns = useChatStore((s) => s.fileChangeTurns);
	const fileChangeActiveRunId = useChatStore((s) => s.fileChangeActiveRunId);
	// Turn-level settlement: each completed run's changes render at that turn's tail.
	const changesByRun = useMemo(() => new Map(fileChangeTurns.map(turn => [turn.runId, turn.items])), [fileChangeTurns]);
	const liveChanges = fileChangeActiveRunId
		? changesByRun.get(fileChangeActiveRunId) ?? []
		: changesByRun.get(null) ?? fileChanges;
	const legacyChanges = changesByRun.get(null) ?? [];
	const sessions = useChatStore((s) => s.sessions);
	const sessionPath = useChatStore((s) => s.sessionPath);
	const sessionId = useChatStore((s) => s.sessionId);
	const cwd = useChatStore((s) => s.cwd);
	const agentError = useChatStore((s) => s.error);
	const agentStatus = useChatStore((s) => s.status);
	const error = navigationError ?? agentError;
	const timelineRevision = useChatStore((s) => s.timelineRevision);
	const sessionLoading = useChatStore((s) => s.sessionLoading);
	const navigationPending = useChatStore((s) => s.navigationPending);
	const sessionPreparation = useChatStore((s) => s.sessionPreparation);
	const historyTotal = useChatStore((s) => s.historyTotal);
	const loadingOlder = useChatStore((s) => s.loadingOlder);
	const loadOlderMessages = useChatStore((s) => s.loadOlderMessages);
	const timelineRef = useRef<{ revision: number; runs: typeof runs; entries: ConversationTimelineEntry[] } | null>(null);
	if (timelineRef.current?.revision !== timelineRevision || timelineRef.current.runs !== runs) {
		timelineRef.current = { revision: timelineRevision, runs, entries: buildConversationTimeline(messages, activities, runs) };
	}
	const timeline = timelineRef.current.entries;
	const hasOlderHistory = historyTotal > messages.length + activities.length;
	const emptyTimeline = timeline.length === 0 && fileChanges.length === 0;
	const layoutPending = !sessionPreparation && (sessionLoading || navigationPending || agentStatus === 'starting' || agentStatus === 'uninitialized' || !sessionId && agentStatus !== 'error');
	useLayoutEffect(() => {
		if (layoutPending || !sessionId) return;
		const request = sessionOpenMetrics.rendered(cwd, sessionPath, sessionId);
		if (request === null) return;
		let second = 0;
		const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => sessionOpenMetrics.painted(request)); });
		return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
	}, [layoutPending, cwd, sessionPath, sessionId]);
	const settledEmptyLayout = useRef(false);
	// A reset temporarily has no messages. Preserve the previous layout until
	// the destination is ready, so an existing chat never becomes a blank draft.
	const isNewConversation = layoutPending ? settledEmptyLayout.current : emptyTimeline;
	useLayoutEffect(() => {
		if (!layoutPending) settledEmptyLayout.current = emptyTimeline;
	}, [layoutPending, emptyTimeline]);
	const isEmpty = isNewConversation && !error;
	const awaitingResponse = !layoutPending && agentStatus === 'busy' && !runs.some(run => run.status === 'running') && !error && !messages.some((message) => message.status === 'streaming') && !activities.some((activity) => activity.status === 'running');
	const disclosureScope = `${cwd}\0${sessionPath}\0${sessionId}`;
	const [revealMessage, setRevealMessage] = useState<{ id: string; request: number; scope: string } | null>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const getScrollElement = useCallback(() => scrollRef.current, []);
	const messageListRef = useRef<HTMLDivElement>(null);
	const followsBottomRef = useRef(true);
	const scrollAnimationRef = useRef<number | null>(null);
	const [showBackToBottom, setShowBackToBottom] = useState(false);
	// Re-showing the chat view restores a stale scrollTop and fires a scroll event
	// that would otherwise cancel bottom-following (12). Re-apply the remembered
	// intent before that event: pin to the newest content when the last position
	// was the bottom; a remembered middle position restores via its saved anchor.
	const chatActiveRef = useRef(active);
	useLayoutEffect(() => {
		if (chatActiveRef.current === active) return;
		chatActiveRef.current = active;
		if (!active) return;
		const node = scrollRef.current;
		if (!node || node.clientHeight === 0) return;
		if (followsBottomRef.current || readingAnchor.current?.followsBottom !== false) {
			followsBottomRef.current = true;
			node.scrollTop = node.scrollHeight;
			setShowBackToBottom(false);
		}
	}, [active]);
	const handledSearchRequest = useRef<number | null>(null);
	const [highlightedMessage, setHighlightedMessage] = useState<SearchMessageTarget | null>(null);
	const [locationStatus, setLocationStatus] = useState<'loading' | 'missing' | null>(null);
	const [locationTarget, setLocationTarget] = useState<{ id: string; snippet?: string } | null>(null);
	const locationRequest = useRef<AbortController | null>(null);
	const restoring = useRef(false);
	const pendingJumpRef = useRef<{ frame: number; restoresReading: boolean } | null>(null);
	const cancelPendingJump = useCallback(() => {
		const pending = pendingJumpRef.current;
		if (!pending) return;
		cancelAnimationFrame(pending.frame);
		pendingJumpRef.current = null;
		if (pending.restoresReading) restoring.current = false;
	}, []);
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
	// Changes find scope (12): matches inside recorded diffs, stepping opens the review dialog.
	const [findScope, setFindScope] = useState<'conversation' | 'changes'>('conversation');
	// -1: no file opened yet, so the first step lands on the first (or last) match.
	const [changesFindFile, setChangesFindFile] = useState(-1);
	// One shared review dialog serves cards, the live summary and find stepping.
	const [changesReview, setChangesReview] = useState<{ scope: UiFileDiffScope; path: string; trigger: HTMLElement | null } | null>(null);
	const openChangesReview = useCallback((scope: UiFileDiffScope, path: string, trigger?: HTMLElement | null) => {
		setChangesReview({ scope, path, trigger: trigger ?? null });
	}, []);
	const reviewItems = useMemo(() => {
		if (!changesReview) return [];
		if (changesReview.scope.kind === 'conversation') return fileChanges;
		return changesByRun.get(changesReview.scope.runId) ?? [];
	}, [changesReview, fileChanges, changesByRun]);
	useEffect(() => { if (changesReview && reviewItems.length === 0) setChangesReview(null); }, [changesReview, reviewItems.length]);
	const reviewDiffs = useFileChangeDiffs(changesReview?.scope ?? null);
	const findDiffs = useFileChangeDiffs(findOpen && findScope === 'changes' ? { kind: 'conversation' } : null);
	const changesFindable = fileChanges.length > 0;
	const changesFind = useMemo(() => findScope === 'changes' && findOpen ? findChangeMatches(fileChanges, findQuery, findDiffs) : null, [findScope, findOpen, fileChanges, findQuery, findDiffs]);
	useEffect(() => { setChangesFindFile(-1); }, [findQuery]);
	useEffect(() => { if (changesFind && changesFindFile >= changesFind.files.length) setChangesFindFile(-1); }, [changesFind, changesFindFile]);
	const stepChangesFind = (delta: 1 | -1, files = changesFind?.files ?? [], current = changesFindFile) => {
		if (!files.length) return;
		const next = current < 0 || current >= files.length
			? (delta > 0 ? 0 : files.length - 1)
			: (current + delta + files.length) % files.length;
		setChangesFindFile(next);
		openChangesReview({ kind: 'conversation' }, files[next]!.path);
	};
	// Lazy diffs arrive after the scope switches; land on the first match then.
	useEffect(() => {
		if (!findDiffs || !findOpen || findScope !== 'changes' || changesFindFile >= 0) return;
		if (changesFind?.files.length) stepChangesFind(1);
	}, [findDiffs]);
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
			if (event.defaultPrevented || event.isComposing || document.querySelector('[role="dialog"][aria-modal="true"], dialog[open]')) return;
			if (matchesShortcut(event, bindingKeysFor('findInTranscript'))) {
				event.preventDefault();
				setFindOpen(true);
				return;
			}
			if (matchesShortcut(event, bindingKeysFor('stopGeneration'))) {
				const state = useChatStore.getState();
				if (state.status !== 'busy') return;
				// zcode escapeStop: events whose path crosses an open dialog are
				// ignored (the dialog itself consumes Esc to close). Focus inside the
				// composer must NOT block stopping — typing while a run streams and
				// pressing Esc is the most common stop path. The composer cancels a
				// history recall first and stops propagation, so that Esc never gets here.
				// (The global query at the top of this listener additionally keeps the
				// old conservative gate: while any modal dialog is open, stop stays silent.)
				const origin = event.target instanceof Element ? event.target : null;
				if (origin?.closest('dialog[open], [role="dialog"][aria-modal="true"]')) return;
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
		getScrollElement,
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

	const jumpToMessage = useCallback((id: string, restoreReading?: () => void) => {
		cancelPendingJump();
		const transcript = scrollRef.current;
		if (!transcript) return;
		cancelScrollAnimation();
		followsBottomRef.current = false;
		readingAnchor.current = null;
		if (restoreReading) restoring.current = true;
		setRevealMessage(previous => ({ id, request: (previous?.request ?? 0) + 1, scope: disclosureScope }));
		if (virtualize) {
			const index = timelineRef.current?.entries.findIndex((entry) => entryContainsMessage(entry, id)) ?? -1;
			if (index >= 0) virtualizer.scrollToIndex(index, { align: 'center' });
		}
		// Wait for disclosure/virtual rows to mount, keeping only the latest target.
		const pending = { frame: 0, restoresReading: Boolean(restoreReading) };
		pendingJumpRef.current = pending;
		pending.frame = requestAnimationFrame(() => {
			if (pendingJumpRef.current !== pending) return;
			pending.frame = requestAnimationFrame(() => {
				if (pendingJumpRef.current !== pending) return;
				pendingJumpRef.current = null;
				scrollToRow(id);
				restoreReading?.();
			});
		});
	}, [cancelPendingJump, virtualize, virtualizer, scrollToRow, disclosureScope]);
	useLayoutEffect(() => cancelPendingJump, [cancelPendingJump, cwd, sessionId, sessionPath, historyGeneration, sessionLoading]);

	useEffect(() => {
		if (activeFindId) jumpToMessage(activeFindId);
		let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => {
			const node = scrollRef.current; if (!node) return;
			const range = paintTranscriptMatches(node, findOpen && findScope === 'conversation' ? findQuery : '', activeFindId, activeFind?.ordinal ?? 0);
			if (range) revealTranscriptRange(range, node);
		}); });
		return () => cancelAnimationFrame(frame);
	}, [activeFind?.key, findQuery, findOpen, findScope]);
	const findClearedRef = useRef(true);
	useLayoutEffect(() => {
		const query = findOpen && findScope === 'conversation' ? findQuery : '';
		// An empty query only needs one clear pass; skip the rescan while find stays closed.
		if (!query.trim() && findClearedRef.current) return;
		findClearedRef.current = !query.trim();
		if (scrollRef.current) paintTranscriptMatches(scrollRef.current, query, activeFindId, activeFind?.ordinal ?? 0);
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
			jumpToMessage(id, () => {
				if (controller.signal.aborted) return;
				const node = scrollRef.current; const row = node?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
				if (node && row) node.scrollTop += row.getBoundingClientRect().top - node.getBoundingClientRect().top - saved.offset;
				readingAnchor.current = saved; restoring.current = false;
			});
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
		// Loading swaps the transcript content and clamps scrollTop; the resulting
		// events are layout noise, not reading intent.
		if (restoring.current || sessionLoading) return;
		const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_THRESHOLD;
		if (scrollAnimationRef.current === null) followsBottomRef.current = nearBottom;
		setShowBackToBottom(!nearBottom);
		// Save before navigation or history loading can replace the visible rows.
		const top = node.getBoundingClientRect().top;
		let position: ReadingPosition = { messageId: null, offset: 0, followsBottom: nearBottom };
		for (const row of node.querySelectorAll<HTMLElement>('[data-message-id]')) {
			if (row.closest('[inert],[hidden],[aria-hidden="true"]')) continue;
			const rect = row.getBoundingClientRect();
			if (rect.bottom <= top) continue;
			position = { messageId: row.dataset.messageId ?? null, offset: rect.top - top, followsBottom: nearBottom };
			break;
		}
		// A scroll over cleared content has no anchor row; never overwrite a real
		// remembered position with a null placeholder (12).
		if (!position.messageId) return;
		readingAnchor.current = position;
		saveReading(memoryKeyRef.current, position);
		// Long sessions fetch the next older slice as the reader approaches the top.
		if (hasOlderHistory && !loadingOlder && node.scrollTop < LOAD_OLDER_TRIGGER_PX) void loadOlderMessages();
	}

	function cancelScrollAnimation() {
		if (scrollAnimationRef.current === null) return;
		cancelAnimationFrame(scrollAnimationRef.current);
		scrollAnimationRef.current = null;
	}

	function scrollToBottom() {
		cancelPendingJump();
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
	// Idle plugin notices render as standalone cards; the display setting removes them.
	const [noticesVisible] = useExtensionNoticeDisplayEnabled();
	const renderEntry = (entry: ConversationTimelineEntry) => entry.kind === 'message'
		? (messages[entry.index]!.systemKind === 'extension-notice' && !noticesVisible ? null : <MessageItem
			key={`message-${entry.id}`}
			message={messages[entry.index]!}
			highlighted={(highlightedMessage?.sessionPath === sessionPath && highlightedMessage.messageId === entry.id) || activeFindId === entry.id}
			findMatch={findOpen && entry.id !== activeFindId && findMatchSet.has(entry.id)}
			showHeading={entry.showAssistantHeading}
			canRegenerate={canRegenerateLatest && entry.id === lastReplyId}
		/>)
		: <ConversationTurn key={`${disclosureScope}:${entry.id}`} entry={entry} messages={messages} activities={activities}
			run={runs.find(run => run.id === entry.runId)} changes={entry.runId && entry.lastForRun ? changesByRun.get(entry.runId) : undefined} changesReview={openChangesReview} legacyRunning={agentStatus === 'busy' && entry === timeline.at(-1)}
			highlightedId={activeFindId ?? (highlightedMessage?.sessionPath === sessionPath ? highlightedMessage.messageId : null)}
			findIds={findOpen ? findMatchSet : new Set()} query={findOpen ? findQuery : ''} reveal={revealMessage?.scope === disclosureScope ? revealMessage : null}
			canRegenerateId={canRegenerateLatest ? lastReplyId : null} />;

	return (
		<main className={`pd-main${isEmpty ? ' is-empty' : ''}`}>
			<header className="pd-chat-header">
				{historyControls}
				{!compact && <HoverTooltip title={t('chat.toggleSidebar')}><button type="button" className="pd-icon-button pd-header-sidebar-toggle" onClick={onToggleSidebar} aria-label={t('chat.toggleSidebar')}><Icon name="panel" /></button></HoverTooltip>}
				<div className="pd-chat-heading"><WorkspaceFolderButton key={`folder:${cwd}\0${sessionId}`} cwd={cwd} /><ChatTitle key={`${cwd}\0${sessionId}`} ref={titleRef} title={title} sessionPath={sessionPath} /><ChatHeaderMenu title={title} sessionPath={sessionPath} cwd={cwd} onRename={() => titleRef.current?.beginRename()} onOpenCommit={() => setCommitOpen(true)} /></div>
				<div className="pd-chat-header-actions"><WorkspaceOpenButton cwd={cwd} /></div>
			</header>

			<div ref={bodyRef} className={`pd-conversation-body${isEmpty ? ' is-empty' : ''}${extensionRequestPending ? ' has-extension-request' : ''}`}>
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
							onStep={(delta) => {
								if (findScope === 'changes') { stepChangesFind(delta); return; }
								if (findMatches.length === 0) return;
								setFindKey(findMatches[(findIndex + delta + findMatches.length) % findMatches.length]!.key);
							}}
							scope={findScope}
							onScopeChange={(next) => {
								setFindScope(next);
								setChangesFindFile(-1);
							}}
							hasChanges={changesFindable}
							changesSummary={changesFind ? { files: changesFind.files.length, total: changesFind.total } : null}
							onClose={closeFind}
						/>
					</div>}
					{locationStatus && <div className="pd-conversation-location" role="status">{c(locationStatus === 'loading' ? 'locating' : 'missing')}{locationStatus === 'missing' && locationTarget && <button type="button" onClick={() => locate(locationTarget.id, locationTarget.snippet)}>{c('retry')}</button>}</div>}
					<TranscriptSearchContext.Provider value={findOpen && findScope === 'conversation' ? findQuery : ''}>
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
							<div ref={changesRegionRef} className="pd-transcript-end pd-transcript-changes">{!sessionLoading && <>
								{agentStatus === 'busy' && liveChanges.length > 0 && <LiveChangesSummary items={liveChanges} scope={fileChangeActiveRunId ? { kind: 'turn', runId: fileChangeActiveRunId } : { kind: 'conversation' }} target={changesDock} review={openChangesReview} />}
								{agentStatus !== 'busy' && legacyChanges.length > 0 && <ChangesCard key={`legacy:${disclosureScope}`} items={legacyChanges} scope={{ kind: 'conversation' }} variant="conversation" review={openChangesReview} />}
							</>}</div>
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
				</div>
				{!isEmpty && !sessionLoading && <ConversationRail messages={messages} getScrollElement={getScrollElement} markedIds={railMarkedIds ?? undefined} onJumpToMessage={jumpToMessage} />}
				<Composer header={isNewConversation ? <ComposerContextBar /> : undefined} onOpenModelManagement={onOpenModelManagement} changesSlotRef={setChangesDock} />
			</div>
			{commitOpen && <ChatCommitDialog onClose={() => setCommitOpen(false)} />}
			{changesReview !== null && reviewItems.length > 0 && <ChangesDialog
				key={`${changesReview.scope.kind}:${changesReview.scope.kind === 'turn' ? changesReview.scope.runId : ''}:${changesReview.path}`}
				items={reviewItems} diffs={changesReview.scope.kind === 'conversation' && findOpen && findScope === 'changes' ? findDiffs : reviewDiffs}
				initialPath={changesReview.path} returnFocus={changesReview.trigger}
				getReturnFocus={() => document.querySelector<HTMLElement>('.pd-conversation-changes .pd-changes-card-main, .pd-composer-changes.is-running .pd-changes-live-main') ?? document.querySelector<HTMLTextAreaElement>('.pd-composer-shell textarea')}
				onClose={() => setChangesReview(null)} />}

		</main>
	);
}
