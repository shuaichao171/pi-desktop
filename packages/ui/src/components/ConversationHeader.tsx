import { useRef } from 'react';
import { ChatHeaderMenu } from './ChatHeaderMenu';
import { ChatTitle, type ChatTitleHandle } from './ChatTitle';
import { HoverTooltip } from './HoverTooltip';
import { Icon } from './Icons';
import { WorkspaceOpenButton } from './WorkspaceOpenButton';
import { useT } from '../i18n';

/**
 * Session identity strip rendered at the top of every conversation surface
 * (main chat area and split panes alike): project capsule › clickable inline
 * title (click to rename) + chevron dropdown menu, branch badge and optional
 * pane close button.
 */
export function ConversationHeader({ cwd, title, sessionPath, branches, branchTitle, onOpenCommit, paneMode = false, onClose, closeLabel }: {
	cwd: string | null;
	title: string;
	sessionPath: string | null;
	/** Number of distinct branches (conversation-tree paths) in this session; hidden below 2. */
	branches?: number;
	branchTitle?: string;
	onOpenCommit?: () => void;
	paneMode?: boolean;
	onClose?: () => void;
	closeLabel?: string;
}) {
	const { t } = useT();
	const titleRef = useRef<ChatTitleHandle>(null);
	return (
		<div className="pd-conversation-header">
			{cwd && <WorkspaceOpenButton key={cwd} cwd={cwd} />}
			{cwd && <span className="pd-conversation-header-sep" aria-hidden="true">›</span>}
			<div className="pd-conversation-title-group">
				<ChatTitle key={`${cwd ?? ''}\0${sessionPath ?? ''}`} ref={titleRef} title={title} sessionPath={sessionPath} />
				<ChatHeaderMenu title={title} sessionPath={sessionPath} cwd={cwd ?? ''} paneMode={paneMode} onRename={() => titleRef.current?.beginRename()} onOpenCommit={onOpenCommit} />
			</div>
			{branches !== undefined && branches >= 2 && <span className="pd-conversation-header-branches" title={branchTitle ?? t('chat.branch.headerCount', { count: String(branches) })}><Icon name="gitBranch" width="12" height="12" />{branches}</span>}
			{onClose && <HoverTooltip title={closeLabel ?? t('pane.close')}><button className="pd-icon-button pd-conversation-header-close" type="button" aria-label={closeLabel ?? t('pane.close')} onClick={onClose}><Icon name="close" width="15" height="15" /></button></HoverTooltip>}
		</div>
	);
}
