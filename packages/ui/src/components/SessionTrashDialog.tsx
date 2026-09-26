import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { managementCopy } from '../managementCopy';

export function SessionTrashDialog({ title, workspace, onDelete, onClose }: { title: string; workspace: string; onDelete(): Promise<void>; onClose(deleted: boolean): void }) {
	const { locale } = useT();
	const copy = managementCopy(locale);
	const id = useId();
	const dialog = useRef<HTMLDialogElement>(null);
	const lock = useRef(false);
	const mounted = useRef(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => { mounted.current = true; const node = dialog.current; node?.showModal(); return () => { mounted.current = false; node?.close(); }; }, []);
	function close(deleted: boolean) {
		// Release native modal focus containment before the parent commits its list focus.
		dialog.current?.close();
		onClose(deleted);
	}
	async function submit() {
		if (lock.current) return;
		lock.current = true; setBusy(true); setError(null);
		try { await onDelete(); if (mounted.current) close(true); }
		catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { lock.current = false; if (mounted.current) setBusy(false); }
	}
	return createPortal(<dialog ref={dialog} className="pd-session-trash-dialog" aria-labelledby={id} aria-describedby={`${id}-hint`} onCancel={(event) => { event.preventDefault(); if (!lock.current) close(false); }}>
		<h2 id={id}>{copy.trashTitle}</h2><strong>{title}</strong><p className="pd-session-trash-workspace">{workspace}</p><p id={`${id}-hint`}>{copy.trashHint}</p>
		{error && <p role="alert" className="pd-session-trash-error">{error}</p>}
		<footer><button autoFocus type="button" disabled={busy} onClick={() => close(false)}>{copy.cancel}</button><button type="button" className="is-danger" disabled={busy} onClick={() => void submit()}>{busy ? copy.deleting : error ? copy.retry : copy.trash}</button></footer>
	</dialog>, document.body);
}
