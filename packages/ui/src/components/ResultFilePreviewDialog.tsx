import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ResultFilePreview, ResultFileTarget } from '@pidesktop/shared';
import { resultFileSessionSnapshot, sameResultFileSession } from '../resultFileContext';
import { useResultFilePreviewStore } from '../resultFilePreviewStore';
import { useT } from '../i18n';
import { useChatStore } from '../store';
import { Icon } from './Icons';
import { WorkbenchTextView } from './WorkbenchTextView';
import { requestCodeQuote } from '../codeQuote';
import { ScopedErrorBoundary } from './ScopedErrorBoundary';
const OfficeFilePreview = lazy(() => import('./OfficeFilePreview'));
import './workbenchReading.css';
import './resultFilePreview.css';

const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

function fileSize(size: number, locale: string): string {
	if (size < 1024) return `${size} B`;
	const unit = size >= 1024 * 1024 ? 'MB' : 'KB';
	return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(size / (unit === 'MB' ? 1024 * 1024 : 1024))} ${unit}`;
}

export function ResultFilePreviewDialog({ target, onClose }: { target: ResultFileTarget; onClose(): void }) {
	const { locale } = useT();
	const label = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
	const bridge = useChatStore(state => state.bridge);
	const titleId = useId();
	const dialog = useRef<HTMLDialogElement>(null);
	const closeButton = useRef<HTMLButtonElement>(null);
	const mounted = useRef(false);
	const closed = useRef(false);
	const request = useRef(0);
	const actionLock = useRef(false);
	const closeCallback = useRef(onClose);
	closeCallback.current = onClose;
	const origin = useRef(resultFileSessionSnapshot(useChatStore.getState()));
	const [retry, setRetry] = useState(0);
	const [result, setResult] = useState<{ key: string; preview: ResultFilePreview } | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [busy, setBusy] = useState<'open' | 'reveal' | null>(null);
	const [zoom, setZoom] = useState<number | null>(null);
	const [mediaError, setMediaError] = useState(false);
	const targetKey = JSON.stringify([target.cwd, target.path, target.line, target.column]);
	const preview = result?.key === targetKey ? result.preview : null;
	const name = preview?.name ?? fileName(target.path);
	const loading = !preview && !loadError;
	const imageSource = preview?.kind === 'image' && /^data:image\/(?:png|jpeg|gif|webp|bmp|x-icon|avif);base64,/i.test(preview.dataUrl ?? '') ? preview.dataUrl : undefined;
	const pdfSource = preview?.kind === 'pdf' && /^data:application\/pdf;base64,/i.test(preview.dataUrl ?? '') ? preview.dataUrl : undefined;
	// A fully sandboxed data: iframe is an opaque, inert document. It inherits the
	// renderer CSP (no inline scripts) anyway, so scripts and forms stay disabled
	// and the preview says so instead of rendering interactive pages half-broken.
	const htmlSource = preview?.kind === 'html' && typeof preview.text === 'string' ? `data:text/html;charset=utf-8,${encodeURIComponent(preview.text)}` : undefined;

	function sameContext() {
		// The first settle of a new conversation assigns its session file path; that
		// upgrade is the same session, so an open preview survives the completion
		// resync instead of vanishing under the click that opened it.
		return sameResultFileSession(origin.current, resultFileSessionSnapshot(useChatStore.getState()));
	}
	function isCurrentContext() { return mounted.current && !closed.current && sameContext(); }
	function close() {
		if (closed.current) return;
		closed.current = true;
		request.current++;
		dialog.current?.close();
		closeCallback.current();
	}

	useEffect(() => {
		mounted.current = true;
		closed.current = false;
		const node = dialog.current;
		const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		node?.showModal();
		closeButton.current?.focus({ preventScroll: true });
		const unsubscribe = useChatStore.subscribe(() => { if (!isCurrentContext()) close(); });
		return () => {
			unsubscribe();
			const restoreFocus = sameContext();
			mounted.current = false;
			request.current++;
			node?.close();
			// A session change may remove the original link while the dialog is open.
			if (restoreFocus && returnFocus?.isConnected && !returnFocus.closest('[inert]')) returnFocus.focus({ preventScroll: true });
		};
	}, []);

	useEffect(() => {
		const currentRequest = ++request.current;
		setResult(null); setLoadError(null); setActionError(null); setZoom(null); setMediaError(false);
		if (!bridge) {
			setLoadError(label('文件服务尚未就绪，请稍后重试。', 'The file service is not ready. Please try again.'));
			return;
		}
		const current = () => isCurrentContext() && request.current === currentRequest;
		void bridge.previewResultFile(target).then(value => {
			if (current()) setResult({ key: targetKey, preview: value });
		}).catch((cause: unknown) => { if (current()) setLoadError(errorMessage(cause)); });
		return () => { if (request.current === currentRequest) request.current++; };
	}, [bridge, targetKey, retry]);

	async function act(action: 'open' | 'reveal') {
		if (!bridge || actionLock.current || !isCurrentContext()) return;
		const currentRequest = request.current;
		actionLock.current = true; setBusy(action); setActionError(null);
		try {
			await (action === 'open' ? bridge.openResultFile(target) : bridge.revealResultFile(target));
		} catch (cause) {
			if (isCurrentContext() && request.current === currentRequest) setActionError(errorMessage(cause));
		} finally {
			actionLock.current = false;
			if (isCurrentContext()) setBusy(null);
		}
	}
	const changeZoom = (delta: number) => setZoom(value => Math.min(4, Math.max(.25, (value ?? 1) + delta)));
	const retryPreview = () => setRetry(value => value + 1);
	const openLabel = preview?.kind === 'directory' ? label('打开文件夹', 'Open folder') : label('打开文件', 'Open file');
	function unavailableReason(): string {
		if (preview?.kind === 'directory') return label('这是一个文件夹，可以打开查看其中的文件。', 'This is a folder. Open it to view its files.');
		if (preview?.reason === 'too-large') return label('文件较大，暂不支持在这里预览。', 'This file is too large to preview here.');
		return label('暂不支持预览此类文件，可以使用默认应用打开。', 'A preview is unavailable for this file type. Open it in its default app.');
	}

	return createPortal(<dialog ref={dialog} className="pd-result-file-preview" role="dialog" aria-modal="true" aria-labelledby={titleId}
		onCancel={event => { event.preventDefault(); close(); }}
		onClick={event => {
			if (event.target !== event.currentTarget) return;
			const bounds = event.currentTarget.getBoundingClientRect();
			if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
		}}
		onKeyDown={event => {
			event.stopPropagation();
			if (preview?.kind !== 'image' || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
			if (event.key === '+' || event.key === '=') { event.preventDefault(); changeZoom(.25); }
			if (event.key === '-') { event.preventDefault(); changeZoom(-.25); }
			if (event.key === '0') setZoom(null);
			if (event.key === '1') setZoom(1);
		}}>
		<header className="pd-result-file-preview-header">
			<Icon name={preview?.kind === 'directory' ? 'folder' : 'file'} width="20" height="20" />
			<div className="pd-result-file-preview-heading"><h2 id={titleId}>{name}</h2><p>{preview?.path ?? target.path}{target.line ? `:${target.line}${target.column ? `:${target.column}` : ''}` : ''}</p></div>
			<button ref={closeButton} type="button" className="pd-result-file-preview-close" aria-label={label('关闭预览', 'Close preview')} onClick={close}><Icon name="close" width="18" height="18" /></button>
		</header>
		<div className="pd-result-file-preview-actions">
			<span>{label('文件预览', 'File preview')}{preview && preview.kind !== 'directory' ? ` · ${fileSize(preview.size, locale)}` : ''}</span>
			<button type="button" disabled={!bridge || busy !== null} onClick={() => void act('open')}><Icon name="arrowUp" width="14" height="14" />{busy === 'open' ? label('正在打开…', 'Opening…') : openLabel}</button>
			<button type="button" disabled={!bridge || busy !== null} onClick={() => void act('reveal')}><Icon name="folder" width="14" height="14" />{busy === 'reveal' ? label('正在打开…', 'Opening…') : label('打开所在位置', 'Show in folder')}</button>
		</div>
		{actionError && <p className="pd-result-file-preview-error" role="alert">{actionError}</p>}
		<ScopedErrorBoundary scope="preview" resetKeys={[targetKey, retry]}><div className={`pd-result-file-preview-body${preview ? ` is-${preview.kind}` : ''}`} aria-busy={loading}>
			{loadError ? <div className="pd-result-file-preview-state" role="alert"><Icon name="file" width="32" height="32" /><strong>{label('无法预览文件', 'Unable to preview this file')}</strong><p>{loadError}</p><button type="button" onClick={retryPreview}>{label('重试', 'Retry')}</button></div> : loading ?
				<div className="pd-result-file-preview-state" role="status"><p>{label('正在加载预览…', 'Loading preview…')}</p></div> : preview?.kind === 'text' ?
				<WorkbenchTextView key={`${targetKey}:${retry}`} path={preview.path} text={preview.text ?? ''} omitted={preview.truncated} onQuote={(quote) => requestCodeQuote({ cwd: target.cwd, path: target.path, ...quote })} /> : preview?.kind === 'image' ? <>
					<div className="pd-result-file-preview-zoom"><button type="button" aria-pressed={zoom === null} onClick={() => setZoom(null)}>{label('适应窗口', 'Fit to window')}</button><button type="button" aria-pressed={zoom === 1} onClick={() => setZoom(1)}>100%</button><button type="button" aria-label={label('缩小', 'Zoom out')} disabled={zoom === .25} onClick={() => changeZoom(-.25)}>−</button><output>{zoom === null ? label('适应', 'Fit') : `${Math.round(zoom * 100)}%`}</output><button type="button" aria-label={label('放大', 'Zoom in')} disabled={zoom === 4} onClick={() => changeZoom(.25)}>+</button></div>
					{mediaError || !imageSource ? <div className="pd-result-file-preview-state" role="alert"><p>{label('无法显示此图片。', 'This image could not be displayed.')}</p><button type="button" onClick={retryPreview}>{label('重试', 'Retry')}</button></div> : <div className={`pd-result-file-preview-image${zoom === null ? ' is-fit' : ''}`}><img key={`${targetKey}:${retry}`} src={imageSource} alt={name} style={zoom === null ? undefined : { zoom }} onError={() => setMediaError(true)} /></div>}
				</> : preview?.kind === 'office' && preview.bytesBase64 && preview.officeFormat ?
				<Suspense fallback={<div className="pd-result-file-preview-state" role="status">{label('正在加载预览…', 'Loading preview…')}</div>}><OfficeFilePreview key={`${targetKey}:${retry}`} bytesBase64={preview.bytesBase64} format={preview.officeFormat} /></Suspense> : preview?.kind === 'pdf' && pdfSource && !mediaError ?
				<iframe className="pd-result-file-preview-pdf" title={`${label('PDF 预览', 'PDF preview')}: ${name}`} src={pdfSource} onError={() => setMediaError(true)} /> : preview?.kind === 'html' && htmlSource ?
				<div className="pd-result-file-preview-html">
					<p className="pd-result-file-preview-note">{label('静态预览：脚本与表单已禁用，交互内容请用默认应用打开。', 'Static preview: scripts and forms are disabled. Open it in the default app for interactive content.')}{preview.truncated ? label('文件较大，仅预览前 1 MB 内容。', ' Only the first 1 MB of this file is previewed.') : null}</p>
					<iframe title={`${label('HTML 预览', 'HTML preview')}: ${name}`} src={htmlSource} sandbox="" referrerPolicy="no-referrer" />
				</div> :
				<div className="pd-result-file-preview-state"><Icon name={preview?.kind === 'directory' ? 'folder' : 'file'} width="36" height="36" /><strong>{preview?.kind === 'directory' ? label('文件夹', 'Folder') : label('暂无预览', 'Preview unavailable')}</strong><p>{preview?.kind === 'pdf' ? label('无法显示此 PDF，请使用默认应用打开。', 'This PDF could not be displayed. Open it in its default app.') : unavailableReason()}</p><button type="button" disabled={!bridge || busy !== null} onClick={() => void act('open')}>{openLabel}</button></div>}
		</div></ScopedErrorBoundary>
	</dialog>, document.body);
}

/** Stable owner of the preview dialog: links anywhere in the transcript open into this one instance. */
export function ResultFilePreviewDialogRoot() {
	const target = useResultFilePreviewStore(state => state.target);
	const close = useResultFilePreviewStore(state => state.close);
	if (!target) return null;
	return <ResultFilePreviewDialog target={target} onClose={close} />;
}
