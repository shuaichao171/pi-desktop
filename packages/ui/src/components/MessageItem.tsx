import type { UiAttachment, UiMessage } from '@pidesktop/shared';
import { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useT } from '../i18n';

function AttachmentPreview({ attachment }: { attachment: UiAttachment }) {
	const { t } = useT();
	if (attachment.kind === 'image') {
		return <figure className="pd-message-attachment pd-message-image"><img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt={attachment.name} loading="lazy" /><figcaption>{attachment.name}</figcaption></figure>;
	}
	const previewLength = 4000;
	return <details className="pd-message-attachment pd-message-text-file"><summary>{attachment.name} <span>{t('message.textFile')}</span></summary><pre className="pd-message-text-preview">{attachment.text.slice(0, previewLength)}{attachment.text.length > previewLength ? `\n${t('message.previewTruncated')}` : ''}</pre></details>;
}

export const MessageItem = memo(function MessageItem({ message }: { message: UiMessage }) {
	const { t } = useT();
	if (message.role === 'user') {
		return (
			<div className="pd-message-row is-user">
				<div className="pd-message-column"><div className="pd-user-bubble">{message.text && <p>{message.text}</p>}{Boolean(message.attachments?.length) && <div className="pd-message-attachments">{message.attachments?.map((attachment, index) => <AttachmentPreview key={`${attachment.name}-${index}`} attachment={attachment} />)}</div>}</div></div>
			</div>
		);
	}

	if (!message.text && message.status === 'done') return null;

	return (
		<div className="pd-message-row is-assistant">
			<div className="pd-message-column">
				<div className="pd-assistant-heading"><span className="pd-assistant-mark">π</span><span>Pi</span></div>
				<div className="pd-markdown"><Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown></div>
				{message.status === 'streaming' && <span className="pd-stream-cursor" aria-label={t('message.generating')}>▍</span>}
				{message.status === 'error' && <div className="pd-message-interrupted">{message.errorMessage || t('message.interrupted')}</div>}
			</div>
		</div>
	);
});
