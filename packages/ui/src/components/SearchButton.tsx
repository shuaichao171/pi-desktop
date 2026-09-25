import { useChatStore } from '../store';
import { useT } from '../i18n';
import { HoverTooltip } from './HoverTooltip';
import { Icon } from './Icons';

export function SearchButton({ open, onClick }: { open: boolean; onClick(): void }) {
	const { t } = useT();
	const platform = useChatStore((state) => state.appInfo?.platform);
	return <HoverTooltip title={t('sidebar.search')} shortcut={platform === 'darwin' ? '⌘K' : 'Ctrl+K'}>
		<button type="button" className={`pd-icon-button pd-sidebar-search-trigger${open ? ' is-active' : ''}`} onClick={onClick} aria-label={t('sidebar.search')} aria-haspopup="dialog" aria-expanded={open}><Icon name="search" width="16" height="16" /></button>
	</HoverTooltip>;
}
