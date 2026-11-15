function installCommandCenterFixture({ project = 'pi_desttop', conversation = false, shortcut = 'Ctrl+K', platform = 'win32' } = {}) {
	const fixture = window.__modelReview;
	const cwd = `C:/renderer-review/${project}`;
	Object.assign(fixture.snapshot, { cwd, sessionId: 'command-center', sessionPath: `${cwd}/current.jsonl` });
	const review = window.__commandCenterReview = { sessionQueries: [], fileQueries: [] };
	window.piDesktop.listConversationWorkspaces = async () => conversation ? [cwd] : [];
	window.piDesktop.getAppInfo = async () => ({ appVersion: 'test', platform, electronVersion: 'renderer-fixture', nodeVersion: '24' });
	window.piDesktop.listWorkspaceEntriesPage = async () => ({ entries: [], total: 0, nextOffset: null });
	window.piDesktop.searchSessionsPage = async request => {
		review.sessionQueries.push(request);
		return { sessions: [{ cwd, path: `${cwd}/login.jsonl`, id: 'login', name: '梳理登录流程', firstMessage: '梳理登录流程', snippet: '检查登录状态与授权提示', modified: '2026-11-15T08:00:00Z', messageCount: 4 }], total: 1, truncated: false };
	};
	window.piDesktop.searchProjectFiles = async request => {
		review.fileQueries.push(request);
		return { files: [{ path: 'src/components/ConversationHeader.tsx', name: 'ConversationHeader.tsx', kind: 'file' }], total: 1, truncated: false };
	};
	localStorage.setItem('pi-desktop.shortcuts.v1', JSON.stringify({ search: shortcut }));
}

export default async function commandCenterScenarios(review) {
	await review.reducedMotion(true);
	await review.reloadWithFixture(`(${installCommandCenterFixture.toString()})()`);
	await review.viewport(1440, 1000);
	const button = '.pd-top-bar-search';
	const dialog = '.pd-search-dialog';
	const input = '.pd-search-input';
	const replacesTrigger = `(() => { const button=document.querySelector('${button}').getBoundingClientRect(); const field=document.querySelector('.pd-search-input-row').getBoundingClientRect(); return ['left','top','width','height'].every(key => Math.abs(button[key]-field[key])<1); })()`;
	const fitsHeader = `(() => { const button=document.querySelector('${button}').getBoundingClientRect(); const header=document.querySelector('.pd-top-bar').getBoundingClientRect(); const history=document.querySelector('.pd-top-bar-navigation').getBoundingClientRect(); const controls=document.querySelector('.pd-top-bar-session').getBoundingClientRect(); return Math.abs(header.height-36)<1 && button.height===26 && button.left>=history.right && button.right<=controls.left && document.documentElement.scrollWidth<=innerWidth; })()`;
	await review.assert(`document.querySelector('${button}').textContent.includes('pi_desttop') && document.querySelector('${button} kbd').textContent==='Ctrl+K' && document.querySelector('${button}').getBoundingClientRect().width>=500`, 'The title bar shows a wide project-aware search box and its actual shortcut');
	await review.assert(fitsHeader, 'The command center fits the compact title bar without overlapping history or window actions');
	await review.screenshot('command-center-dark');
	const originalLeft = await review.evaluate(`document.querySelector('${button}').getBoundingClientRect().left`);
	for (const view of ['automations', 'plugins']) {
		await review.click(`.pd-activity-${view}`);
		await review.assert(`Math.abs(document.querySelector('${button}').getBoundingClientRect().left-${originalLeft})<1`, `The command center stays in place on the ${view} page`);
		await review.click(`.pd-activity-${view}`);
	}
	await review.click(button);
	await review.waitFor(`document.activeElement===document.querySelector('${input}')`);
	await review.assert(replacesTrigger, 'The editable search field exactly replaces the original title-bar box');
	await review.assert(`document.querySelector('${dialog}').getAttribute('aria-modal')==='false' && !document.querySelector('.pd-search-overlay') && !document.querySelector('.pd-app-shell.is-settings-open') && getComputedStyle(document.querySelector('${button}')).visibility==='hidden'`, 'Search is a floating widget without a backdrop, duplicate field or modal lock');
	await review.waitFor(`document.querySelectorAll('.pd-search-result').length>0`);
	await review.screenshot('command-center-picker');
	await review.viewport(900, 900);
	await review.assert(replacesTrigger, 'The replacement field stays attached to the title-bar box when resized');
	await review.viewport(1440, 1000);
	await review.fill(input, '@ Header');
	await review.waitFor(`window.__commandCenterReview.fileQueries.some(request => request.query==='Header') && document.querySelector('.pd-search-results')?.textContent.includes('ConversationHeader.tsx')`);
	await review.assert(`document.querySelector('[data-segment-key=files]').getAttribute('aria-pressed')==='true'`, 'The existing @ prefix searches project files');
	await review.fill(input, '# 登录');
	await review.waitFor(`window.__commandCenterReview.sessionQueries.some(request => request.query==='登录') && document.querySelector('.pd-search-results')?.textContent.includes('梳理登录流程')`);
	await review.assert(`document.querySelector('[data-segment-key=sessions]').getAttribute('aria-pressed')==='true'`, 'Chinese text and the existing # prefix search conversations');
	await review.fill(input, '> 设置');
	await review.waitFor(`document.querySelector('[data-segment-key=commands]').getAttribute('aria-pressed')==='true' && document.querySelector('.pd-search-result')?.textContent.includes('设置')`);
	await review.key('Enter');
	await review.waitFor(`Boolean(document.querySelector('.pd-settings-dialog')) && !document.querySelector('${dialog}')`);
	await review.key('Escape');
	await review.waitFor(`!document.querySelector('.pd-settings-dialog')`);
	await review.key('k', { ctrl: true });
	await review.waitFor(`Boolean(document.querySelector('${dialog}'))`);
	await review.key('Escape');
	await review.waitFor(`!document.querySelector('${dialog}')`);
	await review.assert(`document.activeElement===document.querySelector('${button}')`, 'Escape restores focus to the title-bar search box');
	await review.click(button);
	await review.waitFor(`Boolean(document.querySelector('${dialog}'))`);
	await review.click('.pd-composer-shell textarea');
	await review.waitFor(`!document.querySelector('${dialog}')`);
	await review.assert(`document.activeElement===document.querySelector('.pd-composer-shell textarea')`, 'Clicking outside closes search and focuses the composer in the same click');
	await review.click(button);
	await review.waitFor(`Boolean(document.querySelector('${dialog}'))`);
	await review.click('.pd-top-bar-workspace-button');
	await review.waitFor(`!document.querySelector('${dialog}') && Boolean(document.querySelector('.pd-workbench.is-open'))`);
	await review.click('.pd-top-bar-workspace-button');
	await review.waitFor(`!document.querySelector('.pd-workbench.is-open')`);

	await review.reloadWithFixture(`localStorage.setItem('pi-desktop.theme','light'); (${installCommandCenterFixture.toString()})()`);
	await review.screenshot('command-center-light');
	await review.click(button);
	await review.waitFor(`Boolean(document.querySelector('${dialog}'))`);
	await review.assert(`!document.querySelector('.pd-search-overlay') && getComputedStyle(document.querySelector('${dialog}')).backdropFilter==='none'`, 'Light mode also keeps the rest of the app clear and undimmed');
	await review.screenshot('command-center-light-picker');
	await review.key('Escape');

	await review.reloadWithFixture(`(${installCommandCenterFixture.toString()})({project:'a-project-with-a-very-long-name-that-must-not-overlap-window-controls'})`);
	for (const width of [900, 540, 400]) {
		await review.viewport(width, 820);
		await review.assert(fitsHeader, `The search box and window controls fit a ${width}px window`);
	}
	await review.screenshot('command-center-narrow');
	await review.click(button);
	await review.waitFor(`Boolean(document.querySelector('${dialog}'))`);
	await review.fill(input, '# 登录');
	await review.waitFor(`document.querySelector('.pd-search-results')?.textContent.includes('梳理登录流程')`);
	await review.assert(replacesTrigger, 'The narrow widget still replaces the original search field in place');
	await review.assert(`(() => { const panel=document.querySelector('.pd-search-panel'); const rect=panel.getBoundingClientRect(); return rect.left>=0 && rect.right<=innerWidth && rect.bottom<=innerHeight && panel.scrollWidth<=panel.clientWidth+1; })()`, 'The narrow results panel expands within the viewport while the input stays in place');
	await review.screenshot('command-center-narrow-picker');
	await review.key('Escape');

	await review.viewport(1440, 1000);
	await review.reloadWithFixture(`(${installCommandCenterFixture.toString()})({conversation:true, project:'2026-11-15-generated-conversation', shortcut:'Ctrl+Shift+F'})`);
	await review.assert(`!document.querySelector('.pd-top-bar-search-project') && document.querySelector('${button} kbd').textContent==='Ctrl+Shift+F'`, 'A conversation outside a project shows the search hint and respects the user shortcut');
	await review.key('f', { ctrl: true, shift: true });
	await review.waitFor(`document.activeElement===document.querySelector('${input}')`);
	await review.key('Escape');
	await review.reloadWithFixture(`(${installCommandCenterFixture.toString()})({platform:'darwin'})`);
	await review.assert(`document.querySelector('${button} kbd').textContent==='⌘K'`, 'The command center displays Mac shortcuts with the command symbol');
}
