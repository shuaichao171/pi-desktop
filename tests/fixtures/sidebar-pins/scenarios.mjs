// Built renderer, trusted pointer/key input, and isolated in-memory persistence.
// node tests/fixtures/model-settings/run.mjs --run --scenario=../sidebar-pins/scenarios.mjs
function installSidebarPinsFixture(saved) {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const clone = value => structuredClone(value);
  const paths = { home: fixture.snapshot.cwd, Alpha: 'C:\\sidebar-pins\\Alpha', Bravo: 'C:\\sidebar-pins\\Bravo', Charlie: 'C:\\sidebar-pins\\Charlie' };
  const row = (id, workspace, name, extra = {}) => ({ id, path: paths[workspace] + '\\' + id + '.jsonl', name, firstMessage: name, modified: '2026-09-27T00:00:00Z', messageCount: 2, ...extra });
  const rows = {
    [paths.home]: [row('home', 'home', '未归属项目的对话'), row('home-pin', 'home', '单独置顶的对话', { pinned: true })],
    [paths.Alpha]: [row('alpha', 'Alpha', 'Alpha 当前对话'), row('alpha-more', 'Alpha', 'Alpha 另一条对话'), row('alpha-pin', 'Alpha', 'Alpha 单独置顶的对话', { pinned: true }), row('alpha-archive', 'Alpha', 'Alpha 归档对话', { archived: true, pinned: true })],
    [paths.Bravo]: [row('bravo', 'Bravo', 'Bravo 项目对话')],
    [paths.Charlie]: [row('charlie', 'Charlie', 'Charlie 项目对话')],
  };
  const state = window.__sidebarPinsReview = {
    paths, rows, workspaces: Object.values(paths), pinned: saved?.pinned ?? [],
    groups: [{ id: 'pins-review', name: '自定义分组', sessionPaths: [rows[paths.Alpha][0].path, rows[paths.Bravo][0].path, rows[paths.Charlie][0].path] }],
    writes: [], navigation: [], failNext: false, deferNext: false,
  };
  bridge.getDefaultWorkspace = async () => paths.home;
  bridge.listWorkspaces = async () => clone(state.workspaces);
  bridge.listSessions = async cwd => clone(rows[cwd] ?? []);
  bridge.listSessionGroups = async () => clone(state.groups);
  bridge.listPinnedWorkspaces = async () => clone(state.pinned);
  bridge.setPinnedWorkspaces = async next => {
    state.writes.push(clone(next));
    if (state.failNext) { state.failNext = false; throw new Error('模拟项目置顶保存失败'); }
    if (state.deferNext) {
      state.deferNext = false;
      await new Promise(resolve => { state.resolveSave = () => { delete state.resolveSave; resolve(); }; });
    }
    state.pinned = clone(next);
    return clone(state.pinned);
  };
  bridge.switchWorkspace = async cwd => { state.navigation.push({ kind: 'workspace', cwd }); };
  bridge.switchSession = async path => { state.navigation.push({ kind: 'session', path }); };
  Object.assign(fixture.snapshot, { cwd: paths.Alpha, sessionId: 'alpha', sessionPath: rows[paths.Alpha][0].path, status: 'idle', messages: [], activities: [], runs: [], historyTotal: 0, error: null });
  fixture.emitAgent({ ...clone(fixture.snapshot), type: 'ready' });
  fixture.emitAgent({ type: 'status', status: 'idle' });
}

export default async function sidebarPinsScenarios(review) {
  const q = JSON.stringify, state = 'window.__sidebarPinsReview';
  const prefs = 'JSON.parse(localStorage.getItem("pi-desktop.sidebar-organization.v1"))';
  const pinned = '.pd-sidebar-group[data-section-key="pinned"]';
  const pinToggle = pinned + ' > .pd-sidebar-group-heading .pd-sidebar-group-toggle';
  const menu = '.pd-sidebar-popover[role="menu"]';
  const menuAction = menu + ' > [role="menuitem"]:first-child';
  const filter = '.pd-sidebar-organize-actions button[aria-label="视图选项"]';
  const projectPaths = '[...document.querySelectorAll(".pd-sidebar-group[data-project-path]")].map(node => node.dataset.projectPath)';
  const regularPaths = '[...document.querySelectorAll(".pd-organized-list > .pd-sidebar-group[data-project-path]")].map(node => node.dataset.projectPath)';
  const unique = '(() => { const rows = [...document.querySelectorAll(".pd-session-item[data-session-path]")].map(node => node.dataset.sessionPath); const projects = ' + projectPaths + '; return rows.length === new Set(rows).size && projects.length === new Set(projects).size; })()';
  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-sidebar-mode"))');
  await review.viewport(1440, 1000);
  await review.reducedMotion(true);
  await review.reloadWithFixture(`(${installSidebarPinsFixture.toString()})()`);
  await review.waitFor(`document.querySelectorAll('.pd-session-item[data-session-path]').length === 7`);
  await review.click('[data-mode="project"]');
  const paths = await review.evaluate(`${state}.paths`);
  const project = name => `.pd-sidebar-group[data-project-path=${q(paths[name])}]`;
  const toggle = name => `${project(name)} > .pd-sidebar-group-heading .pd-sidebar-group-toggle`;
  const more = name => `${project(name)} > .pd-sidebar-group-heading .pd-group-more[aria-haspopup="menu"]`;
  const inPinned = name => `Boolean(document.querySelector(${q(project(name))})?.closest(${q(pinned)}))`;
  const expanded = name => `document.querySelector(${q(toggle(name))})?.getAttribute('aria-expanded') === 'true'`;
  const unchanged = `${state}.navigation.length === 0 && document.querySelector('.pd-composer-shell > textarea').value === '置顶项目时保留当前对话和草稿。' && document.querySelector('.pd-session-row[aria-current="page"]')?.textContent.includes('Alpha 当前对话')`;
  const bodyOrder = `JSON.stringify(${regularPaths})`;
  async function open(name, expected) {
    await review.click(more(name));
    await review.waitFor(`Boolean(document.querySelector(${q(menuAction)}))`);
    await review.assert(`document.querySelector(${q(menuAction)}).textContent.trim() === ${q(expected)}`, 'Pin/unpin is the first action in the project menu');
  }
  async function change(name, shouldPin, keyboard = false) {
    await open(name, shouldPin ? '置顶项目' : '取消置顶');
    if (keyboard) {
      await review.assert(`document.activeElement === document.querySelector(${q(menuAction)})`, 'Opening the project menu focuses its first pin action');
      await review.key('Enter');
    } else await review.click(menuAction);
    await review.waitFor(`${state}.pinned.includes(${q(paths[name])}) === ${shouldPin} && !document.querySelector(${q(menu)})`);
    await review.assert(`${inPinned(name)} === ${shouldPin} && ${unique}`, 'Pinning relocates one project without duplicating projects or conversations');
    await review.assert(unchanged, 'Pinning and unpinning preserve the active conversation and composer draft');
  }
  async function view(label) {
    await review.click(filter);
    await review.clickText(menu + ' [role="menuitemradio"]', label);
    await review.key('Escape');
  }
  await review.fill('.pd-composer-shell > textarea', '置顶项目时保留当前对话和草稿。');
  await review.assert(`${bodyOrder} === ${q(JSON.stringify([paths.Alpha, paths.Bravo, paths.Charlie]))}`, 'Ordinary projects begin in the stored project order');
  await change('Bravo', true, true);
  await review.assert('document.activeElement !== document.body && document.activeElement?.closest(".pd-sidebar") !== null', 'Keyboard activation retains a usable sidebar focus after the project moves');
  await change('Alpha', true);
  await review.assert(`document.querySelector('.pd-organized-list > .pd-sidebar-group')?.dataset.sectionKey === 'pinned' && document.querySelectorAll(${q(pinned)}).length === 1`, 'The sidebar has one dedicated pinned section before the ordinary project list');
  await review.assert(`${bodyOrder} === ${q(JSON.stringify([paths.Charlie]))} && ${inPinned('Alpha')} && ${inPinned('Bravo')}`, 'Pinned projects leave the ordinary project section');
  await review.assert(`(() => { const content = document.querySelector(${q(pinned + ' > .pd-sidebar-group-content')}); return content.children[0].dataset.sessionPath?.endsWith('home-pin.jsonl') && content.children[1].dataset.sessionPath?.endsWith('alpha-pin.jsonl') && content.querySelectorAll('[data-project-path]').length === 2; })()`, 'Individually pinned conversations and pinned projects share the section without duplicating a pinned project conversation');
  await review.assert(`document.querySelector(${q(project('Alpha'))}).textContent.includes('Alpha 当前对话') && document.querySelector(${q(project('Alpha'))}).textContent.includes('Alpha 另一条对话') && !document.querySelector(${q(project('Alpha'))}).textContent.includes('Alpha 单独置顶的对话') && !document.querySelector(${q(pinned)}).textContent.includes('Alpha 归档对话')`, 'Expanded pinned projects show their active child conversations while pinned and archived conversations remain correctly separated');
  await review.assert('document.querySelector(".pd-organized-list > .pd-sidebar-group:last-child")?.dataset.sectionKey === "unassigned"', 'Unassigned conversations remain below the ordinary projects');
  await review.click('.pd-composer-shell > textarea');
  await review.mouseMove(1000, 100);
  await review.waitFor('!document.querySelector(".pd-hover-tooltip")');
  await review.screenshot('sidebar-pins-projects-and-conversations');
  await review.viewport(900, 1000);
  await review.assert('document.documentElement.scrollWidth <= innerWidth', 'Pinned projects and conversations do not cause horizontal overflow at 900 pixels');
  await review.screenshot('sidebar-pins-compact-viewport');
  await review.viewport(1440, 1000);

  await review.click('[data-mode="grouped"]');
  await review.assert(`${inPinned('Alpha')} && ${inPinned('Bravo')} && ${unique} && document.querySelectorAll('.pd-session-item[data-session-path]').length === 7`, 'Custom-group mode retains pinned projects and every active conversation exactly once');
  await review.assert(`!document.querySelector('[data-section-key="group:pins-review"]').textContent.includes('Alpha 当前对话') && !document.querySelector('[data-section-key="group:pins-review"]').textContent.includes('Bravo 项目对话')`, 'Pinned project conversations leave their normal custom-group rows');
  await review.click('[data-mode="project"]');
  await view('按时间');
  await review.assert(`${inPinned('Alpha')} && ${inPinned('Bravo')} && ${unique} && document.querySelectorAll('.pd-session-item[data-session-path]').length === 7`, 'Timeline mode retains pinned projects and active conversations exactly once');
  await review.assert(`![...document.querySelectorAll(${q('[data-section-key^="date:"]')})].some(section => /Alpha 当前对话|Bravo 项目对话/.test(section.textContent))`, 'Timeline sections omit conversations already shown under pinned projects');
  await review.click('.pd-sidebar-organize-actions button[aria-label="视图选项"]'); await review.clickText('.pd-sidebar-popover [role="menuitem"]', '查看已归档');
  await review.assert(`!document.querySelector(${q(pinned)}) && !document.querySelector('[data-project-path]') && document.querySelectorAll('.pd-session-item[data-session-path]').length === 1 && document.querySelector('.pd-organized-list').textContent.includes('Alpha 归档对话')`, 'Archive mode shows the archived conversation without any pinned section or active project');
  await review.click('.pd-sidebar-organize-toolbar button[aria-label="返回对话列表"]');
  await view('按项目');
  await review.click(toggle('Alpha'));
  await review.assert(`!(${expanded('Alpha')}) && !document.querySelector(${q(project('Alpha') + ' .pd-session-item')})`, 'Pinned projects can collapse independently of the pinned section');
  await review.click(pinToggle);
  await review.assert(`!document.querySelector(${q(project('Alpha'))}) && ${prefs}.collapsed.includes('pinned') && ${prefs}.collapsed.includes(${q('project:' + paths.Alpha)})`, 'Collapsing the pinned section saves both container and project expansion state');
  const saved = await review.evaluate(`({ pinned: ${state}.pinned })`);
  await review.reloadWithFixture(`(${installSidebarPinsFixture.toString()})(${q(saved)})`);
  await review.waitFor(`Boolean(document.querySelector(${q(pinToggle)}))`);
  await review.assert(`document.querySelector(${q(pinToggle)}).getAttribute('aria-expanded') === 'false' && !document.querySelector(${q(project('Alpha'))})`, 'Reload restores the collapsed pinned section from preferences and project pins from persistence');
  await review.click(pinToggle);
  await review.assert(`${inPinned('Alpha')} && ${inPinned('Bravo')} && !(${expanded('Alpha')})`, 'Expanding the persisted pinned section preserves its independently collapsed project');
  await review.click(toggle('Alpha'));
  await review.fill('.pd-composer-shell > textarea', '置顶项目时保留当前对话和草稿。');
  await change('Alpha', false, true);
  await change('Bravo', false);
  await review.assert(`${bodyOrder} === ${q(JSON.stringify([paths.Alpha, paths.Bravo, paths.Charlie]))} && document.querySelectorAll(${q(pinned + ' [data-project-path]')}).length === 0`, 'Unpinning both projects restores their original ordinary project order while independently pinned conversations remain');

  await review.evaluate(`${state}.failNext = true`);
  await open('Alpha', '置顶项目');
  await review.click(menuAction);
  await review.waitFor(`document.body.textContent.includes('模拟项目置顶保存失败') && !document.querySelector(${q(menu)})`);
  await review.assert(`!${state}.pinned.includes(${q(paths.Alpha)}) && !${inPinned('Alpha')} && ${bodyOrder} === ${q(JSON.stringify([paths.Alpha, paths.Bravo, paths.Charlie]))}`, 'A failed pin save leaves membership and ordinary project order unchanged');
  await review.click(pinToggle);
  await review.evaluate(`${state}.deferNext = true`);
  await open('Alpha', '置顶项目');
  await review.click(menuAction);
  await review.waitFor(`typeof ${state}.resolveSave === 'function'`);
  const writesBefore = await review.evaluate(`${state}.writes.length`);
  await open('Alpha', '置顶项目');
  await review.assert(`document.querySelector(${q(menuAction)}).disabled`, 'The in-flight project pin action is disabled to prevent duplicate writes');
  await review.key('Escape');
  await open('Bravo', '置顶项目');
  await review.assert(`document.querySelector(${q(menuAction)}).disabled && ${state}.writes.length === ${writesBefore}`, 'Other project pin actions wait for the in-flight full-list save so no pin update can be lost');
  await review.key('Escape');
  await review.evaluate(`${state}.resolveSave(); void 0`);
  await review.waitFor(`${state}.pinned.includes(${q(paths.Alpha)}) && ${inPinned('Alpha')}`);
  await review.assert(`document.querySelector(${q(pinToggle)}).getAttribute('aria-expanded') === 'true'`, 'Successfully pinning a project expands the previously collapsed pinned section');
  await change('Bravo', true);
  await review.assert(`${state}.pinned.length === 2 && ${state}.pinned.includes(${q(paths.Alpha)}) && ${state}.pinned.includes(${q(paths.Bravo)}) && ${unique}`, 'Retrying the failed save and then pinning another project preserves both successful changes');
  await review.record('project-pin-persistence', `({ pins: ${state}.pinned, writes: ${state}.writes, navigation: ${state}.navigation, preferences: ${prefs}, activeSession: window.__modelReview.snapshot.sessionPath })`);
}
