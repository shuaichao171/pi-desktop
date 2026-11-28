import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { useChatStore } from '../store';

/** Keyed by conversation so a pending rename never edits the next title. */
export interface ChatTitleHandle { beginRename(): void }

export const ChatTitle = forwardRef<ChatTitleHandle, { title: string; sessionPath: string | null }>(function ChatTitle({ title, sessionPath }, ref) {
	const { t } = useT();
	const enabled = useChatStore((state) => Boolean(state.bridge && state.sessionId && !state.navigationPending && (state.status === 'idle' || state.status === 'busy')));
	const updateSessionMeta = useChatStore((state) => state.updateSessionMeta);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(title);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const editingRef = useRef(false);
	const savingRef = useRef(false);
	const composingRef = useRef(false);
	const draftRef = useRef(title);
	const mountedRef = useRef(true);
	const hintId = useId();
	const errorId = useId();
	const canRename = enabled && Boolean(sessionPath) && !saving;

	draftRef.current = draft;

	useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
	useLayoutEffect(() => { if (editing) { inputRef.current?.focus(); inputRef.current?.select(); } }, [editing]);

	function startEditing() {
		if (!canRename || savingRef.current) return;
		draftRef.current = title;
		setDraft(title);
		setError(null);
		editingRef.current = true;
		setEditing(true);
	}

	const finishEditing = useCallback((restoreFocus: boolean) => {
		const shouldRestoreFocus = restoreFocus && document.activeElement === inputRef.current;
		editingRef.current = false;
		composingRef.current = false;
		setEditing(false);
		setError(null);
		if (shouldRestoreFocus) requestAnimationFrame(() => { if (mountedRef.current && document.activeElement === document.body) buttonRef.current?.focus(); });
	}, []);

	const save = useCallback(async (restoreFocus = false, cancelWhenBlank = false) => {
		if (!editingRef.current || savingRef.current || composingRef.current) return;
		if (!canRename || !sessionPath) { finishEditing(false); return; }
		const name = draftRef.current.trim();
		if (!name) {
			if (cancelWhenBlank) finishEditing(false);
			else setError(t('chat.titleRequired'));
			return;
		}
		if (name === title.trim()) { finishEditing(restoreFocus); return; }
		if (name.length > 200) {
			if (cancelWhenBlank) finishEditing(false);
			else setError(t('chat.titleTooLong'));
			return;
		}
		savingRef.current = true;
		setSaving(true);
		setError(null);
		try {
			await updateSessionMeta(sessionPath, { name });
			if (mountedRef.current) finishEditing(restoreFocus);
		} catch (cause) {
			if (mountedRef.current && editingRef.current) setError(t('chat.titleSaveFailed', { message: cause instanceof Error ? cause.message : String(cause) }));
		} finally {
			savingRef.current = false;
			if (mountedRef.current) setSaving(false);
		}
	}, [canRename, finishEditing, sessionPath, t, title, updateSessionMeta]);

	useImperativeHandle(ref, () => ({ beginRename: () => startEditing() }));

	useEffect(() => {
		if (!editing) return;
		// Blank header/body areas do not necessarily move focus. Commit (or close if
		// unchanged/blank) on the outside pointer press without consuming the click.
		const onPointerDown = (event: PointerEvent) => {
			if (!(event.target instanceof Node) || !inputRef.current?.contains(event.target)) void save(false, true);
		};
		document.addEventListener('pointerdown', onPointerDown, true);
		return () => document.removeEventListener('pointerdown', onPointerDown, true);
	}, [editing, save]);

	return <div className={`pd-chat-title${editing ? ' is-editing' : ''}`} aria-busy={saving}>
		{editing ? <span className="pd-chat-title-edit"><input
			ref={inputRef}
			className="pd-chat-title-input"
			value={draft}
			maxLength={200}
			readOnly={saving}
			aria-label={t('sidebar.renameLabel')}
			aria-invalid={Boolean(error)}
			aria-describedby={`${hintId}${error ? ` ${errorId}` : ''}`}
			onChange={(event) => { draftRef.current = event.target.value; setDraft(event.target.value); setError(null); }}
			onCompositionStart={() => { composingRef.current = true; }}
			onCompositionEnd={() => { composingRef.current = false; }}
			onKeyDown={(event) => {
				if (event.nativeEvent.isComposing || event.keyCode === 229 || composingRef.current) return;
				if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void save(true, false); }
				if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!savingRef.current) finishEditing(true); }
			}}
			onBlur={() => { void save(false, true); }}
		/><span className="pd-chat-title-measure" aria-hidden="true">{draft || ' '}</span></span> : <button
			ref={buttonRef}
			type="button"
			className="pd-chat-title-button pd-conversation-header-title"
			title={title}
			aria-label={t('chat.renameTitleLabel', { title })}
			aria-disabled={!canRename}
			onClick={startEditing}
		>{title}</button>}
		<span id={hintId} className="pd-chat-title-sr-only">{t('chat.renameTitleHint')}</span>
		{saving && <span className="pd-chat-title-sr-only" role="status">{t('chat.titleSaving')}</span>}
		{error && <span id={errorId} className="pd-chat-title-error" role="alert">{error}</span>}
	</div>;
});
