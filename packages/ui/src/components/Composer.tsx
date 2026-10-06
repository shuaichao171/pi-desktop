import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import type { UiAttachment, UiContextRequest, UiSlashCommand } from '@pidesktop/shared';
import { inspectAttachmentFile, MAX_ATTACHMENTS } from '../attachmentPolicy';
import { appendFileAttachments, clearSubmittedDraft, restoreSubmittedDraft, type ComposerDraft } from '../composerDrafts';
import { useT, type Translate } from '../i18n';
import { useChatStore } from '../store';
import { Icon } from './Icons';
import { ComposerControls } from './ComposerControls';
import { ExtensionDialogSlot } from './ExtensionDialogHost';
import type { ModelManagementTarget } from '../modelManagement';
import { HoverTooltip } from './HoverTooltip';
import { ComposerContextPicker, type ComposerContextPickerHandle } from './ComposerContextPicker';
import { consumeContextMention, contextMentionAt, hasContextSource, type ContextMention } from '../composerContext';
import { ADD_CONTEXT_EVENT, hasWorkspaceEntryDrag, isWorkspaceEntryContext, readWorkspaceEntryDrag } from '../workspaceContextTransfer';
import { completeSlashCommand, slashTriggerAt, type SlashTrigger } from '../composerSlash';
import { ComposerSlashPicker, type ComposerSlashPickerHandle } from './ComposerSlashPicker';
import { ComposerQueue } from './ComposerQueue';
import './composerLayout.css';
import { appendQuote } from '../conversationState';
import { appendCodeQuote, CODE_QUOTE_EVENT, isCodeQuote } from '../codeQuote';
import { useConversationCopy } from '../conversationCopy';
import { ImagePreviewDialog } from './ImagePreviewDialog';
import type { InputFeatureBridge, UiInputScope, UiStoredAttachment } from '../../../shared/src/inputFeatures';
import { PersistedComposerDrafts } from '../persistedDrafts';
import { useBusyInputBehavior, type BusyInputBehavior as BusyBehavior } from '../busyInputBehavior';
import { ConversationMetrics } from './ConversationMetrics';
import { PromptHistoryCursor, promptHistoryDirection, readPromptHistory, savePromptHistory } from '../promptHistory';

/** Plain text beyond this size pastes as a dated .txt attachment instead of flooding the editor (zcode LONG_PASTE_THRESHOLD). */
const LONG_PASTE_THRESHOLD = 15 * 1024;

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

async function readFileAttachment(file: File, t: Translate, pdf?: (file: File) => Promise<UiAttachment>): Promise<UiAttachment> {
	const policy = inspectAttachmentFile(file);
	if ('errorKey' in policy) throw new Error(t(policy.errorKey, { name: file.name }));
	if (policy.kind === 'pdf') { if (!pdf) throw new Error('PDF处理服务尚未就绪'); return pdf(file); }
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

export function Composer({ header, onOpenModelManagement, changesSlotRef }: { header?: ReactNode; onOpenModelManagement(target: ModelManagementTarget): void; changesSlotRef?: Ref<HTMLDivElement> }) {
	const { t, locale } = useT(); const zh = locale === 'zh-CN';
	const c = useConversationCopy();
	const [imagePreview, setImagePreview] = useState<{ index: number; trigger: HTMLElement } | null>(null);
	const [quotes, setQuotes] = useState<{ key: string; block: string; source: string }[]>([]);
	const bridge = useChatStore((s) => s.bridge);
	const status = useChatStore((s) => s.status);
	const hasConversationHistory = useChatStore((s) => s.messages.length > 0);
	const navigating = useChatStore((s) => s.navigationPending || s.sessionLoading);
	const sessionPreparation = useChatStore((s) => s.sessionPreparation);
	const draftTransfer = useChatStore((s) => s.draftTransfer);
	const backgroundDraftTransfers = useChatStore((s) => s.backgroundDraftTransfers);
	const queuedMessages = useChatStore((s) => s.queuedMessages);
	const platform = useChatStore((s) => s.appInfo?.platform);
	const cwd = useChatStore((s) => s.cwd);
	const sessionPath = useChatStore((s) => s.sessionPath);
	const sessionId = useChatStore((s) => s.sessionId);
	const send = useChatStore((s) => s.send);
	const abort = useChatStore((s) => s.abort);
	const retryAgent = useChatStore((s) => s.retryAgent);
	const draftScope = sessionPreparation?.draftScope ?? { cwd, sessionPath };
	const draftKey = draftStorageKey(draftScope.cwd, draftScope.sessionPath);
	const stopScopeKey = JSON.stringify([cwd, sessionPath, sessionId]);
	const [text, setText] = useState(() => readDraft(draftKey));
	const historyCursor = useRef(new PromptHistoryCursor());
	const [historyIndex, setHistoryIndex] = useState<number | null>(null);
	const [attachments, setAttachments] = useState<UiAttachment[]>([]);
	const [sending, setSending] = useState(false);
	const stopRequestsRef = useRef(new Map<string, { bridge: typeof bridge }>());
	const [stopRequests, setStopRequests] = useState(() => new Map(stopRequestsRef.current));
	const [retrying, setRetrying] = useState(false);
	const [attaching, setAttaching] = useState(false);
	const [restoringDraft, setRestoringDraft] = useState(false);
	const [submissionError, setSubmissionError] = useState<string | null>(null);
	const [draftWarning, setDraftWarning] = useState(false);
	const [missingAttachments, setMissingAttachments] = useState<UiStoredAttachment[]>([]);
	const [queueEditorTarget, setQueueEditorTarget] = useState<HTMLDivElement | null>(null);
	const [queueEditing, setQueueEditing] = useState(false);
	const [defaultBusyBehavior, setDefaultBusyBehavior] = useBusyInputBehavior();
	const [restoredDraftKey, setRestoredDraftKey] = useState<string | null>(null);
	const [pdfCount, setPdfCount] = useState(0);
	const durable = useRef<{ bridge: unknown; drafts: PersistedComposerDrafts } | null>(null);
	const loadedDrafts = useRef(new Set<string>());
	const draftHydrations = useRef(new Map<string, { scope: UiInputScope; promise: ReturnType<PersistedComposerDrafts['load']>; textRevision: number; attachmentRevision: number }>());
	const hydrationScopes = useRef(new Map<string, UiInputScope>());
	const missingByKey = useRef(new Map<string, UiStoredAttachment[]>());
	const pdfJobs = useRef(new Set<string>());
	const sendRequest = useRef<{ key: string; scope: { cwd: string; sessionPath: string | null }; text: string; attachments: UiAttachment[]; id: string; behavior?: BusyBehavior; preparationRequestId?: number } | null>(null);
	const handledDraftTransfers = useRef(new Set<number>());
	const attachmentTargets = useRef(new Set<{ key: string }>());
	const transferredScopes = useRef(new Map<string, UiInputScope>());
	const submissionErrorsByKey = useRef(new Map<string, string>());
	const textRef = useRef(text);
	const attachmentsRef = useRef(attachments);
	const draftsRef = useRef(new Map<string, ComposerDraft>([[draftKey, { text, attachments }]]));
	const textEdits = useRef(new Map<string, number>());
	const attachmentEdits = useRef(new Map<string, number>());
	const pendingAttachmentsRef = useRef(0);
	const pendingDraftRestoresRef = useRef(new Map<string, number>());
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
	const alternateShortcut = platform === 'darwin' ? '⌘Enter' : 'Ctrl+Enter';
	const stopping = bridge !== null && stopRequests.get(stopScopeKey)?.bridge === bridge;
	const unavailable = !sessionPreparation && (navigating || status === 'starting' || status === 'uninitialized' || status === 'error');
	const contextUnavailable = unavailable || Boolean(sessionPreparation);
	const canPersistDraft = !sessionPreparation && !navigating && Boolean(cwd && sessionId) && status !== 'starting' && status !== 'uninitialized' && status !== 'error';
	const busyHint = t('composer.busyHint', { action: t(defaultBusyBehavior === 'followUp' ? 'composer.queueSend' : 'composer.steer'), alternate: t(defaultBusyBehavior === 'followUp' ? 'composer.steer' : 'composer.queueSend'), shortcut: alternateShortcut });
	// ZCode-style semantic split: fresh conversation invites a new task, an
	// existing thread invites a follow-up (busy keeps the queue/steer hint).
	const placeholder = status === 'error' ? t('composer.connectionErrorPlaceholder') : unavailable ? t('composer.connecting') : busy ? busyHint : t(hasConversationHistory ? 'composer.placeholderFollowUp' : 'composer.placeholder');
	const hasContent = Boolean(text.trim() || attachments.length);
	const showStop = busy && !hasContent;
	const primaryActionLabel = t(showStop ? stopping ? 'composer.stopping' : 'composer.stopTitle' : 'composer.send');
	const canSubmit = hasContent && !sending && !attaching && !restoringDraft && !unavailable && status !== 'error' && !missingAttachments.length;
	const slashCatalogKey = JSON.stringify([cwd, sessionId]);
	const slashOpen = slashTrigger !== null;
	const inputBridge = bridge as Partial<InputFeatureBridge> | null;
	if (inputBridge?.getInputDraft && durable.current?.bridge !== bridge) { durable.current = { bridge, drafts: new PersistedComposerDrafts(inputBridge as InputFeatureBridge) }; loadedDrafts.current.clear(); draftHydrations.current.clear(); hydrationScopes.current.clear(); handledDraftTransfers.current.clear(); transferredScopes.current.clear(); }
	function persistTransferredDraft(key: string) {
		const scope = transferredScopes.current.get(key), draft = draftsRef.current.get(key);
		if (scope && draft && useChatStore.getState().bridge === bridge) {
			writeDraft(key, draft.text);
			void durable.current?.drafts.save(scope, draft).catch(() => setDraftWarning(true));
		}
	}
	function applyDraftTransfer(transfer: typeof draftTransfer, background = false) {
		if (useChatStore.getState().bridge !== bridge) return;
		if (!transfer || handledDraftTransfers.current.has(transfer.requestId)) return;
		const from = draftStorageKey(transfer.from.cwd, transfer.from.sessionPath);
		const to = draftStorageKey(transfer.to.cwd, transfer.to.sessionPath);
		if (!background && currentKeyRef.current !== from && draftKey !== to && sendRequest.current?.preparationRequestId !== transfer.requestId) return;
		if (currentKeyRef.current === from) draftsRef.current.set(from, { text: textRef.current, attachments: attachmentsRef.current });
		let draft = draftsRef.current.get(from) ?? { text: readDraft(from), attachments: [] };
		if (background) draft = restoreSubmittedDraft(draftsRef.current, to, draft);
		draftsRef.current.set(to, draft);
		transferredScopes.current.set(to, transfer.to);
		// In-flight file/context reads follow their draft through every handoff.
		// Only those jobs move: reopening the source conversation keeps its identity.
		for (const target of attachmentTargets.current) if (target.key === from) target.key = to;
		const hydration = draftHydrations.current.get(from);
		if (hydration && !loadedDrafts.current.has(from)) {
			draftHydrations.current.set(to, hydration);
			hydrationScopes.current.set(to, hydration.scope);
		} else loadedDrafts.current.add(to);
		missingByKey.current.set(to, missingByKey.current.get(from) ?? []);
		textEdits.current.set(to, background ? Math.max(textEdits.current.get(to) ?? 0, textEdits.current.get(from) ?? 0) + 1 : textEdits.current.get(from) ?? 0);
		attachmentEdits.current.set(to, background ? Math.max(attachmentEdits.current.get(to) ?? 0, attachmentEdits.current.get(from) ?? 0) + 1 : attachmentEdits.current.get(from) ?? 0);
		if (sendRequest.current?.preparationRequestId === transfer.requestId) { sendRequest.current.key = to; sendRequest.current.scope = transfer.to; }
		writeDraft(to, draft.text);
		handledDraftTransfers.current.add(transfer.requestId);
		if (background) {
			if (currentKeyRef.current === to) { textRef.current = draft.text; attachmentsRef.current = draft.attachments; setText(draft.text); setAttachments(draft.attachments); }
			persistTransferredDraft(to);
		}
	}
	useLayoutEffect(() => {
		if (!backgroundDraftTransfers.length) return;
		for (const transfer of backgroundDraftTransfers) applyDraftTransfer(transfer, true);
		const consumed = new Set(backgroundDraftTransfers.map(transfer => transfer.requestId));
		useChatStore.setState(state => ({ backgroundDraftTransfers: state.backgroundDraftTransfers.filter(transfer => !consumed.has(transfer.requestId)) }));
	}, [backgroundDraftTransfers]);
	useEffect(() => {
		const persistence = durable.current?.drafts;
		// A read already started in the original session may finish during preparation.
		// Reuse it across the handoff, without issuing IPC for a temporary scope.
		let hydration = draftHydrations.current.get(draftKey);
		if ((!canPersistDraft && !hydration) || !persistence || loadedDrafts.current.has(draftKey)) { setRestoringDraft(false); setMissingAttachments(missingByKey.current.get(draftKey) ?? []); return; }
		const key = draftKey;
		if (!hydration) {
			const scope = hydrationScopes.current.get(key) ?? { cwd, sessionPath };
			hydration = { scope, promise: persistence.load(scope), textRevision: textEdits.current.get(key) ?? 0, attachmentRevision: attachmentEdits.current.get(key) ?? 0 };
			draftHydrations.current.set(key, hydration);
		}
		const pendingHydration = hydration;
		let cancelled = false, tracked = true;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		pendingDraftRestoresRef.current.set(key, (pendingDraftRestoresRef.current.get(key) ?? 0) + 1); setRestoringDraft(true);
		const finishRestore = () => {
			if (!tracked) return;
			tracked = false;
			const pending = Math.max(0, (pendingDraftRestoresRef.current.get(key) ?? 0) - 1);
			if (pending) pendingDraftRestoresRef.current.set(key, pending); else pendingDraftRestoresRef.current.delete(key);
			if (!cancelled && currentKeyRef.current === key) setRestoringDraft(pending > 0);
		};
		async function restore(attempt = 0): Promise<void> {
			try {
				const { draft, missing } = await pendingHydration.promise;
				if (cancelled) return;
				loadedDrafts.current.add(key);
				const local = draftsRef.current.get(key), editedWhileLoading = (textEdits.current.get(key) ?? 0) !== pendingHydration.textRevision;
				const attachmentsEditedWhileLoading = (attachmentEdits.current.get(key) ?? 0) !== pendingHydration.attachmentRevision;
				const nextMissing = attachmentsEditedWhileLoading ? [] : missing;
				missingByKey.current.set(key, nextMissing);
				const next = { text: editedWhileLoading ? local?.text ?? '' : local?.text || draft.text, attachments: attachmentsEditedWhileLoading ? local?.attachments ?? [] : local?.attachments.length ? local.attachments : draft.attachments };
				draftsRef.current.set(key, next);
				if (currentKeyRef.current === key) { textRef.current = next.text; attachmentsRef.current = next.attachments; setText(next.text); setAttachments(next.attachments); setMissingAttachments(nextMissing); setRestoredDraftKey(key); writeDraft(key, next.text); }
			} catch {
				if (cancelled) return;
				// Recovery is best effort. Keep current input usable, preserve the
				// original edit revisions across retries, and never save over an unread draft.
				if (attempt < 2) retryTimer = setTimeout(() => {
					pendingHydration.promise = persistence!.load(pendingHydration.scope);
					void restore(attempt + 1);
				}, attempt === 0 ? 500 : 1500);
				else if (draftHydrations.current.get(key) === pendingHydration) draftHydrations.current.delete(key);
			} finally { finishRestore(); }
		}
		void restore();
		return () => { cancelled = true; clearTimeout(retryTimer); finishRestore(); };
	}, [bridge, draftKey, canPersistDraft]);
	useEffect(() => {
		if (!canPersistDraft || !loadedDrafts.current.has(draftKey) || missingAttachments.length || text !== textRef.current || attachments !== attachmentsRef.current) return;
		void durable.current?.drafts.save({ cwd, sessionPath }, { text, attachments }).catch(() => { if (currentKeyRef.current === draftKey) setDraftWarning(true); });
	}, [text, attachments, draftKey, missingAttachments, canPersistDraft, restoredDraftKey]);

	useEffect(() => {
		if (!slashOpen || !bridge || contextUnavailable) return;
		let cancelled = false;
		setSlashCatalog({ key: slashCatalogKey, commands: [], loading: true, error: null });
		void bridge.listSlashCommands().then((commands) => {
			if (!cancelled) setSlashCatalog({ key: slashCatalogKey, commands, loading: false, error: null });
		}, (error: unknown) => {
			if (!cancelled) setSlashCatalog({ key: slashCatalogKey, commands: [], loading: false, error: error instanceof Error ? error.message : String(error) });
		});
		return () => { cancelled = true; };
	}, [slashOpen, bridge, contextUnavailable, slashCatalogKey, slashRetry]);

	useLayoutEffect(() => {
		applyDraftTransfer(draftTransfer);
		if (currentKeyRef.current === draftKey) return;
		draftsRef.current.set(currentKeyRef.current, { text: textRef.current, attachments: attachmentsRef.current });
		const next = draftsRef.current.get(draftKey) ?? { text: readDraft(draftKey), attachments: [] };
		draftsRef.current.set(draftKey, next);
		currentKeyRef.current = draftKey;
		historyCursor.current.reset(); setHistoryIndex(null);
		textRef.current = next.text;
		attachmentsRef.current = next.attachments;
		setText(next.text);
		setAttachments(next.attachments);
		setSubmissionError(submissionErrorsByKey.current.get(draftKey) ?? null);
		setMissingAttachments(missingByKey.current.get(draftKey) ?? []);
		setContextPicker(null);
		dismissedMention.current = null;
		setSlashTrigger(null);
		dismissedSlash.current = null;
		setRestoringDraft((pendingDraftRestoresRef.current.get(draftKey) ?? 0) > 0);
	}, [draftKey, draftTransfer]);
	useEffect(() => { setImagePreview(null); }, [draftKey]);
	useEffect(() => {
		const quote = (event: Event) => {
			const detail = (event as CustomEvent<{ cwd: string; sessionPath: string | null; messageId: string; text: string }>).detail;
			if (!detail || detail.cwd !== cwd || detail.sessionPath !== sessionPath || typeof detail.text !== 'string' || !detail.text.trim()) return;
			const source = `${c('quoteSource')} · ${detail.messageId}`;
			const next = appendQuote(textRef.current, detail.text, source);
			changeText(next.text); setQuotes((items) => [...items, { key: currentKeyRef.current, block: next.block, source }].slice(-100));
			textareaRef.current?.focus();
		};
		window.addEventListener('pd:quote-selection', quote);
		return () => window.removeEventListener('pd:quote-selection', quote);
	}, [cwd, sessionPath, c('quoteSource')]);
	useEffect(() => {
		// Code selected in a file preview or diff arrives with its location (ZCode code comments).
		const quote = (event: Event) => {
			const detail = (event as CustomEvent<unknown>).detail;
			if (!isCodeQuote(detail) || detail.cwd !== cwd) return;
			const next = appendCodeQuote(textRef.current, detail);
			changeText(next.text); setQuotes((items) => [...items, { key: currentKeyRef.current, block: next.block, source: next.source }].slice(-100));
			textareaRef.current?.focus();
		};
		window.addEventListener(CODE_QUOTE_EVENT, quote);
		return () => window.removeEventListener(CODE_QUOTE_EVENT, quote);
	}, [cwd]);

	useEffect(() => { if (contextUnavailable) { setContextPicker(null); setSlashTrigger(null); } }, [contextUnavailable]);
	const selectContextRef = useRef<(request: UiContextRequest, fromPicker?: boolean) => Promise<void>>(async () => {});
	useEffect(() => {
		// File tree "Add to chat" (ZCode workspaceFileComposer); other workspaces' files never attach here.
		const add = (event: Event) => {
			const detail = (event as CustomEvent<unknown>).detail;
			if (!isWorkspaceEntryContext(detail) || detail.workspace !== cwd) return;
			void selectContextRef.current(detail, false);
		};
		window.addEventListener(ADD_CONTEXT_EVENT, add);
		return () => window.removeEventListener(ADD_CONTEXT_EVENT, add);
	}, [cwd]);

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

	function changeText(value: string, fromHistory = false) {
		if (!fromHistory) { historyCursor.current.reset(); setHistoryIndex(null); }
		textEdits.current.set(currentKeyRef.current, (textEdits.current.get(currentKeyRef.current) ?? 0) + 1);
		textRef.current = value;
		setText(value);
		draftsRef.current.set(currentKeyRef.current, { text: value, attachments: attachmentsRef.current });
		if (!writeDraft(currentKeyRef.current, value)) setDraftWarning(true);
		else setDraftWarning(false);
	}

	function changeAttachments(next: UiAttachment[], key = currentKeyRef.current) {
		attachmentEdits.current.set(key, (attachmentEdits.current.get(key) ?? 0) + 1);
		const draft = draftsRef.current.get(key) ?? { text: key === currentKeyRef.current ? textRef.current : readDraft(key), attachments: [] };
		draftsRef.current.set(key, { ...draft, attachments: next });
		if (currentKeyRef.current === key) {
			attachmentsRef.current = next;
			setAttachments(next);
		}
		else persistTransferredDraft(key);
	}

	function syncCompletions(value: string, start: number, end: number) {
		if (composingRef.current || historyCursor.current.index !== null || contextPicker?.mode === 'menu' || contextUnavailable) return;
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
		} else { draftsRef.current.set(key, { ...draft, text: consumed.text }); writeDraft(key, consumed.text); persistTransferredDraft(key); }
	}

	selectContextRef.current = selectContext;
	/** `fromPicker` false: added from the file tree (menu or drag), never consumes an @mention. */
	async function selectContext(request: UiContextRequest, fromPicker = true) {
		if (!bridge || contextUnavailable) return;
		const key = currentKeyRef.current;
		const original = textRef.current;
		const mention = fromPicker && contextPicker?.mode === 'mention' ? contextPicker.mention : null;
		if (fromPicker) setContextPicker(null);
		dismissedMention.current = mention ? { start: mention.start, prefix: original.slice(0, mention.start + 1) } : null;
		requestAnimationFrame(() => {
			if (key !== currentKeyRef.current) return;
			textareaRef.current?.focus({ preventScroll: true });
		});
		if (hasContextSource(attachmentsRef.current, request)) { consumeDraftMention(key, original, mention); return; }
		const target = { key };
		attachmentTargets.current.add(target);
		pendingAttachmentsRef.current += 1;
		setAttaching(true);
		setSubmissionError(null);
		try {
			if ((draftsRef.current.get(key)?.attachments.length ?? 0) >= MAX_ATTACHMENTS) throw new Error(t('composer.maxAttachments', { count: MAX_ATTACHMENTS }));
			const attachment = await bridge.readContext(request);
			const current = draftsRef.current.get(target.key)?.attachments ?? [];
			if (!hasContextSource(current, request)) {
				if (current.length >= MAX_ATTACHMENTS) throw new Error(t('composer.maxAttachments', { count: MAX_ATTACHMENTS }));
				changeAttachments([...current, attachment], target.key);
			}
			consumeDraftMention(target.key, original, mention);
		} catch (error) {
			if (currentKeyRef.current === target.key) setSubmissionError(error instanceof Error ? error.message : String(error));
		} finally {
			attachmentTargets.current.delete(target);
			pendingAttachmentsRef.current -= 1;
			setAttaching(pendingAttachmentsRef.current > 0);
		}
	}

	async function addFiles(files: File[]) {
		if (!files.length) return;
		const target = { key: currentKeyRef.current };
		attachmentTargets.current.add(target);
		pendingAttachmentsRef.current += 1;
		setAttaching(true);
		setSubmissionError(null);
		try {
			await appendFileAttachments(files, (file) => readFileAttachment(file, t, async (pdf) => {
				if (!inputBridge?.processPdfInput) throw new Error(zh ? 'PDF处理服务尚未就绪' : 'PDF processing is not ready');
				if (pdf.size > 20 * 1024 * 1024) throw new Error(zh ? 'PDF超过20 MiB限制' : 'PDF exceeds the 20 MiB limit');
				const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.onerror = () => reject(reader.error); reader.readAsDataURL(pdf); });
				const requestId = crypto.randomUUID(); pdfJobs.current.add(requestId); setPdfCount(pdfJobs.current.size);
				try { const result = await inputBridge.processPdfInput({ requestId, name: pdf.name.toLowerCase().endsWith('.pdf') ? pdf.name.slice(-200) : `${pdf.name.slice(0, 196)}.pdf`, data }); return result.attachment; }
				finally { pdfJobs.current.delete(requestId); setPdfCount(pdfJobs.current.size); }
			}),
				() => draftsRef.current.get(target.key)?.attachments ?? [],
				(next) => changeAttachments(next, target.key),
				() => new Error(t('composer.maxAttachments', { count: MAX_ATTACHMENTS })));
		} catch (error) {
			if (currentKeyRef.current === target.key) setSubmissionError(error instanceof Error ? error.message : String(error));
		} finally {
			attachmentTargets.current.delete(target);
			pendingAttachmentsRef.current -= 1;
			setAttaching(pendingAttachmentsRef.current > 0);
		}
	}

	function onFileChange(event: ChangeEvent<HTMLInputElement>) {
		void addFiles(Array.from(event.target.files ?? []));
		event.target.value = '';
	}

	function onDrop(event: DragEvent<HTMLDivElement>) {
		if (queueEditing) { event.preventDefault(); return; }
		if (hasWorkspaceEntryDrag(event.dataTransfer)) {
			event.preventDefault();
			const request = readWorkspaceEntryDrag(event.dataTransfer);
			if (request && request.workspace === cwd) void selectContext(request, false);
			return;
		}
		if (!event.dataTransfer.files.length) return;
		event.preventDefault();
		void addFiles(Array.from(event.dataTransfer.files));
	}

	function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
		// zcode: any clipboard file becomes an attachment through the normal
		// validation path (images are just the common case); extra-long plain
		// text is wrapped into a dated .txt File so the editor stays responsive.
		const files = Array.from(event.clipboardData.files);
		if (files.length) {
			event.preventDefault();
			void addFiles(files);
			return;
		}
		const text = event.clipboardData.getData('text/plain');
		if (text.length > LONG_PASTE_THRESHOLD) {
			event.preventDefault();
			const stamp = new Date().toISOString().slice(0, 19).replace('T', '_').replaceAll(':', '-');
			void addFiles([new File([text], `pasted_${stamp}.txt`, { type: 'text/plain' })]);
		}
	}

	async function submit(behavior?: BusyBehavior): Promise<void> {
		const value = textRef.current.trim();
		const submittedAttachments = attachmentsRef.current;
		if ((!value && !submittedAttachments.length) || sendingRef.current || pendingAttachmentsRef.current > 0 || (pendingDraftRestoresRef.current.get(currentKeyRef.current) ?? 0) > 0 || unavailable || status === 'error' || missingAttachments.length) return;
		const submittedKey = currentKeyRef.current;
		const submitted = { text: textRef.current, attachments: submittedAttachments };
		// Sending commits the current draft choice even while background recovery
		// is pending. Late disk data must not add attachments or defeat ACK clearing.
		textEdits.current.set(submittedKey, (textEdits.current.get(submittedKey) ?? 0) + 1);
		attachmentEdits.current.set(submittedKey, (attachmentEdits.current.get(submittedKey) ?? 0) + 1);
		const prior = sendRequest.current;
		const request: NonNullable<typeof sendRequest.current> = prior?.key === submittedKey && prior.text === value && prior.attachments === submittedAttachments ? prior : { key: submittedKey, scope: draftScope, text: value, attachments: submittedAttachments, id: crypto.randomUUID(), behavior: busy ? behavior ?? defaultBusyBehavior : undefined };
		request.preparationRequestId = sessionPreparation?.requestId;
		let optimisticallyCleared = false;
		sendingRef.current = true;
		setSending(true);
		submissionErrorsByKey.current.delete(submittedKey);
		setSubmissionError(null);
		setSlashTrigger(null);
		setContextPicker(null);
		try {
			sendRequest.current = request;
			const pending = send(value, request.behavior, submittedAttachments, request.id);
			if (sessionPreparation) {
				changeText('');
				changeAttachments([]);
				optimisticallyCleared = true;
			}
			await pending;
			applyDraftTransfer(useChatStore.getState().draftTransfer);
			savePromptHistory(request.scope.cwd, value);
			sendRequest.current = null;
			if (!optimisticallyCleared && clearSubmittedDraft(draftsRef.current, request.key, { text: value, attachments: submittedAttachments })) {
				if (currentKeyRef.current === request.key) {
					changeText('');
					changeAttachments([]);
				} else { writeDraft(request.key, ''); void durable.current?.drafts.save(request.scope, { text: '', attachments: [] }).catch(() => setDraftWarning(true)); }
			}
		} catch (error) {
			applyDraftTransfer(useChatStore.getState().draftTransfer);
			if (optimisticallyCleared) {
				const restored = restoreSubmittedDraft(draftsRef.current, request.key, submitted);
				writeDraft(request.key, restored.text);
				textEdits.current.set(request.key, (textEdits.current.get(request.key) ?? 0) + 1);
				attachmentEdits.current.set(request.key, (attachmentEdits.current.get(request.key) ?? 0) + 1);
				if (currentKeyRef.current === request.key) {
					textRef.current = restored.text; attachmentsRef.current = restored.attachments;
					setText(restored.text); setAttachments(restored.attachments);
				}
				else persistTransferredDraft(request.key);
			}
			if (!(error instanceof Error && error.name === 'AbortError')) {
				const message = error instanceof Error ? error.message : String(error);
				submissionErrorsByKey.current.set(request.key, message);
				if (currentKeyRef.current === request.key) setSubmissionError(message);
			}
		} finally {
			sendingRef.current = false;
			setSending(false);
		}
	}

	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
		if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
		if (slashTrigger && slashPickerRef.current?.handleKeyDown(event)) return;
		if (contextPicker && pickerRef.current?.handleKeyDown(event)) return;
		const direction = promptHistoryDirection(event);
		const recalled = event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
			? historyCursor.current.cancel()
			: direction && event.currentTarget.selectionStart === event.currentTarget.selectionEnd
				? historyCursor.current.navigate(readPromptHistory(draftScope.cwd), textRef.current, direction) : null;
		if (recalled !== null) {
			event.preventDefault(); event.stopPropagation();
			setContextPicker(null); setSlashTrigger(null);
			changeText(recalled, true); setHistoryIndex(historyCursor.current.index);
			const key = currentKeyRef.current;
			requestAnimationFrame(() => { if (currentKeyRef.current === key) textareaRef.current?.setSelectionRange(recalled.length, recalled.length); });
			return;
		}
		if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.nativeEvent.isComposing) return;
		event.preventDefault();
		void submit(busy && (event.ctrlKey || event.metaKey) ? defaultBusyBehavior === 'followUp' ? 'steer' : 'followUp' : undefined);
	}

	async function stopCurrentTask() {
		const current = useChatStore.getState();
		if (!bridge || current.status !== 'busy' || !current.sessionPreparation && (current.navigationPending || current.sessionLoading) || stopRequestsRef.current.get(stopScopeKey)?.bridge === bridge) return;
		const request = { bridge };
		stopRequestsRef.current.set(stopScopeKey, request);
		setStopRequests(new Map(stopRequestsRef.current));
		setSubmissionError(null);
		try { await abort(); }
		catch (error) { if (useChatStore.getState().bridge === bridge && currentKeyRef.current === draftKey) setSubmissionError(error instanceof Error ? error.message : String(error)); }
		finally {
			if (stopRequestsRef.current.get(stopScopeKey) === request) {
				stopRequestsRef.current.delete(stopScopeKey);
				setStopRequests(new Map(stopRequestsRef.current));
			}
		}
	}

	async function retryConnection() {
		if (retrying) return;
		setRetrying(true);
		setSubmissionError(null);
		try { await retryAgent(); }
		catch (error) { setSubmissionError(error instanceof Error ? error.message : String(error)); }
		finally { setRetrying(false); }
	}

	function onQueueEditingChange(editing: boolean) {
		setQueueEditing(editing);
		if (!editing) return;
		setContextPicker(null); setSlashTrigger(null);
	}

	return (
		<div className="pd-composer-dock">
			<div className="pd-composer-wrap">
				<ExtensionDialogSlot />
				{submissionError && <div className="pd-composer-error" role="alert">{submissionError}</div>}
				{draftWarning && <div className="pd-composer-error" role="status">{t('composer.draftWarning')}</div>}
				{missingAttachments.map((attachment) => <div className="pd-composer-error" role="alert" key={attachment.id}>{zh ? '草稿附件缺失，请重新添加或移除：' : 'Draft attachment missing. Add it again or remove it: '}{attachment.name}<button type="button" onClick={() => { const next = missingAttachments.filter((item) => item.id !== attachment.id); missingByKey.current.set(draftKey, next); setMissingAttachments(next); }}>{zh ? '移除' : 'Remove'}</button></div>)}
				<div ref={changesSlotRef} className="pd-composer-changes-slot" />
				<ComposerQueue key={`queue:${cwd}\0${sessionPath}\0${sessionId}`} scopeKey={`${cwd}\0${sessionPath}\0${sessionId}`} items={queuedMessages} editorTarget={queueEditorTarget} onEditingChange={onQueueEditingChange} defaultBehavior={defaultBusyBehavior} onToggleDefault={() => { const next = defaultBusyBehavior === 'followUp' ? 'steer' : 'followUp'; if (!setDefaultBusyBehavior(next)) setSubmissionError(zh ? '发送偏好未能保存，下次启动将使用默认设置。' : 'Could not save the send preference for the next launch.'); }} />
				<div ref={shellRef} className={`pd-composer-shell${queuedMessages.length ? ' has-queue' : ''}`} data-composer-layout="multiline" onDragOver={(event) => { if (event.dataTransfer.types.includes('Files') || hasWorkspaceEntryDrag(event.dataTransfer)) event.preventDefault(); }} onDrop={onDrop}>
					<div ref={setQueueEditorTarget} className="pd-queue-editor-slot" />
					{header ? <div className="pd-composer-header">{header}</div> : null}
					{attachments.length > 0 && <div className="pd-composer-attachments" aria-label={t('composer.pendingAttachments')}>{attachments.map((attachment, index) => <div className={`pd-composer-attachment${attachment.kind === 'text' && attachment.source ? ' is-context' : ''}`} key={`${attachment.name}-${index}`}>
						{attachment.kind === 'image' ? <button type="button" className="pd-composer-image-preview" aria-label={`${c('preview')}: ${attachment.name}`} onClick={(event) => setImagePreview({ index: attachments.slice(0, index).filter((item) => item.kind === 'image').length, trigger: event.currentTarget })}><img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="" /></button> : <span className="pd-composer-attachment-type">{attachment.source ? <Icon name={attachment.source.kind === 'session' ? 'message' : attachment.source.kind === 'directory' ? 'folder' : 'file'} width="16" height="16" /> : 'TXT'}</span>}
						<HoverTooltip title={attachment.name} description={attachment.kind === 'text' && attachment.source ? `${attachment.source.workspace}\n${attachment.source.path}${attachment.source.truncated ? `\n${t('composer.contextTruncated')}` : ''}` : attachmentLabel(attachment, t)}><span className="pd-composer-attachment-name" tabIndex={0}>{attachment.name}<small>{attachmentLabel(attachment, t)}{attachment.kind === 'text' && attachment.source?.truncated ? ` · ${t('composer.contextTruncatedShort')}` : ''}</small></span></HoverTooltip>
						<button type="button" onClick={() => { changeAttachments(attachmentsRef.current.filter((_, itemIndex) => itemIndex !== index)); textareaRef.current?.focus(); }} aria-label={t('composer.removeAttachment', { name: attachment.name })}><Icon name="close" width="14" height="14" /></button>
					</div>)}</div>}
					<textarea ref={textareaRef} value={text} rows={2} placeholder={placeholder} aria-label={t('composer.messageLabel')} disabled={unavailable} onChange={(event) => { changeText(event.target.value); syncCompletions(event.target.value, event.target.selectionStart, event.target.selectionEnd); }} onSelect={(event) => syncCompletions(event.currentTarget.value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd)} onCompositionStart={() => { composingRef.current = true; setContextPicker(null); setSlashTrigger(null); }} onCompositionEnd={(event) => { composingRef.current = false; syncCompletions(event.currentTarget.value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd); }} onKeyDown={onKeyDown} onPaste={onPaste} />
					<div className="pd-composer-toolbar">
						{quotes.filter((item) => item.key === draftKey && text.includes(item.block)).map((item, index) => <button type="button" className="pd-quote-chip" key={`${item.source}:${index}`} onClick={() => { changeText(textRef.current.replace(item.block, '')); setQuotes((items) => items.filter((entry) => entry !== item)); }} aria-label={c('removeQuote')}>{item.source} ×</button>)}
						<div className="pd-composer-meta">
							<input ref={fileInputRef} type="file" multiple className="pd-composer-file-input" tabIndex={-1} aria-hidden="true" onChange={onFileChange} />
							<HoverTooltip title={t('composer.contextAddTitle')} shortcut="@"><button ref={contextButtonRef} type="button" className="pd-composer-add-attachment" onMouseDown={(event) => event.preventDefault()} onClick={() => { closeSlash(); setContextPicker((current) => current?.mode === 'menu' ? null : { mode: 'menu' }); }} disabled={contextUnavailable || attaching || restoringDraft || attachments.length >= MAX_ATTACHMENTS} aria-label={t('composer.contextAddTitle')} aria-haspopup="dialog" aria-expanded={contextPicker !== null}><Icon name="plus" width="16" height="16" /></button></HoverTooltip>
						</div>
						<div className="pd-composer-actions">
							<ComposerControls onOpenModelManagement={onOpenModelManagement} hasImages={attachments.some((item) => item.kind === 'image')} />
							{status === 'error' || retrying
								? <button type="button" className="pd-send-button pd-composer-retry" onClick={() => void retryConnection()} disabled={retrying}><Icon name="refresh" width="15" height="15" /><span>{t(retrying ? 'composer.retryingConnection' : 'composer.retryConnection')}</span></button>
								: <button type="button" className="pd-send-button" data-action={showStop ? 'stop' : 'send'} onClick={() => void (showStop ? stopCurrentTask() : submit())} disabled={showStop ? stopping || navigating && !sessionPreparation : !canSubmit} aria-label={primaryActionLabel} aria-busy={showStop ? stopping : sending}><Icon name={showStop ? 'square' : 'arrowUp'} width="16" height="16" /></button>}
						</div>
					</div>
				</div>
				{contextPicker && !contextUnavailable && shellRef.current && <ComposerContextPicker ref={pickerRef} anchor={shellRef.current} trigger={contextButtonRef.current} mode={contextPicker.mode} query={contextPicker.mode === 'mention' ? contextPicker.mention.query : ''} workspace={cwd} sessionPath={sessionPath} onSelect={(request) => void selectContext(request)} onUpload={() => { closeContext(); fileInputRef.current?.click(); }} onClose={closeContext} />}
				{slashTrigger && !contextUnavailable && shellRef.current && <ComposerSlashPicker ref={slashPickerRef} anchor={shellRef.current} query={slashTrigger.query} commands={slashCatalog.key === slashCatalogKey ? slashCatalog.commands : []} loading={slashCatalog.key !== slashCatalogKey || slashCatalog.loading} error={slashCatalog.key === slashCatalogKey ? slashCatalog.error : null} busy={busy} onSelect={selectSlash} onClose={closeSlash} onRetry={() => setSlashRetry((value) => value + 1)} />}
				{attaching && <p className="pd-composer-attachment-hint" role="status">{t('composer.readingAttachments')}{pdfCount > 0 && <button type="button" onClick={() => { for (const id of pdfJobs.current) void inputBridge?.cancelPdfInput?.(id); }}>{zh ? '取消PDF处理' : 'Cancel PDF processing'}</button>}</p>}
				{historyIndex !== null && <p className="pd-composer-attachment-hint" role="status">{zh ? '正在查看输入历史 · ↑↓ 切换 · Esc 返回草稿' : 'Prompt history · ↑↓ browse · Esc restores draft'}</p>}
				{!queueEditing && attachments.length > 0 && <p className="pd-composer-attachment-hint">{inputBridge?.getInputDraft ? (zh ? '附件随草稿保存在本机。PDF以带页码的本地提取文字发送；不支持扫描OCR。' : 'Attachments are saved locally with the draft. PDFs send locally extracted text with page numbers; OCR is unavailable.') : t('composer.attachmentPersistence')}</p>}
				{imagePreview && <ImagePreviewDialog images={attachments.flatMap((attachment, index) => attachment.kind === 'image' ? [{ id: `pending:${index}`, name: attachment.name, attachment }] : [])} initialIndex={imagePreview.index} returnFocus={imagePreview.trigger} onClose={() => setImagePreview(null)} />}
				<ConversationMetrics />
			</div>
		</div>
	);
}
