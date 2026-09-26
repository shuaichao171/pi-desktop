import { memo, useEffect, useRef, useState } from 'react';
import type { UiQueuedMessage } from '@pidesktop/shared';
import { useT } from '../i18n';
import { useChatStore } from '../store';
import { Icon } from './Icons';
import './composerQueue.css';

/** Queued instructions above the composer with Codex-style management: steer early, edit, remove. */
export const ComposerQueue = memo(function ComposerQueue({ items }: { items: UiQueuedMessage[] }) {
	const { t } = useT();
	const [editingId, setEditingId] = useState<string | null>(null);
	const [draft, setDraft] = useState('');
	const [pending, setPending] = useState<string | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		if (editingId && !items.some((item) => item.id === editingId)) {
			setEditingId(null);
			setDraft('');
		}
	}, [items, editingId]);

	useEffect(() => {
		if (!editingId) return;
		const node = textareaRef.current;
		if (!node) return;
		node.focus();
		node.style.height = 'auto';
		node.style.height = `${node.scrollHeight}px`;
		node.setSelectionRange(node.value.length, node.value.length);
	}, [editingId]);

	if (items.length === 0) return null;

	const run = (id: string, action: 'edit' | 'remove' | 'steer', text?: string) => {
		setPending(`${id}:${action}`);
		void useChatStore.getState().updateQueuedMessage(id, action, text)
			.catch(() => { /* Failures surface through the store error banner. */ })
			.finally(() => setPending(null));
	};

	const beginEdit = (item: UiQueuedMessage) => {
		setEditingId(item.id);
		setDraft(item.text);
	};

	const commitEdit = (id: string) => {
		const trimmed = draft.trim();
		if (!trimmed) return;
		setEditingId(null);
		run(id, 'edit', trimmed);
	};

	return <section className="pd-composer-queue" aria-label={t('composer.queuedInstructions')}>
		<div className="pd-composer-queue-heading"><span>{t('composer.queuedInstructions')}</span><span className="pd-composer-queue-count" role="status" aria-label={t('composer.queueCount', { count: items.length })}>{items.length}</span></div>
		<div className="pd-composer-queue-list">
			{items.map((item) => {
				if (item.id === editingId) {
					return <div key={item.id} className="pd-composer-queue-item is-editing" data-queue-id={item.id} data-behavior={item.behavior}>
						<textarea ref={textareaRef} className="pd-composer-queue-edit" value={draft} rows={2} aria-label={t('composer.queueEditLabel')} onChange={(event) => {
							setDraft(event.target.value);
							event.currentTarget.style.height = 'auto';
							event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`;
						}} onKeyDown={(event) => {
							if (event.nativeEvent.isComposing) return;
							if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); commitEdit(item.id); }
							if (event.key === 'Escape') { event.preventDefault(); setEditingId(null); }
						}} />
						<div className="pd-composer-queue-edit-actions">
							<span className="pd-composer-queue-edit-hint">{t('composer.queueEditHint')}</span>
							<button type="button" className="pd-composer-queue-button" onClick={() => setEditingId(null)}>{t('composer.queueEditCancel')}</button>
							<button type="button" className="pd-composer-queue-button is-primary" disabled={!draft.trim()} onClick={() => commitEdit(item.id)}>{t('composer.queueEditSave')}</button>
						</div>
					</div>;
				}
				return <details key={item.id} className="pd-composer-queue-item" data-queue-id={item.id} data-behavior={item.behavior}>
					<summary className="pd-composer-queue-summary">
						<Icon name={item.behavior === 'steer' ? 'steer' : 'queue'} className="pd-composer-queue-icon" width="16" height="16" />
						<span className="pd-composer-queue-text">{item.text || t('composer.queueAttachments', { count: item.attachments?.length ?? 0 })}</span>
						{Boolean(item.text && item.attachments?.length) && <span className="pd-composer-queue-attachment-count" aria-label={t('composer.queueAttachments', { count: item.attachments!.length })}><Icon name="file" width="12" height="12" />{item.attachments!.length}</span>}
						<span className="pd-composer-queue-behavior">{t(item.behavior === 'steer' ? 'composer.queuedSteer' : 'composer.queuedFollowUp')}</span>
						<span className="pd-composer-queue-actions">
							{item.behavior === 'followUp' && <button type="button" className="pd-composer-queue-action is-steer" disabled={pending !== null} aria-label={t('composer.queueSteer')} title={t('composer.queueSteerHint')} onClick={(event) => { event.preventDefault(); event.stopPropagation(); run(item.id, 'steer'); }}><Icon name="steer" width="14" height="14" />{t('composer.queueSteer')}</button>}
							<button type="button" className="pd-composer-queue-action" disabled={pending !== null} aria-label={t('composer.queueEdit')} title={t('composer.queueEdit')} onClick={(event) => { event.preventDefault(); event.stopPropagation(); beginEdit(item); }}><Icon name="pencil" width="14" height="14" /></button>
							<button type="button" className="pd-composer-queue-action" disabled={pending !== null} aria-label={t('composer.queueDelete')} title={t('composer.queueDelete')} onClick={(event) => { event.preventDefault(); event.stopPropagation(); run(item.id, 'remove'); }}><Icon name="trash" width="14" height="14" /></button>
						</span>
						<Icon name="chevronDown" className="pd-composer-queue-chevron" width="13" height="13" />
					</summary>
					<div className="pd-composer-queue-detail">
						{item.text && <p className="pd-composer-queue-body">{item.text}</p>}
						{Boolean(item.attachments?.length) && <ul className="pd-composer-queue-attachments" aria-label={t('composer.queuedAttachments')}>{item.attachments!.map((attachment, index) => <li key={`${attachment.name}-${index}`}><Icon name="file" width="13" height="13" /><span>{attachment.name}</span></li>)}</ul>}
						<p className="pd-composer-queue-delivery">{t(item.behavior === 'steer' ? 'composer.queuedSteerDescription' : 'composer.queuedFollowUpDescription')}</p>
					</div>
				</details>;
			})}
		</div>
	</section>;
});
