import type { UiQueuedMessage } from '@pidesktop/shared';
import { useT } from '../i18n';
import { Icon } from './Icons';
import './composerQueue.css';

export function ComposerQueue({ items }: { items: UiQueuedMessage[] }) {
	const { t } = useT();
	if (items.length === 0) return null;
	return <section className="pd-composer-queue" aria-label={t('composer.queuedInstructions')}>
		<div className="pd-composer-queue-heading"><span>{t('composer.queuedInstructions')}</span><span className="pd-composer-queue-count" role="status" aria-label={t('composer.queueCount', { count: items.length })}>{items.length}</span></div>
		<div className="pd-composer-queue-list">
			{items.map((item) => <details key={item.id} className="pd-composer-queue-item" data-queue-id={item.id} data-behavior={item.behavior}>
				<summary className="pd-composer-queue-summary">
					<Icon name={item.behavior === 'steer' ? 'steer' : 'queue'} className="pd-composer-queue-icon" width="16" height="16" />
					<span className="pd-composer-queue-text">{item.text || t('composer.queueAttachments', { count: item.attachments?.length ?? 0 })}</span>
					{Boolean(item.text && item.attachments?.length) && <span className="pd-composer-queue-attachment-count" aria-label={t('composer.queueAttachments', { count: item.attachments!.length })}><Icon name="file" width="12" height="12" />{item.attachments!.length}</span>}
					<span className="pd-composer-queue-behavior">{t(item.behavior === 'steer' ? 'composer.queuedSteer' : 'composer.queuedFollowUp')}</span>
					<Icon name="chevronDown" className="pd-composer-queue-chevron" width="13" height="13" />
				</summary>
				<div className="pd-composer-queue-detail">
					{item.text && <p className="pd-composer-queue-body">{item.text}</p>}
					{Boolean(item.attachments?.length) && <ul className="pd-composer-queue-attachments" aria-label={t('composer.queuedAttachments')}>{item.attachments!.map((attachment, index) => <li key={`${attachment.name}-${index}`}><Icon name="file" width="13" height="13" /><span>{attachment.name}</span></li>)}</ul>}
					<p className="pd-composer-queue-delivery">{t(item.behavior === 'steer' ? 'composer.queuedSteerDescription' : 'composer.queuedFollowUpDescription')}</p>
				</div>
			</details>)}
		</div>
	</section>;
}
