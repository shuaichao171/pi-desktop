import { lazy } from 'react';
import { loadHighlighter } from '../codeHighlighter';

/**
 * On-demand surfaces: they mount only when opened, so they ship as separate
 * chunks instead of growing the startup bundle. `preloadLazySurfaces` warms
 * them after first paint, keeping the first open instant.
 */
const loadSettings = () => import('./SettingsPanel');
const loadSearch = () => import('./SearchDialog');
const loadAutomations = () => import('./AutomationPage');
const loadPlugins = () => import('./PluginsPage');
const loadCommit = () => import('./ChatCommitDialog');
const loadWorkbench = () => import('./WorkbenchSidePane');

export const SettingsPanel = lazy(() => loadSettings().then((module) => ({ default: module.SettingsPanel })));
export const SearchDialog = lazy(() => loadSearch().then((module) => ({ default: module.SearchDialog })));
export const AutomationPage = lazy(() => loadAutomations().then((module) => ({ default: module.AutomationPage })));
export const PluginsPage = lazy(() => loadPlugins().then((module) => ({ default: module.PluginsPage })));
export const ChatCommitDialog = lazy(() => loadCommit().then((module) => ({ default: module.ChatCommitDialog })));
// 工作台（文件树/Git 图/查找面板/终端）只在首次打开时挂载，整棵子树留在按需 chunk 里。
export const WorkbenchSidePane = lazy(() => loadWorkbench().then((module) => ({ default: module.WorkbenchSidePane })));

let preloaded = false;
/** Fetches every lazy surface once the window is idle; failures retry on first open. */
export function preloadLazySurfaces(): () => void {
	if (preloaded) return () => {};
	const run = () => {
		preloaded = true;
		void loadHighlighter();
		for (const load of [loadSettings, loadSearch, loadPlugins, loadAutomations, loadCommit, loadWorkbench]) void load().catch(() => {});
	};
	if (typeof window.requestIdleCallback === 'function') {
		const handle = window.requestIdleCallback(run, { timeout: 4_000 });
		return () => window.cancelIdleCallback(handle);
	}
	const timer = window.setTimeout(run, 1_500);
	return () => window.clearTimeout(timer);
}
