import type { UiAttachment, UiMessage } from '@pidesktop/shared';
import { memo, useContext, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useT } from '../i18n';
import { useChatStore } from '../store';
import { HoverTooltip } from './HoverTooltip';
import { Icon } from './Icons';
import { ThinkingActivity } from './ThinkingActivity';
import { ActivityLabel } from './ActivityDisclosure';
import { renderMarkdownPre } from './CodeBlock';
import { MessageImages } from './MessageAttachments';
import { useConversationCopy } from '../conversationCopy';
import { operationFeedback } from '../operationFeedback';
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

/** Sent messages reveal copy and edit actions on hover, zcode-style. */
const UserMessageItem = memo(function UserMessageItem({ message, highlighted, findMatch }: { message: UiMessage; highlighted: boolean; findMatch?: boolean }) {
	const { t } = useT();
	const c = useConversationCopy();
	const [copied, setCopied] = useState(false);
	const [editing, setEditing] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [draft, setDraft] = useState(message.text);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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
			await useChatStore.getState().editMessage(message.id, draft, message.attachments);
			setEditing(false);
		} catch {
			// The store surfaces the failure; keep the draft for corrections.
		} finally {
			setSubmitting(false);
		}
	};

	const startEdit = () => {
		setDraft(message.text);
		setEditing(true);
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
						<div className="pd-message-edit-actions">
							<span className="pd-message-edit-hint">{t('message.editHint')}</span>
							<button type="button" className="pd-message-edit-cancel" onClick={() => setEditing(false)} disabled={submitting}>{t('message.editCancel')}</button>
							<button type="button" className="pd-message-edit-submit" onClick={() => void submitEdit()} disabled={submitting || !draft.trim()}>{t(submitting ? 'message.editSubmitting' : 'message.editSubmit')}</button>
						</div>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className={`pd-message-row is-user${highlighted ? ' is-search-match' : ''}${findMatch ? ' is-find-match' : ''}`} data-message-id={message.id}>
			<div className="pd-message-column">
				<div className="pd-user-bubble">{message.text && <p data-message-body>{message.text}</p>}<MessageImages message={message} />{Boolean(message.attachments?.length) && <div className="pd-message-attachments">{message.attachments?.map((attachment, index) => <AttachmentPreview key={`${attachment.name}-${index}`} attachment={attachment} />)}</div>}</div>
				{Boolean(message.attachmentsOmitted) && <p className="pd-activity-note">{t('message.attachmentsOmitted', { count: String(message.attachmentsOmitted) })}</p>}
				<div className="pd-message-actions">
					<HoverTooltip title={t(copied ? 'message.copied' : 'message.copy')}><button type="button" className="pd-message-action" onClick={() => void copy()} disabled={!message.text} aria-label={t(copied ? 'message.copied' : 'message.copy')}><Icon name={copied ? 'check' : 'copy'} width="14" height="14" /></button></HoverTooltip>
					<HoverTooltip title={t('message.edit')}><button type="button" className="pd-message-action" onClick={startEdit} aria-label={t('message.edit')}><Icon name="pencil" width="14" height="14" /></button></HoverTooltip>
				</div>
			</div>
		</div>
	);
});

interface AssistantPresentation { hideThinking?: boolean; process?: boolean; thinkingExpanded?: boolean; hidePending?: boolean }
const AssistantMessageItem = memo(function AssistantMessageItem({ message, highlighted, showHeading = true, findMatch, canRegenerate = false, hideThinking = false, process = false, thinkingExpanded, hidePending = false }: { message: UiMessage; highlighted: boolean; showHeading?: boolean; findMatch?: boolean; canRegenerate?: boolean } & AssistantPresentation) {
	const { t } = useT();
	const c = useConversationCopy();
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
				{hasThinking && !hideThinking && <ThinkingActivity message={message} defaultExpanded={thinkingExpanded} />}
				{message.text && <div ref={bodyRef} data-message-body className="pd-markdown" onPointerUp={inspectSelection} onKeyUp={inspectSelection}><Markdown remarkPlugins={[remarkGfm]} components={{ pre: renderMarkdownPre }}>{message.text}</Markdown></div>}
				{selection && createPortal(<button type="button" className="pd-quote-selection" data-quote-for={message.id} style={{ position: 'fixed', zIndex: 60, ...selectionPosition }} onMouseDown={(event) => event.preventDefault()} onClick={quote}>{c('quote')}</button>, document.body)}
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
const SystemMessageItem = memo(function SystemMessageItem({ message, highlighted, findMatch }: { message: UiMessage; highlighted: boolean; findMatch?: boolean }) {
	const { t } = useT();
	const query = useContext(TranscriptSearchContext).trim().toLocaleLowerCase();
	return (
		<div className={`pd-message-row is-system${highlighted ? ' is-search-match' : ''}${findMatch ? ' is-find-match' : ''}`} data-message-id={message.id}>
			<details className="pd-system-notice" data-system-kind={message.systemKind} open={query && message.text.toLocaleLowerCase().includes(query) ? true : undefined}>
				<summary><Icon name={message.systemKind === 'compaction' ? 'archive' : message.systemKind === 'branch-summary' ? 'gitBranch' : 'file'} width="13" height="13" />{t(`message.system.${message.systemKind ?? 'custom'}`)}</summary>
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
