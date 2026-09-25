import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { UiFileChange } from '@pidesktop/shared';
import { useT } from '../i18n';
import { parseUnifiedDiff } from '../unifiedDiff';
import { Icon } from './Icons';
import './composerChanges.css';

function ChangeStats({ items }: { items: UiFileChange[] }) {
	const { t } = useT();
	const additions = items.reduce((sum, item) => sum + (item.additions ?? 0), 0);
	const deletions = items.reduce((sum, item) => sum + (item.deletions ?? 0), 0);
	const partial = items.some((item) => item.additions === null || item.deletions === null);
	if (items.every((item) => item.additions === null && item.deletions === null)) return null;
	return <span className="pd-change-stats" aria-label={t(partial ? 'changes.partialStats' : 'changes.stats', { additions, deletions })}>
		<span className="pd-change-added" aria-hidden="true">+{additions}</span><span className="pd-change-deleted" aria-hidden="true">−{deletions}</span>{partial && <span aria-hidden="true">*</span>}
	</span>;
}

function FileLabel({ item }: { item: UiFileChange }) {
	const { t } = useT();
	const parts = item.path.split('/');
	const name = parts.pop();
	return <><span className={`pd-change-kind is-${item.kind}`} aria-label={t(`changes.${item.kind}`)}>{item.kind === 'added' ? 'A' : item.kind === 'deleted' ? 'D' : 'M'}</span><span className="pd-change-filename"><span>{name}</span>{parts.length > 0 && <small>{parts.join('/')}</small>}</span></>;
}

function DiffPreview({ item }: { item: UiFileChange }) {
	const { t } = useT();
	const lines = useMemo(() => parseUnifiedDiff(item.diff ?? ''), [item.diff]);
	return <>
		{item.preview && <p className="pd-changes-notice" role="status">{t(`changes.preview.${item.preview}`)}</p>}
		{lines.length > 0 ? <div className="pd-changes-code" tabIndex={0} role="region" aria-label={t('changes.diffFor', { path: item.path })}>
			<pre>{lines.map((line, index) => <span className={`pd-diff-line is-${line.kind}`} key={index}>
				<span className="pd-diff-number" aria-hidden="true">{line.oldLine}</span><span className="pd-diff-number" aria-hidden="true">{line.newLine}</span><span className="pd-diff-text">{line.text || ' '}</span>
			</span>)}</pre>
		</div> : !item.preview && <p className="pd-changes-notice">{t('changes.emptyFile')}</p>}
	</>;
}

function ChangesDialog({ items, initialPath, returnFocus, onClose }: { items: UiFileChange[]; initialPath: string; returnFocus: HTMLElement | null; onClose(): void }) {
	const { t } = useT();
	const ref = useRef<HTMLDialogElement>(null);
	const titleId = useId();
	const [path, setPath] = useState(initialPath);
	const selected = items.find((item) => item.path === path) ?? items[0];
	useEffect(() => {
		const dialog = ref.current;
		const trigger = returnFocus;
		dialog?.showModal();
		return () => {
			dialog?.close();
			const anotherDialog = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).some((element) => element !== dialog);
			if (!anotherDialog && trigger?.isConnected && trigger.getClientRects().length > 0 && !trigger.closest('[inert]')) trigger.focus({ preventScroll: true });
		};
	}, [returnFocus]);
	return createPortal(<dialog ref={ref} className="pd-changes-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={(event) => event.stopPropagation()}>
		<header className="pd-changes-dialog-header"><div><h2 id={titleId}>{t('changes.title')}</h2><span>{t('changes.count', { count: items.length })}</span><ChangeStats items={items} /></div><button type="button" className="pd-icon-button" aria-label={t('changes.close')} onClick={onClose} autoFocus><Icon name="close" width="18" height="18" /></button></header>
		<p className="pd-changes-description">{t('changes.description')}</p>
		<div className="pd-changes-review">
			<nav className="pd-changes-file-list" aria-label={t('changes.files')}>
				{items.map((item) => <button type="button" key={item.path} className={`pd-changes-file${selected?.path === item.path ? ' is-selected' : ''}`} title={item.path} aria-current={selected?.path === item.path ? 'true' : undefined} onClick={() => setPath(item.path)}><FileLabel item={item} /><ChangeStats items={[item]} /></button>)}
			</nav>
			{selected && <section className="pd-changes-diff" aria-label={t('changes.diffFor', { path: selected.path })}>
				<div className="pd-changes-diff-header"><span title={selected.path}>{selected.path}</span><ChangeStats items={[selected]} /></div>
				<DiffPreview key={selected.path} item={selected} />
			</section>}
		</div>
	</dialog>, document.body);
}

/** Conversation-scoped tool snapshots, never the workspace's unrelated Git status. */
export function ComposerChanges({ items }: { items: UiFileChange[] }) {
	const { t } = useT();
	const [expanded, setExpanded] = useState(false);
	const [reviewPath, setReviewPath] = useState<string | null>(null);
	const reviewTrigger = useRef<HTMLButtonElement | null>(null);
	const listId = useId();
	if (items.length === 0) return null;
	return <section className="pd-composer-changes" aria-label={t('changes.title')}>
		<div className="pd-composer-changes-summary">
			<button type="button" className="pd-composer-changes-toggle" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded((value) => !value)}>
				<Icon name="chevronRight" className={expanded ? 'is-expanded' : ''} width="14" height="14" /><span role="status">{t('changes.count', { count: items.length })}</span><ChangeStats items={items} />
			</button>
			<button type="button" className="pd-composer-changes-review" aria-haspopup="dialog" onClick={(event) => { reviewTrigger.current = event.currentTarget; setReviewPath(items[0]!.path); }}>{t('changes.review')}<Icon name="panelRight" width="14" height="14" /></button>
		</div>
		<div id={listId} className="pd-composer-changes-files" hidden={!expanded}>
			{items.map((item) => <button key={item.path} type="button" className="pd-composer-changes-file" title={item.path} aria-haspopup="dialog" onClick={(event) => { reviewTrigger.current = event.currentTarget; setReviewPath(item.path); }}><FileLabel item={item} /><ChangeStats items={[item]} /><Icon name="chevronRight" width="12" height="12" /></button>)}
		</div>
		{reviewPath !== null && <ChangesDialog items={items} initialPath={reviewPath} returnFocus={reviewTrigger.current} onClose={() => setReviewPath(null)} />}
	</section>;
}
