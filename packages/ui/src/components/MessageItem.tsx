import type { UiAttachment, UiMessage } from '@pidesktop/shared';
import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useT } from '../i18n';
import { useChatStore } from '../store';
import { HoverTooltip } from './HoverTooltip';
import { Icon } from './Icons';
import { ThinkingActivity } from './ThinkingActivity';
import { ActivityLabel } from './ActivityDisclosure';

function AttachmentPreview({ attachment }: { attachment: UiAttachment }) {
	const { t } = useT();
	if (attachment.kind === 'image') {
		return <figure className="pd-message-attachment pd-message-image"><img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt={attachment.name} loading="lazy" /><figcaption>{attachment.name}</figcaption></figure>;
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
const UserMessageItem = memo(function UserMessageItem({ message, highlighted }: { message: UiMessage; highlighted: boolean }) {
	const { t } = useT();
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
		if (!message.text || !navigator.clipboard) return;
		try { await navigator.clipboard.writeText(message.text); } catch { return; }
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
						<textarea ref={textareaRef} value={draft} rows={2} onChange={(event) => { setDraft(event.target.value); syncHeight(); }} onKeyDown={onKeyDown} aria-label={t('message.editLabel')} disabled={submitting} />
						{Boolean(message.attachments?.length) && <div className="pd-message-attachments">{message.attachments?.map((attachment, index) => <AttachmentPreview key={`${attachment.name}-${index}`} attachment={attachment} />)}</div>}
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
		<div className={`pd-message-row is-user${highlighted ? ' is-search-match' : ''}`} data-message-id={message.id}>
			<div className="pd-message-column">
				<div className="pd-user-bubble">{message.text && <p>{message.text}</p>}{Boolean(message.attachments?.length) && <div className="pd-message-attachments">{message.attachments?.map((attachment, index) => <AttachmentPreview key={`${attachment.name}-${index}`} attachment={attachment} />)}</div>}</div>
				<div className="pd-message-actions">
					<button type="button" className="pd-message-action" onClick={() => void copy()} disabled={!message.text} aria-label={t(copied ? 'message.copied' : 'message.copy')}><Icon name={copied ? 'check' : 'copy'} width="14" height="14" /></button>
					<button type="button" className="pd-message-action" onClick={startEdit} aria-label={t('message.edit')}><Icon name="pencil" width="14" height="14" /></button>
				</div>
			</div>
		</div>
	);
});

const AssistantMessageItem = memo(function AssistantMessageItem({ message, highlighted }: { message: UiMessage; highlighted: boolean }) {
	const { t } = useT();
	const [copied, setCopied] = useState(false);
	const [forking, setForking] = useState(false);

	const copy = async () => {
		if (!message.text || !navigator.clipboard) return;
		try { await navigator.clipboard.writeText(message.text); } catch { return; }
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1200);
	};

	const fork = async () => {
		if (forking) return;
		setForking(true);
		try {
			await useChatStore.getState().forkMessage(message.id);
		} catch {
			// The store surfaces the failure in the chat banner.
		} finally {
			setForking(false);
		}
	};

	const hasThinking = Boolean(message.thinking || message.thinkingStatus);
	const showActions = message.status === 'done' && Boolean(message.text);

	if (message.status === 'done' && !message.text && !hasThinking && !message.errorMessage) return null;
	return (
		<div className={`pd-message-row is-assistant${highlighted ? ' is-search-match' : ''}`} data-message-id={message.id}>
			<div className="pd-message-column">
				<div className="pd-assistant-heading"><span className="pd-assistant-mark">π</span><span>Pi</span></div>
				{hasThinking && <ThinkingActivity message={message} />}
				{message.text && <div className="pd-markdown"><Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown></div>}
				{message.status === 'streaming' && message.thinkingStatus !== 'streaming' && <span className="pd-response-pending" role="status"><ActivityLabel active>{t(message.text ? 'message.generating' : 'message.preparing')}</ActivityLabel></span>}
				{message.status === 'error' && <div className="pd-message-interrupted">{message.errorMessage || t('message.interrupted')}</div>}
				{showActions && (
					<div className="pd-message-actions">
						<button type="button" className="pd-message-action" onClick={() => void copy()} aria-label={t(copied ? 'message.copied' : 'message.copy')}><Icon name={copied ? 'check' : 'copy'} width="14" height="14" /></button>
						<button type="button" className="pd-message-action" onClick={() => void fork()} disabled={forking} aria-label={t('message.fork')}><Icon name="gitBranch" width="14" height="14" /></button>
					</div>
				)}
			</div>
		</div>
	);
});
export const MessageItem = memo(function MessageItem({ message, highlighted = false }: { message: UiMessage; highlighted?: boolean }) {
	if (message.role === 'user') return <UserMessageItem message={message} highlighted={highlighted} />;
	return <AssistantMessageItem message={message} highlighted={highlighted} />;
});
