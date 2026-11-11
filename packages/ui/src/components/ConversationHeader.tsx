import { HoverTooltip } from './HoverTooltip';
import { Icon } from './Icons';
import { useT } from '../i18n';

/**
 * Session identity strip rendered at the top of every conversation surface
 * (main chat area and split panes alike): project › session title with a live
 * status dot, plus an optional pane close button. Display only — renaming
 * lives in the sidebar session menu (2026-11-02 用户拍板).
 */
export function ConversationHeader({ cwd, title, busy, branches, branchTitle, onClose, closeLabel }: {
	cwd: string | null;
	title: string;
	busy: boolean;
	/** Number of distinct branches (conversation-tree paths) in this session; hidden below 2. */
	branches?: number;
	branchTitle?: string;
	onClose?: () => void;
	closeLabel?: string;
}) {
	const { t } = useT();
	const project = (cwd ?? '').split(/[\\/]+/).filter(Boolean).pop() ?? '';
	return (
		<div className="pd-conversation-header">
			{project && <span className="pd-conversation-header-project" title={cwd ?? ''}>{project}</span>}
			{project && <span className="pd-conversation-header-sep" aria-hidden="true">›</span>}
			<span className="pd-conversation-header-title" title={title}>{title}</span>
			{branches !== undefined && branches >= 2 && <span className="pd-conversation-header-branches" title={branchTitle ?? t('chat.branch.headerCount', { count: String(branches) })}><Icon name="gitBranch" width="12" height="12" />{branches}</span>}
			<span className={`pd-conversation-header-status${busy ? ' is-busy' : ''}`} aria-hidden="true" />
			{onClose && <HoverTooltip title={closeLabel ?? t('pane.close')}><button className="pd-icon-button" type="button" aria-label={closeLabel ?? t('pane.close')} onClick={onClose}><Icon name="close" width="15" height="15" /></button></HoverTooltip>}
		</div>
	);
}
