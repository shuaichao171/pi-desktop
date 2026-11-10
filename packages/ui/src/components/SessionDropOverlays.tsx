import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { useSessionDrag } from '../loadedSessions';
import { Icon } from './Icons';
import './loadedSessions.css';

/** Label following the pointer while a sidebar conversation is dragged. */
export function SessionDragGhost() {
	const drag = useSessionDrag();
	if (!drag || typeof document === 'undefined') return null;
	return createPortal(<div className="pd-session-drag-ghost" style={{ left: drag.x, top: drag.y }} aria-hidden="true">{drag.title}</div>, document.body);
}

/** Right part of the main conversation: dropping a dragged conversation here opens it in a split pane. */
export function SplitDropZone() {
	const { t } = useT();
	const drag = useSessionDrag();
	if (!drag) return null;
	return <div className={`pd-session-split-drop${drag.target === 'split' ? ' is-hover' : ''}`} data-session-drop="split" aria-hidden="true">
		<span><Icon name="panelRight" width="16" height="16" />{t('loaded.dropSplit')}</span>
	</div>;
}
