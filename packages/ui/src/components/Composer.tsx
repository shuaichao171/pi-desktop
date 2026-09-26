import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { UiAttachment, UiContextRequest, UiSlashCommand } from '@pidesktop/shared';
import { inspectAttachmentFile, MAX_ATTACHMENTS } from '../attachmentPolicy';
import { appendFileAttachments, clearSubmittedDraft, type ComposerDraft } from '../composerDrafts';
import { useT, type Translate } from '../i18n';
import { useChatStore } from '../store';
import { Icon } from './Icons';
import { ComposerControls } from './ComposerControls';
import type { ModelManagementTarget } from '../modelManagement';
import { HoverTooltip } from './HoverTooltip';
import { ComposerContextPicker, type ComposerContextPickerHandle } from './ComposerContextPicker';
import { consumeContextMention, contextMentionAt, hasContextSource, type ContextMention } from '../composerContext';
import { completeSlashCommand, slashTriggerAt, type SlashTrigger } from '../composerSlash';
import { ComposerSlashPicker, type ComposerSlashPickerHandle } from './ComposerSlashPicker';
import { ComposerQueue } from './ComposerQueue';
import { ComposerChanges } from './ComposerChanges';
import './composerLayout.css';

type BusyBehavior = 'steer' | 'followUp';

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
	const policy = inspectAttachmentFile(file);
	if ('errorKey' in policy) throw new Error(t(policy.errorKey, { name: file.name }));
	if (policy.kind === 'image') {
		const dataUrl = await new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error(t('composer.imageReadError')));
			reader.onerror = () => reject(reader.error ?? new Error(t('composer.imageReadError')));
			reader.readAsDataURL(file);
		});
		const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
		if (!data) throw new Error(t('composer.imageEmpty', { name: file.name }));
		return { kind: 'image', name: file.name.slice(0, 200), mimeType: policy.mimeType, data };
	}
	return { kind: 'text', name: file.name.slice(0, 200), mimeType: policy.mimeType, text: await file.text() };
}

function attachmentLabel(attachment: UiAttachment, t: Translate): string {
	if (attachment.kind === 'text' && attachment.source) return t(attachment.source.kind === 'session' ? 'composer.contextSession' : attachment.source.kind === 'directory' ? 'composer.contextDirectory' : 'composer.contextFile');
	return t(attachment.kind === 'image' ? 'composer.image' : 'composer.text');
}

export function Composer({ header, onOpenModelManagement }: { header?: ReactNode; onOpenModelManagement(target: ModelManagementTarget): void }) {
	const { t } = useT();
	const bridge = useChatStore((s) => s.bridge);
	const status = useChatStore((s) => s.status);
	const queuedMessages = useChatStore((s) => s.queuedMessages);
	const fileChanges = useChatStore((s) => s.fileChanges);
	const platform = useChatStore((s) => s.appInfo?.platform);
	const cwd = useChatStore((s) => s.cwd);
	const sessionPath = useChatStore((s) => s.sessionPath);
	const sessionId = useChatStore((s) => s.sessionId);
	const send = useChatStore((s) => s.send);
	const abort = useChatStore((s) => s.abort);
	const retryAgent = useChatStore((s) => s.retryAgent);
	const draftKey = draftStorageKey(cwd, sessionPath);
	const [text, setText] = useState(() => readDraft(draftKey));
	const [attachments, setAttachments] = useState<UiAttachment[]>([]);
	const [sending, setSending] = useState(false);
	const [retrying, setRetrying] = useState(false);
	const [attaching, setAttaching] = useState(false);
	const [submissionError, setSubmissionError] = useState<string | null>(null);
	const [draftWarning, setDraftWarning] = useState(false);
	const textRef = useRef(text);
	const attachmentsRef = useRef(attachments);
	const draftsRef = useRef(new Map<string, ComposerDraft>([[draftKey, { text, attachments }]]));
	const pendingAttachmentsRef = useRef(0);
	const sendingRef = useRef(false);
	const currentKeyRef = useRef(draftKey);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const shellRef = useRef<HTMLDivElement>(null);
	const contextButtonRef = useRef<HTMLButtonElement>(null);
	const pickerRef = useRef<ComposerContextPickerHandle>(null);
	const slashPickerRef = useRef<ComposerSlashPickerHandle>(null);
	const [slashTrigger, setSlashTrigger] = useState<SlashTrigger | null>(null);
	const [slashRetry, setSlashRetry] = useState(0);
	const [slashCatalog, setSlashCatalog] = useState<{ key: string; commands: UiSlashCommand[]; loading: boolean; error: string | null }>({ key: '', commands: [], loading: false, error: null });
	const dismissedSlash = useRef<string | null>(null);
	const [contextPicker, setContextPicker] = useState<{ mode: 'menu' } | { mode: 'mention'; mention: ContextMention } | null>(null);
	const dismissedMention = useRef<{ start: number; prefix: string } | null>(null);
	const composingRef = useRef(false);
	const busy = status === 'busy';
	const steerShortcut = platform === 'darwin' ? '⌘Enter' : 'Ctrl+Enter';
	const unavailable = status === 'starting' || status === 'uninitialized' || status === 'error';
	const placeholder = t(status === 'error' ? 'composer.connectionErrorPlaceholder' : unavailable ? 'composer.connecting' : busy ? 'composer.busyPlaceholder' : 'composer.placeholder');
	const canSubmit = Boolean(text.trim() || attachments.length) && !sending && !attaching && !unavailable;
	const slashCatalogKey = JSON.stringify([cwd, sessionId]);
	const slashOpen = slashTrigger !== null;

	useEffect(() => {
		if (!slashOpen || !bridge || unavailable) return;
		let cancelled = false;
		setSlashCatalog({ key: slashCatalogKey, commands: [], loading: true, error: null });
		void bridge.listSlashCommands().then((commands) => {
			if (!cancelled) setSlashCatalog({ key: slashCatalogKey, commands, loading: false, error: null });
		}, (error: unknown) => {
			if (!cancelled) setSlashCatalog({ key: slashCatalogKey, commands: [], loading: false, error: error instanceof Error ? error.message : String(error) });
		});
		return () => { cancelled = true; };
	}, [slashOpen, bridge, unavailable, slashCatalogKey, slashRetry]);

	useLayoutEffect(() => {
		if (currentKeyRef.current === draftKey) return;
		draftsRef.current.set(currentKeyRef.current, { text: textRef.current, attachments: attachmentsRef.current });
		const next = draftsRef.current.get(draftKey) ?? { text: readDraft(draftKey), attachments: [] };
		draftsRef.current.set(draftKey, next);
		currentKeyRef.current = draftKey;
		textRef.current = next.text;
		attachmentsRef.current = next.attachments;
		setText(next.text);
		setAttachments(next.attachments);
		setSubmissionError(null);
		setContextPicker(null);
		dismissedMention.current = null;
		setSlashTrigger(null);
		dismissedSlash.current = null;
	}, [draftKey]);

	useEffect(() => { if (unavailable) { setContextPicker(null); setSlashTrigger(null); } }, [unavailable]);

	useLayoutEffect(() => {
		const shell = shellRef.current;
		const textarea = textareaRef.current;
		if (!shell || !textarea) return;
		const resize = () => {
			textarea.style.height = '0px';
			textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
		};
		resize();
		let frame = 0;
		let previousWidth = shell.clientWidth;
		const observer = new ResizeObserver(() => {
			// Reflow wrapped text on width changes without observing our own height writes.
			if (shell.clientWidth === previousWidth) return;
			previousWidth = shell.clientWidth;
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(resize);
		});
		observer.observe(shell);
		return () => { observer.disconnect(); cancelAnimationFrame(frame); };
	}, [text, placeholder]);

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

	function syncCompletions(value: string, start: number, end: number) {
		if (composingRef.current || contextPicker?.mode === 'menu' || unavailable) return;
		const trigger = slashTriggerAt(value, start, end);
		const signature = trigger ? JSON.stringify(trigger) : null;
		if (trigger && signature !== dismissedSlash.current) {
			setSlashTrigger(trigger);
			setContextPicker(null);
			return;
		}
		setSlashTrigger(null);
		if (!trigger) dismissedSlash.current = null;
		if (attachmentsRef.current.length >= MAX_ATTACHMENTS) { setContextPicker(null); return; }
		const mention = contextMentionAt(value, start, end);
		if (!mention) { dismissedMention.current = null; setContextPicker(null); return; }
		if (dismissedMention.current?.start === mention.start && dismissedMention.current.prefix === value.slice(0, mention.start + 1)) return;
		setContextPicker({ mode: 'mention', mention });
	}

	function closeSlash() {
		dismissedSlash.current = slashTrigger ? JSON.stringify(slashTrigger) : null;
		setSlashTrigger(null);
	}

	function selectSlash(command: UiSlashCommand) {
		if (!slashTrigger || busy && command.requiresIdle) return;
		const completed = completeSlashCommand(textRef.current, slashTrigger, command.name);
		if (!completed) return;
		const key = currentKeyRef.current;
		setSlashTrigger(null);
		dismissedSlash.current = null;
		changeText(completed.text);
		requestAnimationFrame(() => {
			if (currentKeyRef.current !== key) return;
			textareaRef.current?.focus({ preventScroll: true });
			textareaRef.current?.setSelectionRange(completed.caret, completed.caret);
		});
	}

	function closeContext(restoreFocus = false) {
		if (contextPicker?.mode === 'mention') dismissedMention.current = { start: contextPicker.mention.start, prefix: textRef.current.slice(0, contextPicker.mention.start + 1) };
		setContextPicker(null);
		if (restoreFocus) textareaRef.current?.focus({ preventScroll: true });
	}

	function consumeDraftMention(key: string, original: string, mention: ContextMention | null) {
		if (!mention) return;
		const draft = draftsRef.current.get(key);
		if (!draft || draft.text.slice(0, mention.start) !== original.slice(0, mention.start)) return;
		const consumed = consumeContextMention(draft.text, mention);
		if (!consumed) return;
		if (key === currentKeyRef.current) {
			const start = textareaRef.current?.selectionStart ?? consumed.caret;
			const end = textareaRef.current?.selectionEnd ?? start;
			const adjust = (position: number) => position < mention.start ? position : position <= mention.end ? mention.start : position - (mention.end - mention.start);
			changeText(consumed.text);
			requestAnimationFrame(() => {
				if (key === currentKeyRef.current && document.activeElement === textareaRef.current) textareaRef.current?.setSelectionRange(adjust(start), adjust(end));
			});
		} else { draftsRef.current.set(key, { ...draft, text: consumed.text }); writeDraft(key, consumed.text); }
	}

	async function selectContext(request: UiContextRequest) {
		if (!bridge || unavailable) return;
		const key = currentKeyRef.current;
		const original = textRef.current;
		const mention = contextPicker?.mode === 'mention' ? contextPicker.mention : null;
		setContextPicker(null);
		dismissedMention.current = mention ? { start: mention.start, prefix: original.slice(0, mention.start + 1) } : null;
		requestAnimationFrame(() => {
			if (key !== currentKeyRef.current) return;
			textareaRef.current?.focus({ preventScroll: true });
		});
		if (hasContextSource(attachmentsRef.current, request)) { consumeDraftMention(key, original, mention); return; }
		pendingAttachmentsRef.current += 1;
		setAttaching(true);
		setSubmissionError(null);
		try {
			if ((draftsRef.current.get(key)?.attachments.length ?? 0) >= MAX_ATTACHMENTS) throw new Error(t('composer.maxAttachments', { count: MAX_ATTACHMENTS }));
			const attachment = await bridge.readContext(request);
			const current = draftsRef.current.get(key)?.attachments ?? [];
			if (!hasContextSource(current, request)) {
				if (current.length >= MAX_ATTACHMENTS) throw new Error(t('composer.maxAttachments', { count: MAX_ATTACHMENTS }));
				changeAttachments([...current, attachment], key);
			}
			consumeDraftMention(key, original, mention);
		} catch (error) {
			if (currentKeyRef.current === key) setSubmissionError(error instanceof Error ? error.message : String(error));
		} finally {
			pendingAttachmentsRef.current -= 1;
			setAttaching(pendingAttachmentsRef.current > 0);
		}
	}

	async function addFiles(files: File[]) {
		if (!files.length) return;
		const key = currentKeyRef.current;
		pendingAttachmentsRef.current += 1;
		setAttaching(true);
		setSubmissionError(null);
		try {
			await appendFileAttachments(files, (file) => readFileAttachment(file, t),
				() => draftsRef.current.get(key)?.attachments ?? [],
				(next) => changeAttachments(next, key),
				() => new Error(t('composer.maxAttachments', { count: MAX_ATTACHMENTS })));
		} catch (error) {
			if (currentKeyRef.current === key) setSubmissionError(error instanceof Error ? error.message : String(error));
		} finally {
			pendingAttachmentsRef.current -= 1;
			setAttaching(pendingAttachmentsRef.current > 0);
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
		if ((!value && !submittedAttachments.length) || sendingRef.current || pendingAttachmentsRef.current > 0 || unavailable) return;
		const submittedKey = currentKeyRef.current;
		sendingRef.current = true;
		setSending(true);
		setSubmissionError(null);
		setSlashTrigger(null);
		setContextPicker(null);
		try {
			await send(value, busy ? (behavior ?? 'followUp') : undefined, submittedAttachments);
			if (clearSubmittedDraft(draftsRef.current, submittedKey, { text: value, attachments: submittedAttachments })) {
				if (currentKeyRef.current === submittedKey) {
					changeText('');
					changeAttachments([]);
				} else writeDraft(submittedKey, '');
			}
		} catch (error) {
			if (currentKeyRef.current === submittedKey) setSubmissionError(error instanceof Error ? error.message : String(error));
		} finally {
			sendingRef.current = false;
			setSending(false);
		}
	}

	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
		if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
		if (slashTrigger && slashPickerRef.current?.handleKeyDown(event)) return;
		if (contextPicker && pickerRef.current?.handleKeyDown(event)) return;
		if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
		event.preventDefault();
		void submit(busy && (event.ctrlKey || event.metaKey) ? 'steer' : undefined);
	}

	async function retryConnection() {
		if (retrying) return;
		setRetrying(true);
		setSubmissionError(null);
		try { await retryAgent(); }
		catch (error) { setSubmissionError(error instanceof Error ? error.message : String(error)); }
		finally { setRetrying(false); }
	}

	return (
		<div className="pd-composer-dock">
			<div className="pd-composer-wrap">
				{submissionError && <div className="pd-composer-error" role="alert">{submissionError}</div>}
				{draftWarning && <div className="pd-composer-error" role="status">{t('composer.draftWarning')}</div>}
				{fileChanges.length > 0 && <ComposerChanges key={`changes:${cwd}\0${sessionId}`} items={fileChanges} />}
				<ComposerQueue key={`queue:${cwd}\0${sessionId}`} items={queuedMessages} />
				<div ref={shellRef} className={`pd-composer-shell${queuedMessages.length ? ' has-queue' : ''}`} data-composer-layout="multiline" onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={onDrop}>
					{header ? <div className="pd-composer-header">{header}</div> : null}
					{attachments.length > 0 && <div className="pd-composer-attachments" aria-label={t('composer.pendingAttachments')}>{attachments.map((attachment, index) => <div className={`pd-composer-attachment${attachment.kind === 'text' && attachment.source ? ' is-context' : ''}`} key={`${attachment.name}-${index}`}>
						{attachment.kind === 'image' ? <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="" /> : <span className="pd-composer-attachment-type">{attachment.source ? <Icon name={attachment.source.kind === 'session' ? 'message' : attachment.source.kind === 'directory' ? 'folder' : 'file'} width="16" height="16" /> : 'TXT'}</span>}
						<HoverTooltip title={attachment.name} description={attachment.kind === 'text' && attachment.source ? `${attachment.source.workspace}\n${attachment.source.path}${attachment.source.truncated ? `\n${t('composer.contextTruncated')}` : ''}` : attachmentLabel(attachment, t)}><span className="pd-composer-attachment-name" tabIndex={0}>{attachment.name}<small>{attachmentLabel(attachment, t)}{attachment.kind === 'text' && attachment.source?.truncated ? ` · ${t('composer.contextTruncatedShort')}` : ''}</small></span></HoverTooltip>
						<button type="button" onClick={() => { changeAttachments(attachmentsRef.current.filter((_, itemIndex) => itemIndex !== index)); textareaRef.current?.focus(); }} aria-label={t('composer.removeAttachment', { name: attachment.name })}><Icon name="close" width="14" height="14" /></button>
					</div>)}</div>}
					<textarea ref={textareaRef} value={text} rows={2} placeholder={placeholder} aria-label={t('composer.messageLabel')} disabled={unavailable} onChange={(event) => { changeText(event.target.value); syncCompletions(event.target.value, event.target.selectionStart, event.target.selectionEnd); }} onSelect={(event) => syncCompletions(event.currentTarget.value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd)} onCompositionStart={() => { composingRef.current = true; setContextPicker(null); setSlashTrigger(null); }} onCompositionEnd={(event) => { composingRef.current = false; syncCompletions(event.currentTarget.value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd); }} onKeyDown={onKeyDown} onPaste={onPaste} />
					<div className="pd-composer-toolbar">
						<div className="pd-composer-meta">
							<input ref={fileInputRef} type="file" multiple className="pd-composer-file-input" tabIndex={-1} aria-hidden="true" onChange={onFileChange} />
							<HoverTooltip title={t('composer.contextAddTitle')} shortcut="@"><button ref={contextButtonRef} type="button" className="pd-composer-add-attachment" onMouseDown={(event) => event.preventDefault()} onClick={() => { closeSlash(); setContextPicker((current) => current?.mode === 'menu' ? null : { mode: 'menu' }); }} disabled={unavailable || attaching || attachments.length >= MAX_ATTACHMENTS} aria-label={t('composer.contextAddTitle')} aria-haspopup="dialog" aria-expanded={contextPicker !== null}><Icon name="plus" width="16" height="16" /></button></HoverTooltip>
						</div>
						<div className="pd-composer-actions">
							<ComposerControls onOpenModelManagement={onOpenModelManagement} />
							{busy && <><HoverTooltip title={t('composer.stopTitle')}><button type="button" className="pd-composer-action" onClick={() => void abort().catch((error: unknown) => setSubmissionError(error instanceof Error ? error.message : String(error)))} aria-label={t('composer.stopTitle')}><Icon name="square" width="16" height="16" /><span>{t('composer.stop')}</span></button></HoverTooltip><HoverTooltip title={t('composer.steer')} description={t('composer.queuedSteerDescription')} shortcut={steerShortcut}><button type="button" className="pd-composer-action pd-steer-action" onClick={() => void submit('steer')} disabled={!canSubmit} aria-label={t('composer.steer')}><Icon name="steer" width="15" height="15" /><span>{t('composer.steer')}</span></button></HoverTooltip></>}
							{status === 'error' || retrying
								? <button type="button" className="pd-send-button pd-composer-retry" onClick={() => void retryConnection()} disabled={retrying}><Icon name="refresh" width="15" height="15" /><span>{t(retrying ? 'composer.retryingConnection' : 'composer.retryConnection')}</span></button>
								: <button type="button" className="pd-send-button" onClick={() => void submit(busy ? 'followUp' : undefined)} disabled={!canSubmit} aria-label={t(busy ? 'composer.queueSend' : 'composer.send')}><Icon name={busy ? 'queue' : 'arrowUp'} width="16" height="16" /></button>}
						</div>
					</div>
				</div>
				{contextPicker && !unavailable && shellRef.current && <ComposerContextPicker ref={pickerRef} anchor={shellRef.current} trigger={contextButtonRef.current} mode={contextPicker.mode} query={contextPicker.mode === 'mention' ? contextPicker.mention.query : ''} workspace={cwd} sessionPath={sessionPath} onSelect={(request) => void selectContext(request)} onUpload={() => { closeContext(); fileInputRef.current?.click(); }} onClose={closeContext} />}
				{slashTrigger && !unavailable && shellRef.current && <ComposerSlashPicker ref={slashPickerRef} anchor={shellRef.current} query={slashTrigger.query} commands={slashCatalog.key === slashCatalogKey ? slashCatalog.commands : []} loading={slashCatalog.key !== slashCatalogKey || slashCatalog.loading} error={slashCatalog.key === slashCatalogKey ? slashCatalog.error : null} busy={busy} onSelect={selectSlash} onClose={closeSlash} onRetry={() => setSlashRetry((value) => value + 1)} />}
				{attaching && <p className="pd-composer-attachment-hint" role="status">{t('composer.readingAttachments')}</p>}
				{attachments.length > 0 && <p className="pd-composer-attachment-hint">{t('composer.attachmentPersistence')}</p>}
			</div>
		</div>
	);
}
