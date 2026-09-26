import { useEffect, useRef, useState } from 'react';
import type { CommitScope, WorkbenchFeaturesBridge, WorkspaceCommitPreview } from '@pidesktop/shared/workbenchFeatures';
import { useT } from '../i18n';
import { useChatStore } from '../store';

function errorText(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Preview, generated description, and final commit share the same scoped tree.
 */
export function ChatCommitDialog({ onClose }: { onClose(): void }) {
	const { t } = useT();
	const cwd = useChatStore(state => state.cwd), bridge = useChatStore(state => state.bridge);
	const api = bridge as (typeof bridge & WorkbenchFeaturesBridge);
	const [preview, setPreview] = useState<WorkspaceCommitPreview | null>(null);
	const [scope, setScope] = useState<CommitScope>('all');
	const [revision, setRevision] = useState(0);
	const status = preview ? { isRepository: true, branch: preview.branch, entries: preview.files } : null;
	const actionLock = useRef(false);
	const generation = useRef(0), closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [loading, setLoading] = useState(true);
	const [working, setWorking] = useState<'generate' | 'commit' | null>(null);
	const [done, setDone] = useState(false);
	const [message, setMessage] = useState('');
	const [notice, setNotice] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);

	useEffect(() => {
		let alive = true;
		generation.current++; actionLock.current = false; setWorking(null); setDone(false);
		if (closeTimer.current) clearTimeout(closeTimer.current);
		if (!api) return;
		setLoading(true); setPreview(null); setNotice(null);
		void api.getWorkspaceCommitPreview({ cwd, scope }).then((snapshot) => {
			if (alive) {
				setPreview(snapshot);
				setLoading(false);
			}
		}).catch((cause: unknown) => {
			if (alive) {
				setLoading(false);
				setNotice({ tone: 'error', text: errorText(cause) });
			}
		});
		return () => { alive = false; generation.current++; if (closeTimer.current) clearTimeout(closeTimer.current); };
	}, [api, cwd, scope, revision]);

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
		if (!api || busy || actionLock.current || !preview) return;
		const token = generation.current, current = () => token === generation.current && useChatStore.getState().cwd === cwd && useChatStore.getState().bridge === bridge;
		actionLock.current = true;
		setWorking('generate');
		setNotice(null);
		try {
			const draft = await api.generateCommitMessage(preview.context);
			if (!current()) return;
			setMessage(draft);
			textareaRef.current?.focus();
		} catch (cause: unknown) {
			if (current()) setNotice({ tone: 'error', text: t('chat.commitGenerateFailed', { message: errorText(cause) }) });
		} finally {
			if (current()) { actionLock.current = false; setWorking(null); }
		}
	}

	async function submit() {
		if (!api || !canCommit || !preview || actionLock.current) return;
		const token = generation.current, current = () => token === generation.current && useChatStore.getState().cwd === cwd && useChatStore.getState().bridge === bridge;
		actionLock.current = true;
		setWorking('commit');
		setNotice(null);
		try {
			const hash = await api.commitWorkspacePreview({ id: preview.id, message });
			if (!current()) return;
			setNotice({ tone: 'info', text: t('chat.commitDone', { hash }) });
			setDone(true);
			closeTimer.current = setTimeout(() => { if (current()) onClose(); }, 1400);
		} catch (cause: unknown) {
			if (current()) setNotice({ tone: 'error', text: t('chat.commitFailed', { message: errorText(cause) }) });
		} finally {
			if (current()) { actionLock.current = false; setWorking(null); }
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
				<label className="pd-commit-label">提交范围<select disabled={busy} value={scope} onChange={event => { setScope(event.target.value as CommitScope); setMessage(''); }}><option value="all">当前工作区全部更改</option><option value="stagedOnly">仅已暂存（保留未暂存内容）</option></select></label>
				<button type="button" className="pd-commit-secondary" disabled={busy || loading} onClick={() => setRevision(value => value + 1)}>刷新范围预览</button>
				{preview?.truncated && <p role="status">差异说明上下文已截断，实际提交范围以下列文件和已确认索引为准。</p>}
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
