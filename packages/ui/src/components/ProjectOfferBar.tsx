import { useChatStore } from '../store';
import { useT } from '../i18n';
import { Icon } from './Icons';
import './projectOffer.css';

function folderName(path: string): string {
	return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

/**
 * Bar above the composer when the first message of an unassigned conversation
 * names a folder: explains what was detected and offers to move the conversation
 * there. It never blocks the conversation; accepting moves it once the reply ends.
 */
export function ProjectOfferBar() {
	const { t } = useT();
	const offer = useChatStore((s) => s.projectOffer);
	const sessionId = useChatStore((s) => s.sessionId);
	const accept = useChatStore((s) => s.acceptProjectOffer);
	const dismiss = useChatStore((s) => s.dismissProjectOffer);
	if (!offer || offer.sessionId !== sessionId) return null;
	const project = folderName(offer.directory);
	const busy = offer.state === 'waiting' || offer.state === 'moving';
	const message = offer.state === 'waiting' ? t('projectOffer.waiting', { project })
		: offer.state === 'moving' ? t('projectOffer.moving', { project })
			: offer.state === 'failed' ? t('projectOffer.failed', { message: offer.error ?? '' })
				: t(offer.registered ? 'projectOffer.registered' : 'projectOffer.unregistered', { project });
	return (
		<section className={`pd-project-offer is-${offer.state}`} role={offer.state === 'failed' ? 'alert' : 'status'} aria-label={t('projectOffer.label')}>
			<Icon name="folder" width="15" height="15" className="pd-project-offer-icon" />
			<div className="pd-project-offer-text">
				<strong>{t('projectOffer.label')}</strong>
				<span className="pd-project-offer-message">{message}</span>
				<span className="pd-project-offer-path" title={offer.directory}>{offer.directory}</span>
			</div>
			{!busy && <button type="button" className="pd-project-offer-move" onClick={accept}>{t(offer.state === 'failed' ? 'projectOffer.retry' : 'projectOffer.move')}</button>}
			{busy && <span className="pd-project-offer-spinner" aria-hidden="true" />}
			<button type="button" className="pd-project-offer-close" aria-label={t('projectOffer.dismiss')} title={t('projectOffer.dismiss')} disabled={offer.state === 'moving'} onClick={dismiss}>
				<Icon name="close" width="14" height="14" />
			</button>
		</section>
	);
}
