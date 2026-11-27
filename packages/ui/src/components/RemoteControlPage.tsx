import { useT } from '../i18n';
import { Icon } from './Icons';
import { RemoteAccessPanel } from './RemoteAccessPanel';
import './remoteControlPage.css';

/**
 * Activity-bar 手机远控 view: pair a phone by QR and manage remote access without
 * opening Settings. Reuses the Settings panel in its `page` layout so both entry
 * points always show the same live state.
 */
export function RemoteControlPage() {
	const { t } = useT();
	return (
		<main className="pd-main pd-remote-page" data-view="remote">
			<div className="pd-remote-page-scroll">
				<div className="pd-remote-page-content">
					<header className="pd-remote-page-intro">
						<span className="pd-remote-page-avatar" aria-hidden="true"><Icon name="smartphone" width="26" height="26" /></span>
						<div>
							<span className="pd-remote-page-eyebrow">{t('remote.page.eyebrow')}</span>
							<h1>{t('remote.page.title')}</h1>
							<p>{t('remote.page.description')}</p>
						</div>
					</header>
					<RemoteAccessPanel variant="page" />
				</div>
			</div>
		</main>
	);
}
