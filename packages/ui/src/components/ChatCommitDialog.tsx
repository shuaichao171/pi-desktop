import { useEffect, useRef, useState } from 'react';
import type { WorkspaceGitStatus } from '@pidesktop/shared';
import { useT } from '../i18n';
import { useChatStore } from '../store';

function errorText(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/**
 * zcode-style commit dialog: shows the branch and changed files of the active
 * workspace, lets the model draft the message, and commits everything in one
 * `git add -A && git commit`.
 */
export function ChatCommitDialog({ onClose }: { onClose(): void }) {
	const { t } = useT();
	const [status, setStatus] = useState<WorkspaceGitStatus | null>(null);
	const [loading, setLoading] = useState(true);
	const [working, setWorking] = useState<'generate' | 'commit' | null>(null);
	const [done, setDone] = useState(false);
	const [message, setMessage] = useState('');
	const [notice, setNotice] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);

	useEffect(() => {
		let alive = true;
		const bridge = useChatStore.getState().bridge;
		if (!bridge) return;
		void bridge.getWorkspaceGitStatus().then((snapshot) => {
			if (alive) {
				setStatus(snapshot);
				setLoading(false);
			}
		}).catch((cause: unknown) => {
			if (alive) {
				setLoading(false);
				setNotice({ tone: 'error', text: errorText(cause) });
			}
		});
		return () => { alive = false; };
	}, []);

	const busy = working !== null || done;
	const entries = status?.entries ?? [];
	const canCommit = !busy && status?.isRepository && entries.length > 0 && message.trim().length > 0;

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); }
		};
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	}, [busy, onClose]);

	async function generate() {
		const bridge = useChatStore.getState().bridge;
		if (!bridge || busy) return;
		setWorking('generate');
		setNotice(null);
		try {
			const context = await bridge.getWorkspaceCommitContext();
			const draft = await bridge.generateCommitMessage(context);
			setMessage(draft);
			textareaRef.current?.focus();
		} catch (cause: unknown) {
			setNotice({ tone: 'error', text: t('chat.commitGenerateFailed', { message: errorText(cause) }) });
		} finally {
			setWorking(null);
		}
	}

	async function submit() {
		const bridge = useChatStore.getState().bridge;
		if (!bridge || !canCommit) return;
		setWorking('commit');
		setNotice(null);
		try {
			const hash = await bridge.commitWorkspace(message);
			setNotice({ tone: 'info', text: t('chat.commitDone', { hash }) });
			setDone(true);
			window.setTimeout(onClose, 1400);
		} catch (cause: unknown) {
			setNotice({ tone: 'error', text: t('chat.commitFailed', { message: errorText(cause) }) });
		} finally {
			setWorking(null);
		}
	}

	return (
		<div className="pd-commit-backdrop" onClick={() => { if (!busy) onClose(); }}>
			<section
				className="pd-commit-dialog"
				role="dialog"
				aria-modal="true"
				aria-label={t('chat.commitTitle')}
				onClick={(event) => event.stopPropagation()}
			>
				<header className="pd-commit-header">
					<h2>{t('chat.commitTitle')}</h2>
					<p>{t('chat.commitDescription')}</p>
				</header>
				{loading && <p className="pd-commit-status">{t('chat.commitLoading')}</p>}
				{status && !status.isRepository && <p className="pd-commit-status pd-commit-warning">{t('chat.commitNoRepo')}</p>}
				{status?.isRepository && <>
					<dl className="pd-commit-meta">
						<div>
							<dt>{t('chat.commitBranchLabel')}</dt>
							<dd>{status.branch || '—'}</dd>
						</div>
						<div>
							<dt>{t('chat.commitChangesLabel')}</dt>
							<dd>{entries.length ? t('chat.commitFilesCount', { count: String(entries.length) }) : t('chat.commitEmpty')}</dd>
						</div>
					</dl>
					{entries.length > 0 && <ul className="pd-commit-files">
						{entries.slice(0, 200).map((entry) => (
							<li key={`${entry.status}-${entry.path}`} title={entry.path}>
								<code>{entry.status.trim() || 'M'}</code>
								<span>{entry.path}</span>
							</li>
						))}
					</ul>}
					<label className="pd-commit-label" htmlFor="pd-commit-message">
						{t('chat.commitMessageLabel')}
					</label>
					<textarea
						id="pd-commit-message"
						ref={textareaRef}
						value={message}
						disabled={busy}
						rows={4}
						placeholder={t('chat.commitPlaceholder')}
						onChange={(event) => setMessage(event.target.value)}
					/>
				</>}
				{notice && <p className={notice.tone === 'error' ? 'pd-commit-status pd-commit-warning' : 'pd-commit-status pd-commit-ok'}>{notice.text}</p>}
				<footer className="pd-commit-actions">
					<button type="button" className="pd-commit-secondary" disabled={busy} onClick={onClose}>{t('chat.commitCancel')}</button>
					{status?.isRepository && entries.length > 0 && <>
						<button type="button" className="pd-commit-secondary" disabled={busy} onClick={() => { void generate(); }}>
							{working === 'generate' ? t('chat.commitGenerating') : t('chat.commitGenerate')}
						</button>
						<button type="button" className="pd-commit-primary" disabled={!canCommit} onClick={() => { void submit(); }}>
							{working === 'commit' ? t('chat.commitSubmitting') : t('chat.commitSubmit')}
						</button>
					</>}
				</footer>
			</section>
		</div>
	);
}
