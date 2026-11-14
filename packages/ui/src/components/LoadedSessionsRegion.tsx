import { useState } from 'react';
import type { UiSessionRuntimeState } from '@pidesktop/shared';
import { sessionRuntimeKey } from '../managementState';
import { useT } from '../i18n';
import { closeLoadedPane, unloadSessionFromMain } from '../loadedSessionActions';
import { useLoadedSessions, useSessionDrag } from '../loadedSessions';
import { useChatStore } from '../store';
import { HoverTooltip } from './HoverTooltip';
import { Icon } from './Icons';
import './loadedSessions.css';

interface Row { key: string; kind: 'main' | 'pane'; cwd: string; path: string | null; paneId?: number; hidden?: boolean; busy: boolean }

/**
 * "已加载会话": the top-left sidebar region listing every conversation kept ready in this
 * window — loaded main-window conversations and all split panes (shown or hidden). It is
 * also a drop target: dragging a sidebar conversation here loads it.
 */
export function LoadedSessionsRegion({ titleFor, projectNameFor, onNavigate }: { titleFor(path: string | null): string; projectNameFor?(cwd: string): string | null; onNavigate(): void }) {
	const { t } = useT();
	const { main, panes } = useLoadedSessions();
	const drag = useSessionDrag();
	const [collapsed, setCollapsed] = useState(false);
	const currentPath = useChatStore((s) => s.sessionPath);
	const currentBusy = useChatStore((s) => s.status === 'busy');
	const runtimes = useChatStore((s) => s.sessionRuntimes);
	const paneHeld = new Set(panes.map((pane) => pane.sessionPath).filter(Boolean));
	const rows: Row[] = [
		...main.filter((entry) => !paneHeld.has(entry.path)).map((entry): Row => ({
			key: `main:${entry.path}`, kind: 'main', cwd: entry.cwd, path: entry.path,
			busy: entry.path === currentPath ? currentBusy : runtimeRunning(runtimes[sessionRuntimeKey(entry.cwd, entry.path)]),
		})),
		...panes.map((pane): Row => ({ key: `pane:${pane.paneId}`, kind: 'pane', cwd: pane.cwd, path: pane.sessionPath, paneId: pane.paneId, hidden: pane.hidden, busy: pane.busy })),
	];
	const dropActive = drag !== null;
	const dropHover = drag?.target === 'loaded';

	async function open(row: Row) {
		const state = useChatStore.getState();
		if (row.kind === 'pane') {
			if (row.hidden) await state.bridge?.setSplitPaneHidden?.(false, row.paneId).catch(() => {});
			else if (row.path) await state.bridge?.focusHostedSession?.(row.path).catch(() => false);
			return;
		}
		if (!row.path || row.path === state.sessionPath) { onNavigate(); return; }
		if (await state.selectSession(row.cwd, row.path).catch(() => false)) onNavigate();
	}

	const heading = <button type="button" className="pd-sidebar-region-heading" aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}>
		<Icon name="chevronRight" width="13" height="13" className={!collapsed ? 'is-expanded' : ''} /><span>{t('loaded.title')}</span>
		{rows.length > 0 && <small>{rows.length}</small>}
	</button>;

	return <section className={`pd-sidebar-region pd-loaded-sessions${collapsed ? ' is-collapsed' : ''}${dropActive ? ' is-drop-active' : ''}${dropHover ? ' is-drop-hover' : ''}`} data-session-drop="loaded" aria-label={t('loaded.title')}>
		<div className="pd-sidebar-region-heading-row">
			<HoverTooltip title={t('loaded.hint')} description={t('loaded.hintDetail')} side="top" interactive={false}>{heading}</HoverTooltip>
		</div>
		{!collapsed && <div className="pd-sidebar-region-content pd-loaded-sessions-list" role="list">
			{rows.map((row) => {
				const active = row.kind === 'main' && row.path === currentPath;
				const title = titleFor(row.path);
				const project = projectNameFor?.(row.cwd) ?? null;
				return <div key={row.key} role="listitem" className={`pd-loaded-session${active ? ' is-active' : ''}${row.hidden ? ' is-hidden-pane' : ''}`} data-loaded-kind={row.kind} data-loaded-path={row.path ?? undefined}>
					<button type="button" className="pd-loaded-session-main" title={project ? `${project} › ${title}` : title} onClick={() => void open(row)} aria-current={active ? 'page' : undefined}>
						<span className="pd-session-leading" aria-hidden="true">{row.busy ? <Icon name="loader" className="pd-session-spinner" width="13" height="13" /> : <Icon name={row.kind === 'pane' ? 'panelRight' : 'message'} width="13" height="13" />}</span>
						{project && <span className="pd-loaded-session-project">{project}</span>}
						{project && <span className="pd-loaded-session-sep" aria-hidden="true">›</span>}
						<span className="pd-loaded-session-title">{title}</span>
						{row.kind === 'pane' && <span className="pd-loaded-session-badge">{t(row.hidden ? 'loaded.paneHidden' : 'loaded.pane')}</span>}
					</button>
					<HoverTooltip title={t(row.kind === 'pane' ? 'loaded.closePane' : 'loaded.unload')}>
						<button type="button" className="pd-icon-button pd-loaded-session-close" aria-label={`${t(row.kind === 'pane' ? 'loaded.closePane' : 'loaded.unload')}: ${title}`}
							onClick={() => { void (row.kind === 'pane' ? closeLoadedPane(row.paneId!) : unloadSessionFromMain(row.path!)); }}>
							<Icon name="close" width="13" height="13" />
						</button>
					</HoverTooltip>
				</div>;
			})}
			{rows.length === 0 && <div className="pd-session-empty pd-loaded-sessions-empty">{t(dropActive ? 'loaded.dropHere' : 'loaded.empty')}</div>}
			{rows.length > 0 && dropActive && <div className="pd-session-empty pd-loaded-sessions-empty">{t('loaded.dropHere')}</div>}
		</div>}
	</section>;
}

function runtimeRunning(runtime: UiSessionRuntimeState | undefined): boolean {
	return Boolean(runtime && runtime.phase !== 'idle' && runtime.phase !== 'failed');
}
