import { useEffect, useState } from 'react';
import type { UiMessage } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useConversationCopy } from '../conversationCopy';
import { ImagePreviewDialog, type PreviewImage } from './ImagePreviewDialog';
export function MessageImages({ message }: { message: UiMessage }) {
	const c = useConversationCopy();
	const bridge = useChatStore((s) => s.bridge), sessionPath = useChatStore((s) => s.sessionPath);
	const [preview, setPreview] = useState<{ index: number; trigger: HTMLElement } | null>(null);
	useEffect(() => setPreview(null), [sessionPath, message.id]);
	const omittedIndices = new Set(message.attachmentReferences?.map((reference) => reference.index)); let originalIndex = 0;
	const ordered: (PreviewImage & { index: number })[] = (message.attachments ?? []).flatMap((attachment) => {
		while (omittedIndices.has(originalIndex)) originalIndex++; const index = originalIndex++;
		return attachment.kind === 'image' ? [{ index, id: `${message.id}:${index}`, name: attachment.name, attachment }] : [];
	});
	for (const reference of message.attachmentReferences ?? []) if (reference.kind === 'image') ordered.push({ index: reference.index, id: `${message.id}:${reference.index}`, name: reference.name, load: () => {
		if (!bridge || !sessionPath) return Promise.reject(new Error(c('loadFailed')));
		return bridge.getMessageAttachment(sessionPath, message.id, reference.index);
	} });
	const images = ordered.sort((left, right) => left.index - right.index);
	if (!images.length) return null;
	return <div className="pd-message-attachments">{images.map((item, index) => <figure className="pd-message-attachment pd-message-image" key={item.id}><button type="button" aria-label={`${c('preview')}: ${item.name}`} onClick={(event) => setPreview({ index, trigger: event.currentTarget })}>{item.attachment ? <img src={`data:${item.attachment.mimeType};base64,${item.attachment.data}`} alt={item.name} loading="lazy" /> : <span>{c('preview')} · {item.name}</span>}</button><figcaption>{item.name}</figcaption></figure>)}{preview && <ImagePreviewDialog images={images} initialIndex={preview.index} returnFocus={preview.trigger} onClose={() => setPreview(null)} />}</div>;
}
