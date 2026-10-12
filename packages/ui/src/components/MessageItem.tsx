import type { UiAttachment, UiFileCheckpoint, UiMessage } from '@pidesktop/shared';
import { memo, useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { useChatStore } from '../store';
import { HoverTooltip } from './HoverTooltip';
import { Icon } from './Icons';
import { ThinkingActivity } from './ThinkingActivity';
import { ActivityLabel } from './ActivityDisclosure';
import { ConversationMarkdown } from './ConversationMarkdown';
import { MessageImages } from './MessageAttachments';
import { useConversationCopy } from '../conversationCopy';
import { operationFeedback } from '../operationFeedback';
import { useMessageStreamShowReasoning } from '../messageStreamShowReasoning';
import { TranscriptSearchContext } from '../transcriptSearch';

function AttachmentPreview({ attachment }: { attachment: UiAttachment }) {
	const { t } = useT();
	if (attachment.kind === 'image') {
		return null;
	}
	const previewLength = 4000;
	if (attachment.source) {
		const { source } = attachment;
		const label = t(source.kind === 'session' ? 'composer.contextSession' : source.kind === 'directory' ? 'composer.contextDirectory' : 'composer.contextFile');
		return <details className="pd-message-attachment pd-message-text-file pd-message-context" data-context-kind={source.kind}>
			<HoverTooltip title={label} description={<>{source.workspace}<br />{source.path}</>} align="start">
				<summary aria-label={`${label}: ${attachment.name}`}><Icon name={source.kind === 'session' ? 'message' : source.kind === 'directory' ? 'folder' : 'file'} width="14" height="14" />{attachment.name} <span>{label}</span></summary>
			</HoverTooltip>
			<pre className="pd-message-text-preview">{attachment.text.slice(0, previewLength)}{attachment.text.length > previewLength ? `\n${t('message.previewTruncated')}` : ''}{source.truncated ? `\n${t('composer.contextTruncated')}` : ''}</pre>
		</details>;
	}
	return <details className="pd-message-attachment pd-message-text-file"><summary>{attachment.name} <span>{t('message.textFile')}</span></summary><pre className="pd-message-text-preview">{attachment.text.slice(0, previewLength)}{attachment.text.length > previewLength ? `\n${t('message.previewTruncated')}` : ''}</pre></details>;
}

/** Collapsed height of a long sent message (ZCode ConversationUserInputBody). */
const USER_TEXT_COLLAPSED_PX = 120;
const USER_TEXT_TOLERANCE_PX = 24;

/**
 * Long sent messages (pasted logs, specs) fold to a few lines with an expand
 * toggle, so one prompt never pushes the whole conversation off screen. Search
 * and find matches inside the text keep it expanded.
 */
function UserMessageText({ text, forceExpanded }: { text: string; forceExpanded: boolean }) {
	const { t } = useT();
	const ref = useRef<HTMLParagraphElement>(null);
	const [expandable, setExpandable] = useState(false);
	const [expanded, setExpanded] = useState(false);
	// Short messages never need measuring.
	const candidate = text.length > 280 || text.split('\n').length > 5;
	useLayoutEffect(() => {
		const element = ref.current;
		if (!candidate || !element) { setExpandable(false); return; }
		const measure = () => setExpandable(element.scrollHeight > USER_TEXT_COLLAPSED_PX + USER_TEXT_TOLERANCE_PX);
		measure();
		const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
		observer?.observe(element);
		return () => observer?.disconnect();
	}, [text, candidate]);
	const open = expanded || forceExpanded || !expandable;
	return <>
		<p ref={ref} data-message-body className={expandable && !open ? 'is-collapsed' : undefined} style={expandable && !open ? { maxHeight: USER_TEXT_COLLAPSED_PX } : undefined}>{text}</p>
		{expandable && !forceExpanded && <button type="button" className="pd-user-text-toggle" aria-expanded={open} onClick={() => setExpanded(!open)}>{t(open ? 'message.collapseText' : 'message.expandText')}<Icon name="chevronDown" className={`pd-chevron${open ? ' is-open' : ''}`} width="13" height="13" /></button>}
	</>;
}

/** Sent messages reveal copy and edit actions on hover, zcode-style. */
const UserMessageItem = memo(function UserMessageItem({ message, highlighted, findMatch }: { message: UiMessage; highlighted: boolean; findMatch?: boolean }) {
	const { t } = useT();
	const c = useConversationCopy();
	const [copied, setCopied] = useState(false);
	const [editing, setEditing] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [draft, setDraft] = useState(message.text);
	const [fileMode, setFileMode] = useState<'keep' | 'rewind'>('keep');
	const [rewindLookup, setRewindLookup] = useState<{ state: 'loading' } | { state: 'none' } | { state: 'error' } | { state: 'ready'; preview: UiFileCheckpoint; conflict: boolean } | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const query = useContext(TranscriptSearchContext).trim().toLocaleLowerCase();
	const queryInside = Boolean(query && message.text.toLocaleLowerCase().includes(query));

	useEffect(() => {
		if (!editing) return;
		const textarea = textareaRef.current;
		if (!textarea) return;
		textarea.focus();
		textarea.setSelectionRange(textarea.value.length, textarea.value.length);
		textarea.style.height = 'auto';
		textarea.style.height = `${textarea.scrollHeight}px`;
	}, [editing]);

	const syncHeight = () => {
		const textarea = textareaRef.current;
		if (!textarea) return;
		textarea.style.height = 'auto';
		textarea.style.height = `${textarea.scrollHeight}px`;
	};

	const copy = async () => {
		if (!message.text) return;
		try { await navigator.clipboard.writeText(message.text); } catch { operationFeedback.show({ id: `copy:${message.id}`, kind: 'error', title: c('copyFailed') }); return; }
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1200);
	};

	const submitEdit = async () => {
		if (submitting || !draft.trim()) return;
		setSubmitting(true);
		try {
			await useChatStore.getState().editMessage(message.id, draft, message.attachments, fileMode === 'rewind' && rewindLookup?.state === 'ready' && !rewindLookup.conflict ? 'rewind' : 'keep');
			setEditing(false);
		} catch {
			// The store surfaces the failure; keep the draft for corrections.
		} finally {
			setSubmitting(false);
		}
	};

	const startEdit = () => {
		setDraft(message.text);
		setFileMode('keep');
		setRewindLookup(null);
		setEditing(true);
	};

	const chooseFileMode = async (mode: 'keep' | 'rewind') => {
		if (mode === fileMode || submitting) return;
		if (mode === 'keep') { setFileMode('keep'); return; }
		const bridge = useChatStore.getState().bridge;
		if (!bridge?.getEditRewindPreview) { setRewindLookup({ state: 'none' }); return; }
		setFileMode('rewind');
		setRewindLookup({ state: 'loading' });
		try {
			const preview = await bridge.getEditRewindPreview(message.id);
			if (!preview) { setRewindLookup({ state: 'none' }); setFileMode('keep'); return; }
			setRewindLookup({ state: 'ready', preview, conflict: preview.files.some((file) => file.status === 'conflict') });
		} catch { setRewindLookup({ state: 'error' }); setFileMode('keep'); }
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.nativeEvent.isComposing) return;
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			void submitEdit();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			setEditing(false);
		}
	};

	if (editing) {
		return (
			<div className="pd-message-row is-user" data-message-id={message.id}>
				<div className="pd-message-column">
					<div className="pd-message-edit">
						<MessageImages message={message} />
						<textarea ref={textareaRef} value={draft} rows={2} onChange={(event) => { setDraft(event.target.value); syncHeight(); }} onKeyDown={onKeyDown} aria-label={t('message.editLabel')} disabled={submitting} />
						{Boolean(message.attachments?.length) && <div className="pd-message-attachments">{message.attachments?.map((attachment, index) => <AttachmentPreview key={`${attachment.name}-${index}`} attachment={attachment} />)}</div>}
						{Boolean(message.attachmentsOmitted) && <p className="pd-activity-note">{t('message.attachmentsOmitted', { count: String(message.attachmentsOmitted) })}</p>}
						<div className="pd-message-edit-files" role="radiogroup" aria-label={t('message.editFileMode')}>
							<label className={fileMode === 'keep' ? 'is-active' : undefined}>
								<input type="radio" name={`edit-files-${message.id}`} checked={fileMode === 'keep'} onChange={() => void chooseFileMode('keep')} disabled={submitting} />
								{t('message.editFileKeep')}
							</label>
							<label className={fileMode === 'rewind' ? 'is-active' : undefined}>
								<input type="radio" name={`edit-files-${message.id}`} checked={fileMode === 'rewind'} onChange={() => void chooseFileMode('rewind')} disabled={submitting} />
								{t('message.editFileRewind')}
							</label>
							{rewindLookup?.state === 'loading' && <span role="status">{t('message.editRewindLoading')}</span>}
							{rewindLookup?.state === 'none' && <span>{t('message.editRewindNone')}</span>}
							{rewindLookup?.state === 'error' && <span>{t('message.editRewindError')}</span>}
							{rewindLookup?.state === 'ready' && (() => {
								let ready = 0, blocked = 0, conflict = 0;
								for (const file of rewindLookup.preview.files) {
									if (file.status === 'ready') ready += 1;
									else if (file.status === 'conflict') conflict += 1;
									else blocked += 1;
								}
								return <details className="pd-message-edit-rewind">
									<summary>{t('message.editRewindSummary', { ready: String(ready), blocked: String(blocked + conflict) })}</summary>
									{(rewindLookup.conflict || rewindLookup.preview.warning) && <p className="pd-message-edit-rewind-warning">{rewindLookup.conflict ? t('message.editRewindConflict') : rewindLookup.preview.warning}</p>}
									<ul>{rewindLookup.preview.files.slice(0, 50).map((file) => <li key={file.path}><code>{file.path}</code><span>{t(`message.editRewindFile.${file.status}`)}</span>{file.reason ? <small>{file.reason}</small> : null}</li>)}</ul>
								</details>;
							})()}
						</div>
						<div className="pd-message-edit-actions">
							<span className="pd-message-edit-hint">{t('message.editHint')}</span>
							<button type="button" className="pd-message-edit-cancel" onClick={() => setEditing(false)} disabled={submitting}>{t('message.editCancel')}</button>
							<button type="button" className="pd-message-edit-submit" onClick={() => void submitEdit()} disabled={submitting || !draft.trim() || (fileMode === 'rewind' && rewindLookup?.state === 'ready' && rewindLookup.conflict)}>{t(submitting ? 'message.editSubmitting' : 'message.editSubmit')}</button>
						</div>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className={`pd-message-row is-user${highlighted ? ' is-search-match' : ''}${findMatch ? ' is-find-match' : ''}`} data-message-id={message.id}>
			<div className="pd-message-column">
				<div className="pd-user-bubble">{message.text && <UserMessageText text={message.text} forceExpanded={highlighted || Boolean(findMatch) || queryInside} />}<MessageImages message={message} />{Boolean(message.attachments?.length) && <div className="pd-message-attachments">{message.attachments?.map((attachment, index) => <AttachmentPreview key={`${attachment.name}-${index}`} attachment={attachment} />)}</div>}</div>
				{Boolean(message.attachmentsOmitted) && <p className="pd-activity-note">{t('message.attachmentsOmitted', { count: String(message.attachmentsOmitted) })}</p>}
				<div className="pd-message-actions">
					<HoverTooltip title={t(copied ? 'message.copied' : 'message.copy')}><button type="button" className="pd-message-action" onClick={() => void copy()} disabled={!message.text} aria-label={t(copied ? 'message.copied' : 'message.copy')}><Icon name={copied ? 'check' : 'copy'} width="14" height="14" /></button></HoverTooltip>
					<HoverTooltip title={t('message.edit')}><button type="button" className="pd-message-action" onClick={startEdit} aria-label={t('message.edit')}><Icon name="pencil" width="14" height="14" /></button></HoverTooltip>
				</div>
			</div>
		</div>
	);
});

interface AssistantPresentation { hideThinking?: boolean; process?: boolean; hidePending?: boolean }
const AssistantMessageItem = memo(function AssistantMessageItem({ message, highlighted, showHeading = true, findMatch, canRegenerate = false, hideThinking = false, process = false, hidePending = false }: { message: UiMessage; highlighted: boolean; showHeading?: boolean; findMatch?: boolean; canRegenerate?: boolean } & AssistantPresentation) {
	const { t } = useT();
	const c = useConversationCopy();
	const [showReasoning] = useMessageStreamShowReasoning();
	const idle = useChatStore((s) => s.status === 'idle');
	const bodyRef = useRef<HTMLDivElement>(null);
	const [selection, setSelection] = useState('');
	const [selectionPosition, setSelectionPosition] = useState({ left: 0, top: 0 });
	const [copied, setCopied] = useState(false);
	const [forking, setForking] = useState(false);
	const [regenerating, setRegenerating] = useState(false);
	const actionPending = useRef(false);

	const copy = async () => {
		if (!message.text) return;
		try { await navigator.clipboard.writeText(message.text); } catch { operationFeedback.show({ id: `copy:${message.id}`, kind: 'error', title: c('copyFailed') }); return; }
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1200);
	};

	const fork = async () => {
		if (actionPending.current) return;
		actionPending.current = true;
		setForking(true);
		try {
			await useChatStore.getState().forkMessage(message.id);
			operationFeedback.show({ id: `fork:${message.id}`, kind: 'success', title: c('forked') });
		} catch (cause) {
			operationFeedback.show({ id: `fork:${message.id}`, kind: 'error', title: t('message.fork'), detail: cause instanceof Error ? cause.message : String(cause) });
		} finally {
			actionPending.current = false;
			setForking(false);
		}
	};
	const regenerate = async () => {
		if (actionPending.current) return;
		actionPending.current = true;
		setRegenerating(true);
		try {
			await useChatStore.getState().regenerate(message.id);
		} catch {
			// The store surfaces the failure; the branch stays untouched.
		} finally {
			actionPending.current = false;
			setRegenerating(false);
		}
	};

	const hasThinking = Boolean(message.thinking || message.thinkingStatus);
	const showActions = !process && (Boolean(message.text) || message.status === 'error');
	const inspectSelection = () => {
		const selected = window.getSelection(), body = bodyRef.current;
		if (!selected || selected.isCollapsed || !body || !selected.rangeCount) { setSelection(''); return; }
		const range = selected.getRangeAt(0);
		if (!body.contains(range.startContainer) || !body.contains(range.endContainer) || Array.from(body.querySelectorAll('button,.pd-code-block-header')).some((node) => range.intersectsNode(node))) { setSelection(''); return; }
		const box = range.getBoundingClientRect();
		setSelectionPosition({ left: Math.max(8, Math.min(box.left, window.innerWidth - 220)), top: Math.max(8, Math.min(box.bottom + 6, window.innerHeight - 52)) });
		setSelection(selected.toString());
	};
	useEffect(() => {
		const clear = () => setSelection('');
		const outside = (event: PointerEvent) => { const target = event.target; if (target instanceof Element && !bodyRef.current?.contains(target) && !target.closest(`[data-quote-for="${CSS.escape(message.id)}"]`)) clear(); };
		document.addEventListener('selectionchange', inspectSelection);
		document.addEventListener('pointerdown', outside);
		window.addEventListener('scroll', clear, true);
		return () => { document.removeEventListener('selectionchange', inspectSelection); document.removeEventListener('pointerdown', outside); window.removeEventListener('scroll', clear, true); };
	}, [message.id]);
	const quote = () => {
		const state = useChatStore.getState();
		window.dispatchEvent(new CustomEvent('pd:quote-selection', { detail: { cwd: state.cwd, sessionPath: state.sessionPath, messageId: message.id, text: selection } }));
		setSelection('');
	};

	if (message.status === 'done' && !message.text && !hasThinking && !message.errorMessage) return null;
	return (
		<div className={`pd-message-row is-assistant${process ? ' is-process-message' : ''}${highlighted ? ' is-search-match' : ''}${findMatch ? ' is-find-match' : ''}`} data-message-id={message.id}>
			<div className="pd-message-column">
				{showHeading && <div className="pd-assistant-heading"><span className="pd-assistant-mark">π</span><span>Pi</span></div>}
				{hasThinking && !hideThinking && showReasoning && <ThinkingActivity message={message} />}
				{hasThinking && !showReasoning && !hideThinking && message.status === 'streaming' && message.thinkingStatus === 'streaming' && <span className="pd-response-pending" role="status"><ActivityLabel active>{t('message.generating')}</ActivityLabel></span>}
				{message.text && <div ref={bodyRef} data-message-body className="pd-markdown" onPointerUp={inspectSelection} onKeyUp={inspectSelection}><ConversationMarkdown>{message.text}</ConversationMarkdown></div>}
				{selection && createPortal(<button type="button" className="pd-quote-selection" data-quote-for={message.id} style={{ position: 'fixed', zIndex: 'var(--pd-z-selection-action)', ...selectionPosition }} onMouseDown={(event) => event.preventDefault()} onClick={quote}>{c('quote')}</button>, document.body)}
				{!hidePending && message.status === 'streaming' && message.thinkingStatus !== 'streaming' && <span className="pd-response-pending" role="status"><ActivityLabel active>{t(message.text ? 'message.generating' : 'message.preparing')}</ActivityLabel></span>}
				{message.status === 'error' && <div className="pd-message-interrupted">{message.errorMessage || t('message.interrupted')}</div>}
				{showActions && (
					<div className="pd-message-actions">
						<HoverTooltip title={t(copied ? 'message.copied' : 'message.copy')}><button type="button" className="pd-message-action" onClick={() => void copy()} aria-label={t(copied ? 'message.copied' : 'message.copy')}><Icon name={copied ? 'check' : 'copy'} width="14" height="14" /></button></HoverTooltip>
						{canRegenerate && <HoverTooltip title={t('message.regenerate')} description={c('regenerateHint')}><button type="button" className="pd-message-action" onClick={() => void regenerate()} disabled={regenerating || !idle} aria-label={t('message.regenerate')}><Icon name="rotateCcw" width="14" height="14" />{regenerating && <span role="status">{c('regenerating')}</span>}</button></HoverTooltip>}
						<HoverTooltip title={t('message.fork')} description={c('forkHint')}><button type="button" className="pd-message-action" onClick={() => void fork()} disabled={forking || !idle} aria-label={t('message.fork')}><Icon name="gitBranch" width="14" height="14" />{forking && <span role="status">{c('forking')}</span>}</button></HoverTooltip>
					</div>
				)}
			</div>
		</div>
	);
});

/** System rows surface compaction/branch summaries as collapsible notices (3.6). */
const SystemMessageItem = memo(function SystemMessageItem({ message, highlighted, findMatch }: { message: UiMessage; highlighted?: boolean; findMatch?: boolean }) {
	const { t } = useT();
	const query = useContext(TranscriptSearchContext).trim().toLocaleLowerCase();
	if (message.systemKind === 'extension-notice') return (
		<div className={`pd-message-row is-system${highlighted ? ' is-search-match' : ''}${findMatch ? ' is-find-match' : ''}`} data-message-id={message.id}>
			{/* Plugin notices stay visible inline: no auto-dismiss, no floating toast. */}
			<div className="pd-extension-notice-card" data-notification-type={message.notificationType ?? 'info'} data-message-body role="note" aria-label={t('message.system.extension-notice')}>
				<Icon name="plugins" width="13" height="13" />
				<span className="pd-extension-notice-card-label">{t('message.system.extension-notice')}</span>
				<span className="pd-extension-notice-card-text">{message.text}</span>
			</div>
		</div>
	);
	return (
		<div className={`pd-message-row is-system${highlighted ? ' is-search-match' : ''}${findMatch ? ' is-find-match' : ''}`} data-message-id={message.id}>
			<details className="pd-system-notice" data-system-kind={message.systemKind} open={query && message.text.toLocaleLowerCase().includes(query) ? true : undefined}>
				<summary><Icon name={message.systemKind === 'compaction' ? 'archive' : message.systemKind === 'branch-summary' ? 'gitBranch' : message.systemKind === 'subagent-notify' ? 'plugins' : 'file'} width="13" height="13" />{t(`message.system.${message.systemKind ?? 'custom'}`)}</summary>
				<div className="pd-system-notice-body" data-message-body>{message.text}</div>
			</details>
		</div>
		);
});
export const MessageItem = memo(function MessageItem({ message, highlighted = false, showHeading = true, findMatch, canRegenerate, ...presentation }: { message: UiMessage; highlighted?: boolean; showHeading?: boolean; findMatch?: boolean; canRegenerate?: boolean } & AssistantPresentation) {
	if (message.role === 'system') return <SystemMessageItem message={message} highlighted={highlighted} findMatch={findMatch} />;
	if (message.role === 'user') return <UserMessageItem message={message} highlighted={highlighted} findMatch={findMatch} />;
	return <AssistantMessageItem message={message} highlighted={highlighted} showHeading={showHeading} findMatch={findMatch} canRegenerate={canRegenerate} {...presentation} />;
});
