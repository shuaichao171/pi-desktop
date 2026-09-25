import { useLayoutEffect, useRef, useState } from 'react';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { HoverTooltip } from './HoverTooltip';
import { Icon } from './Icons';

export function WorkspaceFolderButton({ cwd }: { cwd: string }) {
	const { t } = useT();
	const bridge = useChatStore((state) => state.bridge);
	const navigationPending = useChatStore((state) => state.navigationPending);
	const [opening, setOpening] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const request = useRef(0);
	const openingRef = useRef(false);
	useLayoutEffect(() => {
		request.current += 1;
		openingRef.current = false;
		setOpening(false);
		setError(null);
		return () => { request.current += 1; };
	}, [bridge, cwd]);

	async function openFolder() {
		if (!bridge || !cwd || navigationPending || openingRef.current) return;
		const id = ++request.current;
		openingRef.current = true;
		setOpening(true);
		setError(null);
		try {
			await bridge.openWorkspaceFolder(cwd);
		} catch (reason) {
			if (request.current === id) setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			if (request.current === id) { openingRef.current = false; setOpening(false); }
		}
	}

	const label = t(opening ? 'chat.openingWorkspaceFolder' : 'chat.openWorkspaceFolder');
	return <div className="pd-chat-workspace" onKeyDown={(event) => { if (event.key === 'Escape' && error) { event.stopPropagation(); setError(null); } }}>
		<HoverTooltip title={label} description={cwd} align="start" disabled={Boolean(error)}>
			<button type="button" className="pd-icon-button pd-chat-workspace-button" aria-label={cwd ? `${label}: ${cwd}` : label} aria-busy={opening} disabled={!bridge || !cwd || navigationPending || opening} onClick={() => void openFolder()}><Icon name="folder" width="16" height="16" /></button>
		</HoverTooltip>
		{error && <div className="pd-chat-title-error pd-chat-workspace-error" role="alert">{t('chat.openWorkspaceFolderError', { message: error })}</div>}
	</div>;
}
