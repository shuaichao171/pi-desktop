import { useChatStore } from '../store';
import { useT } from '../i18n';
import { isConversationWorkspace } from '../sidebarOrganization';
import { bindingKeysFor } from '../shortcuts/bindings';
import { HoverTooltip } from './HoverTooltip';
import { Icon } from './Icons';
import type { RefObject } from 'react';

export function SearchButton({ cwd, open, buttonRef, onClick }: { cwd: string; open: boolean; buttonRef: RefObject<HTMLButtonElement | null>; onClick(): void }) {
	const { t } = useT();
	const platform = useChatStore((state) => state.appInfo?.platform);
	const conversationWorkspaces = useChatStore((state) => state.conversationWorkspaces);
	const project = cwd && !isConversationWorkspace(cwd, conversationWorkspaces) ? cwd.split(/[\\/]+/).filter(Boolean).at(-1) || cwd : '';
	const keys = bindingKeysFor('search');
	const shortcut = platform === 'darwin' ? keys.replace(/Ctrl/gi, '⌘').replace(/Shift/gi, '⇧').replace(/Alt/gi, '⌥').replace(/\+/g, '') : keys;
	return <HoverTooltip title={t('search.commandCenterLabel')} description={project ? cwd : undefined} shortcut={shortcut} disabled={open} openDelayMs={450}>
		<button ref={buttonRef} type="button" className={`pd-top-bar-search pd-sidebar-search-trigger${open ? ' is-active' : ''}`} onClick={onClick} aria-label={t('search.commandCenterLabel')} aria-haspopup="dialog" aria-expanded={open}>
			<Icon name="search" width="14" height="14" />
			<span className="pd-top-bar-search-copy">{project && <span className="pd-top-bar-search-project">{project}</span>}<span className="pd-top-bar-search-hint">{t('search.commandCenterHint')}</span></span>
			<kbd className="pd-top-bar-search-shortcut" aria-hidden="true">{shortcut}</kbd>
		</button>
	</HoverTooltip>;
}
