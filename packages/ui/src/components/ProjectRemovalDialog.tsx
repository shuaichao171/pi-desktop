import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';

export interface ProjectRemovalSummary {
	workspace: string;
	name: string;
	sessionCount: number;
	activeCount: number;
}

/**
 * Removing a project only forgets its sidebar/runtime registration. Conversation
 * history and workspace files remain on disk; live runtimes must settle first.
 */
export function ProjectRemovalDialog({ summary, onRemove, onClose }: {
	summary: ProjectRemovalSummary;
	onRemove(): Promise<void>;
	onClose(removed: boolean): void;
}) {
	const { t } = useT();
	const id = useId();
	const dialog = useRef<HTMLDialogElement>(null);
	const mounted = useRef(false);
	const lock = useRef(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		mounted.current = true;
		dialog.current?.showModal();
		return () => { mounted.current = false; dialog.current?.close(); };
	}, []);
	function close(removed: boolean) {
		dialog.current?.close();
		onClose(removed);
	}
	async function submit() {
		if (lock.current || summary.activeCount > 0) return;
		lock.current = true;
		setBusy(true);
		setError(null);
		try {
			await onRemove();
			if (mounted.current) close(true);
		} catch (cause) {
			if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			lock.current = false;
			if (mounted.current) setBusy(false);
		}
	}
	return createPortal(<dialog ref={dialog} className="pd-session-delete-dialog pd-project-removal-dialog" aria-labelledby={id} aria-describedby={`${id}-hint`} onCancel={(event) => { event.preventDefault(); if (!lock.current) close(false); }}>
		<h2 id={id}>{t('sidebar.projectRemoveTitle')}</h2>
		<strong>{summary.name}</strong>
		<p className="pd-session-delete-workspace">{summary.workspace}</p>
		<p id={`${id}-hint`}>{t('sidebar.projectRemoveHint', { count: summary.sessionCount })}</p>
		{summary.activeCount > 0 && <p role="alert" className="pd-session-delete-error">{t('sidebar.projectRemoveBusy', { count: summary.activeCount })}</p>}
		{error && <p role="alert" className="pd-session-delete-error">{error}</p>}
		<footer>
			<button autoFocus type="button" disabled={busy} onClick={() => close(false)}>{t('sidebar.cancel')}</button>
			<button type="button" className="is-danger" disabled={busy || summary.activeCount > 0} onClick={() => void submit()}>{t(busy ? 'sidebar.projectRemoving' : error ? 'sidebar.projectRemoveRetry' : 'sidebar.projectRemoveConfirm')}</button>
		</footer>
	</dialog>, document.body);
}
