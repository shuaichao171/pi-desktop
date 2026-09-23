import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import type { UiAttachment, UiThinkingLevel } from '@pidesktop/shared';
import { useT, type Translate } from '../i18n';
import { useChatStore } from '../store';
import { Icon } from './Icons';

type BusyBehavior = 'steer' | 'followUp';
type Draft = { text: string; attachments: UiAttachment[] };

const MAX_ATTACHMENTS = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 192 * 1024;
const TEXT_FILE_PATTERN = /\.(txt|md|mdx|json|jsonl|ya?ml|toml|xml|csv|tsv|js|jsx|ts|tsx|css|scss|html?|py|rs|go|java|kt|c|cc|cpp|h|hpp|sh|ps1|sql|log|ini|cfg|env|gitignore)$/i;
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

function draftStorageKey(cwd: string, sessionPath: string | null): string {
	return `pi-desktop:draft:${encodeURIComponent(cwd)}:${encodeURIComponent(sessionPath ?? 'new')}`;
}

function readDraft(key: string): string {
	try { return window.localStorage.getItem(key) ?? ''; }
	catch { return ''; }
}

function writeDraft(key: string, value: string): boolean {
	try {
		if (value) window.localStorage.setItem(key, value);
		else window.localStorage.removeItem(key);
		return true;
	} catch { return false; }
}

async function readFileAttachment(file: File, t: Translate): Promise<UiAttachment> {
	const extension = file.name.split('.').at(-1)?.toLocaleLowerCase() ?? '';
	const imageMimeType = file.type.startsWith('image/') ? file.type : IMAGE_MIME_BY_EXTENSION[extension];
	if (imageMimeType) {
		if (!['image/png', 'image/jpeg', 'image/webp'].includes(imageMimeType)) throw new Error(t('composer.imageTypes', { name: file.name }));
		if (file.size > MAX_IMAGE_BYTES) throw new Error(t('composer.imageSize', { name: file.name }));
		const dataUrl = await new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error(t('composer.imageReadError')));
			reader.onerror = () => reject(reader.error ?? new Error(t('composer.imageReadError')));
			reader.readAsDataURL(file);
		});
		return { kind: 'image', name: file.name.slice(0, 200), mimeType: imageMimeType, data: dataUrl.slice(dataUrl.indexOf(',') + 1) };
	}
	if (!file.type.startsWith('text/') && !TEXT_FILE_PATTERN.test(file.name)) throw new Error(t('composer.fileTypes', { name: file.name }));
	if (file.size > MAX_TEXT_BYTES) throw new Error(t('composer.textSize', { name: file.name }));
	return { kind: 'text', name: file.name.slice(0, 200), mimeType: file.type || 'text/plain', text: await file.text() };
}

function attachmentLabel(attachment: UiAttachment, t: Translate): string {
	return t(attachment.kind === 'image' ? 'composer.image' : 'composer.text');
}

export function Composer() {
	const { t } = useT();
	const status = useChatStore((s) => s.status);
	const model = useChatStore((s) => s.model);
	const modelProvider = useChatStore((s) => s.modelProvider);
	const thinkingLevel = useChatStore((s) => s.thinkingLevel);
	const availableThinkingLevels = useChatStore((s) => s.availableThinkingLevels);
	const models = useChatStore((s) => s.models);
	const settingsLoading = useChatStore((s) => s.settingsLoading);
	const queuedCount = useChatStore((s) => s.queuedCount);
	const cwd = useChatStore((s) => s.cwd);
	const sessionPath = useChatStore((s) => s.sessionPath);
	const send = useChatStore((s) => s.send);
	const abort = useChatStore((s) => s.abort);
	const refreshModels = useChatStore((s) => s.refreshModels);
	const setModel = useChatStore((s) => s.setModel);
	const setThinkingLevel = useChatStore((s) => s.setThinkingLevel);
	const draftKey = draftStorageKey(cwd, sessionPath);
	const [text, setText] = useState(() => readDraft(draftKey));
	const [attachments, setAttachments] = useState<UiAttachment[]>([]);
	const [sending, setSending] = useState(false);
	const [attaching, setAttaching] = useState(false);
	const [submissionError, setSubmissionError] = useState<string | null>(null);
	const [draftWarning, setDraftWarning] = useState(false);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [modelSearch, setModelSearch] = useState('');
	const [pickerError, setPickerError] = useState<string | null>(null);
	const [pickerPending, setPickerPending] = useState(false);
	const textRef = useRef(text);
	const attachmentsRef = useRef(attachments);
	const draftsRef = useRef(new Map<string, Draft>([[draftKey, { text, attachments: [] }]]));
	const currentKeyRef = useRef(draftKey);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const pickerRef = useRef<HTMLDivElement>(null);
	const pickerButtonRef = useRef<HTMLButtonElement>(null);
	const pickerSearchRef = useRef<HTMLInputElement>(null);
	const busy = status === 'busy';
	const unavailable = status === 'starting' || status === 'uninitialized' || status === 'error';
	const canSubmit = Boolean(text.trim() || attachments.length) && !sending && !attaching && !unavailable;
	const canChangeModel = status === 'idle' && !settingsLoading && !pickerPending;
	const filteredModels = useMemo(() => {
		const query = modelSearch.trim().toLocaleLowerCase();
		return models.filter((item) => `${item.provider} ${item.id} ${item.name}`.toLocaleLowerCase().includes(query)).slice(0, 80);
	}, [models, modelSearch]);

	useEffect(() => {
		if (currentKeyRef.current === draftKey) return;
		draftsRef.current.set(currentKeyRef.current, { text: textRef.current, attachments: attachmentsRef.current });
		const next = draftsRef.current.get(draftKey) ?? { text: readDraft(draftKey), attachments: [] };
		currentKeyRef.current = draftKey;
		textRef.current = next.text;
		attachmentsRef.current = next.attachments;
		setText(next.text);
		setAttachments(next.attachments);
		setSubmissionError(null);
		setPickerOpen(false);
	}, [draftKey]);

	useLayoutEffect(() => {
		const textarea = textareaRef.current;
		if (!textarea) return;
		textarea.style.height = 'auto';
		textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
	}, [text]);

	useEffect(() => {
		if (!pickerOpen) return;
		pickerSearchRef.current?.focus();
		void refreshModels().catch((error: unknown) => setPickerError(error instanceof Error ? error.message : String(error)));
		const outside = (event: MouseEvent) => {
			if (!pickerRef.current?.contains(event.target as Node) && !pickerButtonRef.current?.contains(event.target as Node)) setPickerOpen(false);
		};
		document.addEventListener('mousedown', outside);
		return () => document.removeEventListener('mousedown', outside);
	}, [pickerOpen, refreshModels]);

	function changeText(value: string) {
		textRef.current = value;
		setText(value);
		draftsRef.current.set(currentKeyRef.current, { text: value, attachments: attachmentsRef.current });
		if (!writeDraft(currentKeyRef.current, value)) setDraftWarning(true);
		else setDraftWarning(false);
	}

	function changeAttachments(next: UiAttachment[], key = currentKeyRef.current) {
		const draft = draftsRef.current.get(key) ?? { text: key === currentKeyRef.current ? textRef.current : readDraft(key), attachments: [] };
		draftsRef.current.set(key, { ...draft, attachments: next });
		if (currentKeyRef.current === key) {
			attachmentsRef.current = next;
			setAttachments(next);
		}
	}

	async function addFiles(files: File[]) {
		if (!files.length) return;
		const key = currentKeyRef.current;
		setAttaching(true);
		setSubmissionError(null);
		try {
			for (const file of files) {
				const current = draftsRef.current.get(key)?.attachments ?? [];
				if (current.length >= MAX_ATTACHMENTS) throw new Error(t('composer.maxAttachments', { count: MAX_ATTACHMENTS }));
				changeAttachments([...current, await readFileAttachment(file, t)], key);
			}
		} catch (error) {
			setSubmissionError(error instanceof Error ? error.message : String(error));
		} finally {
			setAttaching(false);
		}
	}

	function onFileChange(event: ChangeEvent<HTMLInputElement>) {
		void addFiles(Array.from(event.target.files ?? []));
		event.target.value = '';
	}

	function onDrop(event: DragEvent<HTMLDivElement>) {
		if (!event.dataTransfer.files.length) return;
		event.preventDefault();
		void addFiles(Array.from(event.dataTransfer.files));
	}

	function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
		const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'));
		if (!images.length) return;
		event.preventDefault();
		void addFiles(images);
	}

	async function submit(behavior?: BusyBehavior): Promise<void> {
		const value = textRef.current.trim();
		const submittedAttachments = attachmentsRef.current;
		if ((!value && !submittedAttachments.length) || sending || attaching || unavailable) return;
		const submittedKey = currentKeyRef.current;
		setSending(true);
		setSubmissionError(null);
		try {
			await send(value, busy ? (behavior ?? 'followUp') : undefined, submittedAttachments);
			if (currentKeyRef.current === submittedKey) {
				if (textRef.current.trim() === value && attachmentsRef.current === submittedAttachments) {
					changeText('');
					changeAttachments([]);
				}
			} else {
				draftsRef.current.set(submittedKey, { text: '', attachments: [] });
				writeDraft(submittedKey, '');
			}
		} catch (error) {
			setSubmissionError(error instanceof Error ? error.message : String(error));
		} finally {
			setSending(false);
		}
	}

	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
		if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
		event.preventDefault();
		void submit(busy && (event.ctrlKey || event.metaKey) ? 'steer' : undefined);
	}

	async function chooseModel(provider: string, id: string) {
		if (!canChangeModel) return;
		setPickerPending(true);
		setPickerError(null);
		try { await setModel(provider, id); }
		catch (error) { setPickerError(error instanceof Error ? error.message : String(error)); }
		finally { setPickerPending(false); }
	}

	async function chooseThinking(level: UiThinkingLevel) {
		if (!canChangeModel) return;
		setPickerPending(true);
		setPickerError(null);
		try { await setThinkingLevel(level); }
		catch (error) { setPickerError(error instanceof Error ? error.message : String(error)); }
		finally { setPickerPending(false); }
	}

	return (
		<div className="pd-composer-dock">
			<div className="pd-composer-wrap">
				{submissionError && <div className="pd-composer-error" role="alert">{submissionError}</div>}
				{draftWarning && <div className="pd-composer-error" role="status">{t('composer.draftWarning')}</div>}
				{pickerOpen && <div ref={pickerRef} className="pd-composer-picker-popover" role="dialog" aria-label={t('composer.pickerLabel')} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setPickerOpen(false); pickerButtonRef.current?.focus(); } }}>
					<div className="pd-composer-picker-head"><strong>{t('composer.pickerTitle')}</strong><button type="button" onClick={() => setPickerOpen(false)} aria-label={t('composer.pickerClose')}><Icon name="close" width="15" height="15" /></button></div>
					<input ref={pickerSearchRef} className="pd-composer-picker-search" type="search" value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} placeholder={t('composer.pickerSearchPlaceholder')} aria-label={t('composer.pickerSearchLabel')} />
					{pickerError && <div className="pd-composer-picker-error" role="alert">{pickerError}</div>}
					<div className="pd-composer-picker-list" aria-label={t('composer.pickerList')}>
						{filteredModels.map((item) => <button key={`${item.provider}/${item.id}`} type="button" className={`pd-composer-picker-model${item.provider === modelProvider && item.id === model ? ' is-selected' : ''}`} aria-pressed={item.provider === modelProvider && item.id === model} disabled={!canChangeModel} onClick={() => void chooseModel(item.provider, item.id)}><span><strong>{item.name || item.id}</strong><small>{item.provider}/{item.id}</small></span>{item.provider === modelProvider && item.id === model && <em>{t('composer.pickerCurrent')}</em>}</button>)}
						{filteredModels.length === 0 && <div className="pd-composer-picker-empty">{t(settingsLoading ? 'composer.pickerLoading' : modelSearch ? 'composer.pickerNoMatch' : 'composer.pickerEmpty')}</div>}
					</div>
					<div className="pd-composer-picker-thinking"><strong>{t('composer.pickerThinking')}</strong><div>{availableThinkingLevels.map((level) => <button key={level} type="button" className={thinkingLevel === level ? 'is-selected' : ''} aria-pressed={thinkingLevel === level} disabled={!canChangeModel} onClick={() => void chooseThinking(level)}>{t(`composer.thinking.${level}`)}</button>)}</div></div>
					{status !== 'idle' && <p className="pd-composer-picker-hint">{t('composer.pickerBusy')}</p>}
				</div>}
				<div className="pd-composer-shell" onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={onDrop}>
					{attachments.length > 0 && <div className="pd-composer-attachments" aria-label={t('composer.pendingAttachments')}>{attachments.map((attachment, index) => <div className="pd-composer-attachment" key={`${attachment.name}-${index}`}>
						{attachment.kind === 'image' ? <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="" /> : <span className="pd-composer-attachment-type">TXT</span>}
						<span className="pd-composer-attachment-name" title={attachment.name}>{attachment.name}<small>{attachmentLabel(attachment, t)}</small></span>
						<button type="button" onClick={() => changeAttachments(attachmentsRef.current.filter((_, itemIndex) => itemIndex !== index))} aria-label={t('composer.removeAttachment', { name: attachment.name })}><Icon name="close" width="14" height="14" /></button>
					</div>)}</div>}
					<textarea ref={textareaRef} value={text} rows={2} placeholder={t(unavailable ? 'composer.connecting' : busy ? 'composer.busyPlaceholder' : 'composer.placeholder')} aria-label={t('composer.messageLabel')} disabled={unavailable} onChange={(event) => changeText(event.target.value)} onKeyDown={onKeyDown} onPaste={onPaste} />
					<div className="pd-composer-toolbar">
						<div className="pd-composer-meta">
							<input ref={fileInputRef} type="file" multiple className="pd-composer-file-input" tabIndex={-1} aria-hidden="true" onChange={onFileChange} />
							<button type="button" className="pd-composer-add-attachment" onClick={() => fileInputRef.current?.click()} disabled={unavailable || attaching || attachments.length >= MAX_ATTACHMENTS} aria-label={t('composer.addAttachment')} title={t('composer.addAttachment')}><Icon name="plus" width="16" height="16" /></button>
							<button ref={pickerButtonRef} type="button" className="pd-model-chip pd-composer-model-trigger" onClick={() => { setPickerError(null); setPickerOpen((open) => !open); }} aria-haspopup="dialog" aria-expanded={pickerOpen} title={model ? `${modelProvider}/${model} · ${t('composer.thinkingTitle', { level: thinkingLevel ? t(`composer.thinking.${thinkingLevel}`) : '' })}` : t('composer.selectModel')}><span>{model || t('composer.selectModel')}</span><Icon name="chevronDown" width="13" height="13" /></button>
							<span className="pd-keyboard-hint">{busy ? queuedCount > 0 ? t('composer.queueHint', { count: queuedCount }) : t('composer.busyHint') : t('composer.idleHint')}</span>
						</div>
						<div className="pd-composer-actions">
							{busy && <><button type="button" className="pd-composer-action" onClick={() => void abort().catch((error: unknown) => setSubmissionError(error instanceof Error ? error.message : String(error)))} title={t('composer.stopTitle')} aria-label={t('composer.stopTitle')}><Icon name="square" width="16" height="16" /><span>{t('composer.stop')}</span></button><button type="button" className="pd-composer-action pd-steer-action" onClick={() => void submit('steer')} disabled={!canSubmit} title={t('composer.steerTitle')}>{t('composer.steer')}</button></>}
							<button type="button" className="pd-send-button" onClick={() => void submit(busy ? 'followUp' : undefined)} disabled={!canSubmit} title={t(busy ? 'composer.queueSendTitle' : 'composer.sendTitle')}><span>{t(sending ? 'composer.sending' : busy ? 'composer.queueSend' : 'composer.send')}</span><Icon name="arrowUp" width="16" height="16" /></button>
						</div>
					</div>
				</div>
				{attaching && <p className="pd-composer-attachment-hint" role="status">{t('composer.readingAttachments')}</p>}
				{attachments.length > 0 && <p className="pd-composer-attachment-hint">{t('composer.attachmentPersistence')}</p>}
			</div>
		</div>
	);
}
