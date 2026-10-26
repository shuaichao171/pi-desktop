import type { WorkspaceOpener } from '@pidesktop/shared';
import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useChatStore } from '../store';
import { Icon, type IconName } from './Icons';

function fallbackIcon(opener: WorkspaceOpener): IconName {
	return opener.kind === 'terminal' ? 'terminal' : opener.id === 'explorer' ? 'folder' : 'code';
}

function errorText(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/** The top bar keeps the two primary workspace actions visible: Explorer and VS Code. */
function OpenerIcon({ opener }: { opener: WorkspaceOpener }) {
	if (opener.icon) return <img src={opener.icon} alt='' className='pd-opener-icon' width='16' height='16' />;
	return <Icon name={fallbackIcon(opener)} width='16' height='16' />;
}

export function WorkspaceOpenButton({ cwd }: { cwd: string | null }) {
	const { t } = useT();
	const bridge = useChatStore((state) => state.bridge);
	const [openers, setOpeners] = useState<WorkspaceOpener[]>([]);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setOpeners([]);
		bridge?.listWorkspaceOpeners().then((list) => { if (!cancelled) setOpeners(list); }).catch(() => { /* actions stay hidden until detection succeeds */ });
		return () => { cancelled = true; };
	}, [bridge]);

	if (!cwd || !bridge) return null;
	const api = bridge;
	const workspace = cwd;
	const explorer = openers.find((entry) => entry.id === 'explorer');
	const vscode = openers.find((entry) => entry.id === 'vscode');
	if (!explorer && !vscode) return null;

	async function launch(id: 'explorer' | 'vscode'): Promise<void> {
		setError(null);
		try {
			if (id === 'explorer') await api.openWorkspaceFolder(workspace);
			else if (api.openWorkspaceWith) await api.openWorkspaceWith(workspace, 'vscode');
			else await api.openWorkspaceInVsCode(workspace);
		} catch (cause) {
			setError(errorText(cause));
		}
	}

	const explorerLabel = t('chat.openWorkspaceFolder');
	const vscodeLabel = t('chat.menuOpenInVsCode');
	return (
		<div className='pd-workspace-open-wrap' onKeyDown={(event) => { if (event.key === 'Escape' && error) { event.stopPropagation(); setError(null); } }}>
			<div className='pd-workspace-open' aria-label={t('chat.openInOpener', { name: explorer?.name ?? t('chat.openWorkspaceFolder') })}>
				{explorer && <button type='button' className='pd-workspace-open-button pd-workspace-open-explorer' aria-label={explorerLabel} title={explorerLabel} onClick={() => void launch('explorer')}><OpenerIcon opener={explorer} /></button>}
				{vscode && <button type='button' className='pd-workspace-open-button pd-workspace-open-vscode' aria-label={vscodeLabel} title={vscodeLabel} onClick={() => void launch('vscode')}><OpenerIcon opener={vscode} /></button>}
			</div>
			{error && <div className='pd-chat-title-error pd-workspace-open-error' role='alert'>{t('chat.menuActionFailed', { message: error })}</div>}
		</div>
	);
}
