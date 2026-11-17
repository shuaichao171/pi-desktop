import { useChatStore } from '../store';
import { useT } from '../i18n';
import { bindingKeysFor } from '../shortcuts/bindings';
import { HoverTooltip } from './HoverTooltip';
import { Icon } from './Icons';
import type { RefObject } from 'react';

export function SearchButton({ open, buttonRef, onClick }: { open: boolean; buttonRef: RefObject<HTMLButtonElement | null>; onClick(): void }) {
	const { t } = useT();
	const platform = useChatStore((state) => state.appInfo?.platform);
	const keys = bindingKeysFor('search');
	const shortcut = platform === 'darwin' ? keys.replace(/Ctrl/gi, '⌘').replace(/Shift/gi, '⇧').replace(/Alt/gi, '⌥').replace(/\+/g, '') : keys;
	return <HoverTooltip title={t('search.commandCenterLabel')} shortcut={shortcut} disabled={open} openDelayMs={450}>
		<button ref={buttonRef} type="button" className={`pd-icon-button pd-sidebar-search-trigger${open ? ' is-active' : ''}`} onClick={onClick} aria-label={t('search.commandCenterLabel')} aria-haspopup="dialog" aria-expanded={open}><Icon name="search" width="16" height="16" /></button>
	</HoverTooltip>;
}
