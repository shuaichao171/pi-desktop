import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { managementCopy } from '../managementCopy';

export type SessionTrashTarget = { path: string; title: string };

export function SessionBulkTrashDialog({ sessions, onDelete, onClose }: {
	sessions: SessionTrashTarget[];
	/** zcode deleteArchivedTasks shape: one batched call returns per-path outcomes instead of N independent deletions (each of which used to refetch the whole session list). Skipped = selection went stale while the confirm sat open (zcode skippedTaskIds). */
	onDelete(paths: string[]): Promise<{ deleted: string[]; failed: Record<string, string>; skipped: Record<string, string> }>;
	onClose(deleted: string[]): void;
}) {
	const { t, locale } = useT();
	const copy = managementCopy(locale);
	const id = useId();
	const dialog = useRef<HTMLDialogElement>(null);
	const mounted = useRef(false);
	const lock = useRef(false);
	const deleted = useRef(new Set<string>());
	const [remaining, setRemaining] = useState(sessions);
	const [busy, setBusy] = useState(false);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [skipped, setSkipped] = useState<Record<string, string>>({});
	useEffect(() => { mounted.current = true; const node = dialog.current; node?.showModal(); return () => { mounted.current = false; node?.close(); }; }, []);
	function close() { dialog.current?.close(); onClose([...deleted.current]); }
	async function submit() {
		if (lock.current) return;
		lock.current = true; setBusy(true); setErrors({}); setSkipped({});
		// One batched store call: deletions run sequentially inside the store, failures
		// come back per path, and the whole batch refreshes the session list once.
		try {
			const result = await onDelete(remaining.map(item => item.path));
			if (!mounted.current) return;
			for (const path of result.deleted) {
				deleted.current.add(path);
				setRemaining(current => current.filter(item => item.path !== path));
			}
			const failedPaths = new Set(Object.keys(result.failed));
			const stalePaths = new Set(Object.keys(result.skipped));
			// Stale selections stay listed with a skip note instead of an error: the
			// conversation itself is fine, only the confirmed selection went outdated.
			setRemaining(current => current.filter(item => failedPaths.has(item.path) || stalePaths.has(item.path)));
			setErrors(result.failed);
			setSkipped(result.skipped);
			// Skips keep the dialog open so the user can read why the selection went
			// stale before closing manually (failures already behaved this way).
			if (deleted.current.size === sessions.length) close();
		} finally { lock.current = false; if (mounted.current) setBusy(false); }
	}
	return createPortal(<dialog ref={dialog} className="pd-session-trash-dialog pd-session-bulk-trash-dialog" aria-labelledby={id} onCancel={event => { event.preventDefault(); if (!lock.current) close(); }}>
		<h2 id={id}>{t('sidebar.trashSelectedTitle', { count: remaining.length })}</h2>
		<ul className="pd-session-bulk-trash-list">{remaining.map(session => <li key={session.path}><strong>{session.title}</strong>{skipped[session.path] && <p className="pd-session-trash-skip" role="status">{t('sidebar.trashSelectedSkipped')}</p>}{errors[session.path] && <p className="pd-session-trash-error" role="alert">{errors[session.path]}</p>}</li>)}</ul>
		{deleted.current.size > 0 && <p role="status">{t('sidebar.trashSelectedProgress', { count: deleted.current.size, total: sessions.length })}</p>}
		<footer><button autoFocus type="button" disabled={busy} onClick={close}>{copy.cancel}</button><button type="button" className="is-danger" disabled={busy} onClick={() => void submit()}>{busy ? copy.deleting : Object.keys(errors).length ? copy.retry : copy.trash}</button></footer>
	</dialog>, document.body);
}
