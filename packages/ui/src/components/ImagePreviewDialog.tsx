import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { UiAttachment } from '@pidesktop/shared';
import { useConversationCopy } from '../conversationCopy';
export interface PreviewImage { id: string; name: string; attachment?: Extract<UiAttachment, { kind: 'image' }>; load?: () => Promise<UiAttachment> }
export function ImagePreviewDialog({ images, initialIndex, onClose, returnFocus }: { images: PreviewImage[]; initialIndex: number; onClose(): void; returnFocus: HTMLElement | null }) {
	const c = useConversationCopy(); const titleId = useId();
	const dialog = useRef<HTMLDialogElement>(null);
	const [index, setIndex] = useState(Math.min(initialIndex, images.length - 1));
	const [zoom, setZoom] = useState<number | null>(null);
	const [retry, setRetry] = useState(0);
	const [loaded, setLoaded] = useState<{ id: string; attachment: Extract<UiAttachment, { kind: 'image' }> } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const item = images[index];
	const image = item?.attachment ?? (loaded?.id === item?.id ? loaded?.attachment : undefined);
	useEffect(() => { dialog.current?.showModal(); return () => { dialog.current?.close(); if (returnFocus?.isConnected && !returnFocus.closest('[inert]')) returnFocus.focus({ preventScroll: true }); }; }, [returnFocus]);
	useEffect(() => {
		setZoom(null); setError(null); setLoaded(null); let cancelled = false;
		if (item && !item.attachment) void (item.load?.() ?? Promise.reject(new Error(c('loadFailed')))).then((attachment) => {
			if (attachment.kind !== 'image') throw new Error(c('loadFailed'));
			if (!cancelled) setLoaded({ id: item.id, attachment });
		}).catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
		return () => { cancelled = true; };
	}, [item?.id, retry]);
	const step = (delta: number) => setIndex((value) => (value + delta + images.length) % images.length);
	const changeZoom = (delta: number) => setZoom((value) => Math.min(4, Math.max(.25, (value ?? 1) + delta)));
	return createPortal(<dialog ref={dialog} className="pd-image-preview" role="dialog" aria-modal="true" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={(event) => {
		event.stopPropagation(); if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
		if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); }
		if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
		if (event.key === '+' || event.key === '=') changeZoom(.25);
		if (event.key === '-') changeZoom(-.25);
		if (event.key === '0') setZoom(null); if (event.key === '1') setZoom(1);
	}}><header><strong id={titleId}>{item?.name}</strong><span>{index + 1} / {images.length}</span><button type="button" onClick={onClose} autoFocus>{c('close')}</button></header><div className="pd-image-preview-toolbar"><button type="button" onClick={() => setZoom(null)} aria-pressed={zoom === null}>{c('fit')}</button><button type="button" onClick={() => setZoom(1)} aria-pressed={zoom === 1}>100%</button><button type="button" onClick={() => changeZoom(-.25)} aria-label={c('zoomOut')}>−</button><output>{zoom ? `${Math.round(zoom * 100)}%` : c('fit')}</output><button type="button" onClick={() => changeZoom(.25)} aria-label={c('zoomIn')}>+</button><button type="button" disabled={images.length < 2} onClick={() => step(-1)}>{c('previous')}</button><button type="button" disabled={images.length < 2} onClick={() => step(1)}>{c('next')}</button></div><div className={`pd-image-preview-body${zoom === null ? ' is-fit' : ''}`}>
		{error ? <div role="alert"><p>{error}</p><button type="button" onClick={() => setRetry((value) => value + 1)}>{c('retry')}</button></div> : !image ? <p role="status">{c('loading')}</p> : <img key={`${item?.id}:${retry}`} src={`data:${image.mimeType};base64,${image.data}`} alt={item?.name} style={zoom ? { zoom } : undefined} onError={() => setError(c('loadFailed'))} />}
	</div></dialog>, document.body);
}
