import { useEffect, useRef, useState } from 'react';
import type { WorkspaceOpener } from '@pidesktop/shared';
import { useT } from '../i18n';
import { useChatStore } from '../store';
import { Icon, type IconName } from './Icons';
import { SidebarPopover } from './SidebarPopover';

// The top bar's fixed split control: the main button always opens the folder
// in the system file manager; the attached chevron lists the editors and
// terminals detected on this machine.
function fallbackIcon(opener: WorkspaceOpener): IconName {
	return opener.kind === 'terminal' ? 'terminal' : 'code';
}

function errorText(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/** Renders the backend-provided editor icon, falling back to a lucide glyph. */
function OpenerIcon({ opener }: { opener: WorkspaceOpener }) {
	if (opener.icon) return <img src={opener.icon} alt='' className='pd-opener-icon' width='15' height='15' />;
	return <Icon name={fallbackIcon(opener)} width='15' height='15' />;
}

export function WorkspaceOpenButton({ cwd }: { cwd: string | null }) {
	const { t } = useT();
	const bridge = useChatStore((state) => state.bridge);
	const navigationPending = useChatStore((state) => state.navigationPending);
	const anchorRef = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [editors, setEditors] = useState<WorkspaceOpener[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const request = useRef(0);

	// Initial detection plus a refresh every time the picker opens: newly
	// installed editors appear without an app restart.
	useEffect(() => {
		if (!bridge) return;
		const id = ++request.current;
		bridge.listWorkspaceOpeners()
			.then((list) => { if (request.current === id) setEditors(list.filter((opener) => opener.kind !== 'file-manager')); })
			.catch(() => { if (request.current === id) setEditors([]); });
	}, [bridge, open]);

	if (!cwd || !bridge) return null;

	const openFolder = async () => {
		setError(null);
		try {
			await bridge.openWorkspaceFolder(cwd);
		} catch (cause) {
			setError(errorText(cause));
		}
	};

	const launch = async (id: string) => {
		setOpen(false);
		setError(null);
		try {
			await bridge.openWorkspaceWith(cwd, id);
		} catch (cause) {
			setError(errorText(cause));
		}
	};

	return (
		<div className="pd-workspace-open-wrap" onKeyDown={(event) => { if (event.key === 'Escape' && error) { event.stopPropagation(); setError(null); } }}>
			<div className="pd-workspace-open">
				<button type="button" className="pd-workspace-open-main" aria-label={t('chat.openWorkspaceFolder')} title={t('chat.openWorkspaceFolder')} disabled={navigationPending} onClick={() => void openFolder()}><Icon name="folder" width="15" height="15" /></button>
				<button ref={anchorRef} type="button" className="pd-workspace-open-menu" aria-haspopup="menu" aria-expanded={open} aria-label={t('chat.selectOpener')} onClick={() => { setError(null); setOpen((value) => !value); }}><Icon name="chevronDown" width="13" height="13" /></button>
			</div>
			{open && anchorRef.current && <SidebarPopover anchor={anchorRef.current} label={t('chat.selectOpener')} onClose={() => setOpen(false)}>
				{editors === null && <p className="pd-sidebar-menu-note">{t('sidebar.openersLoading')}</p>}
				{editors !== null && editors.length === 0 && <p className="pd-sidebar-menu-note">{t('sidebar.openersEmpty')}</p>}
				{editors?.map((opener) => (
					<button type="button" key={opener.id} role="menuitem" className="pd-menu-item" onClick={() => void launch(opener.id)}>
						<OpenerIcon opener={opener} />
						<span>{opener.name ?? (opener.id === 'vscode' ? 'VS Code' : opener.id)}</span>
					</button>
				))}
			</SidebarPopover>}
			{error && <div className="pd-chat-title-error pd-workspace-open-error" role="alert">{t('chat.menuActionFailed', { message: error })}</div>}
		</div>
	);
}
