// Built renderer, trusted pointer/key input, and isolated in-memory persistence.
// Pinned conversations lead their own project (or unassigned) list; pinned
// projects lead the project list. There is no separate pinned section.
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
    writes: [], navigation: [], failNext: false, deferNext: false,
  };
  bridge.getDefaultWorkspace = async () => paths.home;
  bridge.listWorkspaces = async () => clone(state.workspaces);
  bridge.listSessions = async cwd => clone(rows[cwd] ?? []);
  bridge.listSessionGroups = async () => [];
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
  const menu = '.pd-sidebar-popover[role="menu"]';
  const menuAction = menu + ' [role="menuitem"][data-action$="pin-project"]';
  const filter = '.pd-sidebar-organize-actions button[aria-label="视图选项"]';
  const ungrouped = '.pd-sidebar-region[data-region-id="ungrouped-projects"]';
  const unassigned = '.pd-sidebar-region[data-region-id="unassigned-sessions"]';
  const projectOrder = `JSON.stringify([...document.querySelectorAll(${q(ungrouped + ' .pd-sidebar-group[data-project-path]')})].map(node => node.dataset.projectPath))`;
  const rows = container => `[...document.querySelectorAll(${q(container + ' .pd-session-item[data-session-path]')})].map(node => node.dataset.sessionPath.split(/[\\\\/]/).pop())`;
  const unique = '(() => { const rows = [...document.querySelectorAll(".pd-session-item[data-session-path]")].map(node => node.dataset.sessionPath); const projects = [...document.querySelectorAll(".pd-sidebar-group[data-project-path]")].map(node => node.dataset.projectPath); return rows.length === new Set(rows).size && projects.length === new Set(projects).size; })()';
  const activeRows = n => `document.querySelectorAll('.pd-session-item[data-session-path]').length === ${n}`;
  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-activity-bar"))');
  await review.viewport(1440, 1000);
  await review.reducedMotion(true);
  await review.reloadWithFixture(`(${installSidebarPinsFixture.toString()})()`);
  // Seven active conversations: the archived pinned one stays in the archive.
  await review.waitFor(activeRows(7));
  const paths = await review.evaluate(`${state}.paths`);
  const project = name => `${ungrouped} .pd-sidebar-group[data-project-path=${q(paths[name])}]`;
  const more = name => `${project(name)} > .pd-sidebar-group-heading .pd-group-more[aria-haspopup="menu"]`;
  const order = (...names) => `${projectOrder} === ${q(JSON.stringify(names.map(name => paths[name])))}`;
  const unchanged = `${state}.navigation.length === 0 && document.querySelector('.pd-composer-shell > textarea').value === '置顶项目时保留当前对话和草稿。' && document.querySelector('.pd-session-row[aria-current="page"]')?.textContent.includes('Alpha 当前对话')`;

  await review.assert(unique, 'Every active conversation and project appears exactly once');
  await review.assert(`(() => { const list = ${rows(project('Alpha'))}; return list[0] === 'alpha-pin.jsonl' && list.length === 3; })()`, 'A pinned project conversation leads its own project list');
  await review.assert(`(() => { const list = ${rows(unassigned)}; return list[0] === 'home-pin.jsonl' && list.length === 2; })()`, 'A pinned unassigned conversation leads the unassigned list');
  await review.assert(`document.querySelectorAll('.pd-session-item.is-pinned').length === 2 && [...document.querySelectorAll('.pd-session-item.is-pinned')].every(item => getComputedStyle(item.querySelector('.pd-session-pin')).opacity === '1')`, 'Pinned conversations keep their pin visible');
  await review.assert(`!document.querySelector('.pd-sidebar').textContent.includes('Alpha 归档对话')`, 'An archived pinned conversation stays out of the active sidebar');

  async function open(name, expected) {
    await review.click(more(name));
    await review.waitFor(`Boolean(document.querySelector(${q(menuAction)}))`);
    await review.assert(`document.querySelector(${q(menuAction)}).textContent.trim().startsWith(${q(expected)})`, 'The project menu offers pin/unpin with the matching label');
  }
  async function change(name, shouldPin, keyboard = false) {
    await open(name, shouldPin ? '置顶项目' : '取消置顶');
    // Keyboard path: the P accelerator shown beside the row triggers it.
    if (keyboard) await review.key('p');
    else await review.click(menuAction);
    await review.waitFor(`${state}.pinned.includes(${q(paths[name])}) === ${shouldPin} && !document.querySelector(${q(menu)})`);
    await review.assert(unique, 'Pinning moves one project without duplicating projects or conversations');
    await review.assert(unchanged, 'Pinning and unpinning preserve the active conversation and composer draft');
  }
  await review.fill('.pd-composer-shell > textarea', '置顶项目时保留当前对话和草稿。');
  await review.assert(order('Alpha', 'Bravo', 'Charlie'), 'Projects begin in the stored project order');
  await change('Charlie', true, true);
  await review.assert('document.activeElement !== document.body && document.activeElement?.closest(".pd-sidebar") !== null', 'Keyboard activation retains a usable sidebar focus after the project moves');
  await change('Bravo', true);
  await review.assert(order('Bravo', 'Charlie', 'Alpha'), 'Pinned projects move to the top of the project list in their stored order');
  await review.assert(`${rows(project('Alpha'))}[0] === 'alpha-pin.jsonl'`, 'An unpinned project keeps its pinned conversation first');
  await review.screenshot('sidebar-pins-projects-and-conversations');
  await review.viewport(900, 1000);
  await review.assert('document.documentElement.scrollWidth <= innerWidth', 'Pinned projects and conversations do not cause horizontal overflow at 900 pixels');
  await review.screenshot('sidebar-pins-compact-viewport');
  await review.viewport(1440, 1000);

  // 仅置顶 lists exactly the pinned conversations, each in its own place.
  await review.click(filter);
  await review.clickText(menu + ' [role="menuitemradio"]', '仅置顶');
  await review.key('Escape');
  await review.waitFor(activeRows(2));
  await review.assert(`${rows(project('Alpha'))}.join() === 'alpha-pin.jsonl' && ${rows(unassigned)}.join() === 'home-pin.jsonl'`, 'The pinned-only filter shows every pinned conversation under its project');
  await review.screenshot('sidebar-pins-filter');
  await review.click('.pd-sidebar-filter-chip');
  await review.waitFor(activeRows(7));
  await review.click(filter);
  await review.clickText(menu + ' [role="menuitem"]', '查看已归档');
  await review.waitFor(activeRows(1));
  await review.assert(`document.querySelector('.pd-organized-list').textContent.includes('Alpha 归档对话') && !document.querySelector('[data-project-path]')`, 'Archive mode shows the archived pinned conversation without any project');
  await review.click('.pd-sidebar-organize-toolbar button[aria-label="返回对话列表"]');
  await review.waitFor(activeRows(7));

  const saved = await review.evaluate(`({ pinned: ${state}.pinned })`);
  await review.reloadWithFixture(`(${installSidebarPinsFixture.toString()})(${q(saved)})`);
  await review.waitFor(order('Bravo', 'Charlie', 'Alpha'));
  await review.assert('true', 'Reload restores project pins from persistence');
  await review.fill('.pd-composer-shell > textarea', '置顶项目时保留当前对话和草稿。');
  await change('Charlie', false, true);
  await change('Bravo', false);
  await review.assert(`${order('Alpha', 'Bravo', 'Charlie')} && ${rows(unassigned)}[0] === 'home-pin.jsonl'`, 'Unpinning both projects restores the original project order while pinned conversations stay first');

  await review.evaluate(`${state}.failNext = true`);
  await open('Alpha', '置顶项目');
  await review.click(menuAction);
  await review.waitFor(`document.body.textContent.includes('模拟项目置顶保存失败') && !document.querySelector(${q(menu)})`);
  await review.assert(`!${state}.pinned.includes(${q(paths.Alpha)}) && ${order('Alpha', 'Bravo', 'Charlie')}`, 'A failed pin save leaves membership and project order unchanged');
  await review.evaluate(`${state}.deferNext = true`);
  await open('Charlie', '置顶项目');
  await review.click(menuAction);
  await review.waitFor(`typeof ${state}.resolveSave === 'function'`);
  const writesBefore = await review.evaluate(`${state}.writes.length`);
  await open('Charlie', '置顶项目');
  await review.assert(`document.querySelector(${q(menuAction)}).disabled`, 'The in-flight project pin action is disabled to prevent duplicate writes');
  await review.key('Escape');
  await open('Bravo', '置顶项目');
  await review.assert(`document.querySelector(${q(menuAction)}).disabled && ${state}.writes.length === ${writesBefore}`, 'Other project pin actions wait for the in-flight full-list save so no pin update can be lost');
  await review.key('Escape');
  await review.evaluate(`${state}.resolveSave(); void 0`);
  await review.waitFor(`${state}.pinned.includes(${q(paths.Charlie)}) && ${order('Charlie', 'Alpha', 'Bravo')}`);
  await change('Bravo', true);
  await review.assert(`${state}.pinned.length === 2 && ${state}.pinned.includes(${q(paths.Charlie)}) && ${state}.pinned.includes(${q(paths.Bravo)}) && ${unique}`, 'Retrying after a failed save and then pinning another project preserves both successful changes');
  await review.record('project-pin-persistence', `({ pins: ${state}.pinned, writes: ${state}.writes, navigation: ${state}.navigation, activeSession: window.__modelReview.snapshot.sessionPath })`);
}
