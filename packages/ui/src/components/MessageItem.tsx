import type { UiAttachment, UiMessage } from '@pidesktop/shared';
import { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useT } from '../i18n';
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

export const MessageItem = memo(function MessageItem({ message, highlighted = false }: { message: UiMessage; highlighted?: boolean }) {
	const { t } = useT();
	if (message.role === 'user') {
		return (
			<div className={`pd-message-row is-user${highlighted ? ' is-search-match' : ''}`} data-message-id={message.id}>
				<div className="pd-message-column"><div className="pd-user-bubble">{message.text && <p>{message.text}</p>}{Boolean(message.attachments?.length) && <div className="pd-message-attachments">{message.attachments?.map((attachment, index) => <AttachmentPreview key={`${attachment.name}-${index}`} attachment={attachment} />)}</div>}</div></div>
			</div>
		);
	}

	const hasThinking = Boolean(message.thinking || message.thinkingStatus);
	if (!message.text && !hasThinking && message.status === 'done') return null;

	return (
		<div className={`pd-message-row is-assistant${highlighted ? ' is-search-match' : ''}`} data-message-id={message.id}>
			<div className="pd-message-column">
				<div className="pd-assistant-heading"><span className="pd-assistant-mark">π</span><span>Pi</span></div>
				{hasThinking && <ThinkingActivity message={message} />}
				{message.text && <div className="pd-markdown"><Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown></div>}
				{message.status === 'streaming' && message.thinkingStatus !== 'streaming' && <span className="pd-response-pending" role="status"><ActivityLabel active>{t(message.text ? 'message.generating' : 'message.preparing')}</ActivityLabel></span>}
				{message.status === 'error' && <div className="pd-message-interrupted">{message.errorMessage || t('message.interrupted')}</div>}
			</div>
		</div>
	);
});
