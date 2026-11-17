import { HoverTooltip } from './HoverTooltip';
import { Icon } from './Icons';
import { WorkspaceOpenButton } from './WorkspaceOpenButton';
import { useT } from '../i18n';

/**
 * Session identity strip rendered at the top of every conversation surface
 * (main chat area and split panes alike): project › session title with a
 * workspace opener and an optional pane close button. Renaming
 * lives in the sidebar session menu (2026-11-02 用户拍板).
 */
export function ConversationHeader({ cwd, title, branches, branchTitle, onClose, closeLabel }: {
	cwd: string | null;
	title: string;
	/** Number of distinct branches (conversation-tree paths) in this session; hidden below 2. */
	branches?: number;
	branchTitle?: string;
	onClose?: () => void;
	closeLabel?: string;
}) {
	const { t } = useT();
	return (
		<div className="pd-conversation-header">
			{cwd && <WorkspaceOpenButton key={cwd} cwd={cwd} />}
			{cwd && <span className="pd-conversation-header-sep" aria-hidden="true">›</span>}
			<span className="pd-conversation-header-title" title={title}>{title}</span>
			{branches !== undefined && branches >= 2 && <span className="pd-conversation-header-branches" title={branchTitle ?? t('chat.branch.headerCount', { count: String(branches) })}><Icon name="gitBranch" width="12" height="12" />{branches}</span>}
			{onClose && <HoverTooltip title={closeLabel ?? t('pane.close')}><button className="pd-icon-button" type="button" aria-label={closeLabel ?? t('pane.close')} onClick={onClose}><Icon name="close" width="15" height="15" /></button></HoverTooltip>}
		</div>
	);
}
