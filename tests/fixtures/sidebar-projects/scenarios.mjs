// Real renderer and trusted mouse/key events; workspace/session data remains in memory.
// node tests/fixtures/model-settings/run.mjs --run --scenario=../sidebar-projects/scenarios.mjs
function installSidebarProjectsFixture(saved) {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const clone = value => structuredClone(value);
  const defaultWorkspace = fixture.snapshot.cwd;
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
  const paths = Object.fromEntries(names.map(name => [name, 'C:\\sidebar-projects\\' + name]));
  const rows = Object.fromEntries(names.map(name => [paths[name], [{ id: name, path: paths[name] + '\\conversation.jsonl', name: name + ' 会话', firstMessage: name + ' prompt', modified: '2026-09-27T00:00:00Z', messageCount: 2 }]]));
  rows[paths.Alpha][0].unread = true;
  rows[paths.Bravo][0].runtime = { phase: 'running' };
  rows[paths.Echo][0].runtime = { phase: 'waiting-input' };
  rows[paths.Delta][0].runtime = { phase: 'failed' };
  const state = { paths, rows, workspaces: names.map(name => paths[name]), pinned: saved?.pinned ?? [paths.Bravo, paths.Delta],
    groups: [{ id: 'projects-review', name: '项目测试分组', sessionPaths: [rows[paths.Alpha][0].path, rows[paths.Charlie][0].path] }],
    navigation: [], writes: [], reveals: [], pointers: [], newSessions: 0, newCalls: [], conversationWorkspaces: [] };
  bridge.getDefaultWorkspace = async () => defaultWorkspace;
  bridge.listConversationWorkspaces = async () => [defaultWorkspace, ...state.conversationWorkspaces];
  bridge.listWorkspaces = async () => clone(state.workspaces);
  bridge.listSessions = async cwd => clone(state.rows[cwd] ?? []);
  bridge.listSessionGroups = async () => clone(state.groups);
  bridge.listPinnedWorkspaces = async () => clone(state.pinned);
  bridge.setPinnedWorkspaces = async paths => { state.writes.push({ kind: 'pins', paths: clone(paths) }); state.pinned = clone(paths); return clone(paths); };
  bridge.openWorkspaceFolder = async path => { state.reveals.push(path); };
  bridge.switchWorkspace = async cwd => { state.navigation.push({ kind: 'workspace', cwd }); Object.assign(fixture.snapshot, { cwd, sessionId: state.rows[cwd][0].id, sessionPath: state.rows[cwd][0].path }); fixture.emitAgent({ ...clone(fixture.snapshot), type: 'ready' }); };
  bridge.switchSession = async path => { state.navigation.push({ kind: 'session', path }); };
  bridge.newSession = async options => {
    state.newSessions++;
    const cwd = options?.cwd ?? defaultWorkspace + '\\conversation-' + state.newSessions;
    state.newCalls.push({ cwd, options: clone(options) });
    if (!options?.cwd) state.conversationWorkspaces.push(cwd);
    if (!state.workspaces.includes(cwd)) state.workspaces.push(cwd);
    Object.assign(fixture.snapshot, { cwd, sessionId: 'draft-' + state.newSessions, sessionPath: cwd + '\\draft-' + state.newSessions + '.jsonl', messages: [], activities: [], runs: [], historyTotal: 0 });
    fixture.emitAgent({ ...clone(fixture.snapshot), type: 'ready' });
  };
  bridge.updateSessionOrders = async entries => { state.writes.push({ kind: 'sessions', entries: clone(entries) }); };
  bridge.updateSessionGroups = async change => { state.writes.push({ kind: 'groups', change: clone(change) }); return clone(state.groups); };
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'contextmenu']) document.addEventListener(type, event => {
    if (!(event.target instanceof Element) || (!event.target.closest('.pd-sidebar') && event.buttons !== 1)) return;
    state.pointers.push({ type, trusted: event.isTrusted, buttons: event.buttons, pointerId: event.pointerId });
  }, true);
  Object.assign(fixture.snapshot, { cwd: paths.Alpha, sessionId: 'Alpha', sessionPath: rows[paths.Alpha][0].path, status: 'idle', messages: [], activities: [], runs: [], error: null });
  fixture.emitAgent({ ...clone(fixture.snapshot), type: 'ready' });
  fixture.emitAgent({ type: 'status', status: 'idle' });
  window.__sidebarProjectsReview = state;
}

export default async function sidebarProjectsScenarios(review) {
  const q = JSON.stringify, state = 'window.__sidebarProjectsReview', prefKey = 'pi-desktop.sidebar-organization.v1';
  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-sidebar-mode"))');
  await review.viewport(1440, 1200);
  await review.reducedMotion(false);
  await review.reloadWithFixture(`(${installSidebarProjectsFixture.toString()})();`);
  await review.click('[data-mode="project"]');
  await review.waitFor(`document.querySelectorAll('.pd-sidebar-group[data-section-key^="project:"]').length === 6`);
  const paths = await review.evaluate(`${state}.paths`);
  const section = name => `.pd-sidebar-group[data-section-key=${q('project:' + paths[name])}]`;
  const heading = name => `${section(name)} .pd-sidebar-group-heading`;
  const toggle = name => `${section(name)} .pd-sidebar-group-toggle`;
  const more = name => `${section(name)} .pd-group-more[aria-haspopup="menu"]`;
  const menu = '.pd-sidebar-popover[role="menu"]';
  const order = `Array.from(document.querySelectorAll('.pd-sidebar-group[data-section-key^="project:"]')).map(node => node.dataset.sectionKey.slice(8))`;
  const preferences = `JSON.parse(localStorage.getItem(${q(prefKey)}))`;
  const collapsed = `JSON.stringify(${preferences}.collapsed)`;
  const noBadges = `!document.querySelector('.pd-sidebar-group-toggle > small')`;
  const symbolsOnly = `(() => { const states = Array.from(document.querySelectorAll('.pd-session-state-counts')); return states.length > 0 && states.every(node => !/[0-9]/.test(node.textContent) && /^[!↻×•\\s]+$/u.test(node.textContent) && node.getAttribute('aria-label')); })()`;
  const uniqueRows = `(() => { const paths = Array.from(document.querySelectorAll('.pd-session-item[data-session-path]')).map(row => row.dataset.sessionPath); return new Set(paths).size === paths.length; })()`;
  async function point(selector, fraction = .5) {
    return review.evaluate(`(() => { const node = document.querySelector(${q(selector)}); if (!node) throw new Error('Missing pointer target'); node.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const rect = node.getBoundingClientRect(), x = rect.left + Math.min(rect.width * .45, 95), y = rect.top + rect.height * ${fraction}; const hit = document.elementFromPoint(x,y); if (!rect.width || !rect.height || !(hit === node || node.contains(hit))) throw new Error('Pointer target obscured'); return {x,y}; })()`);
  }
  async function right(name) { const p = await point(toggle(name)); await review.rightClick(p.x, p.y); await review.waitFor(`Boolean(document.querySelector(${q(menu)}))`); }
  // The menu starts at the context-click position, so dismiss from the title's exposed left edge.
  async function click(name) { const p = await review.evaluate(`(() => { const r = document.querySelector(${q(toggle(name))}).getBoundingClientRect(); return { x: r.left + 16, y: r.top + r.height / 2 }; })()`); await review.mouseDown(p.x, p.y); await review.mouseUp(); }
  async function closed(message) { await review.assert(`!document.querySelector(${q(menu)})`, message); }
  const expanded = name => `document.querySelector(${q(toggle(name))}).getAttribute('aria-expanded') === 'true'`;

  await right('Alpha');
  const beforeToggle = await review.evaluate(expanded('Alpha'));
  await click('Alpha');
  await closed('Clicking the same project title closes its context menu');
  await review.assert(`${expanded('Alpha')} === ${!beforeToggle}`, 'The outside title click still performs its normal collapse toggle exactly once');
  await right('Alpha'); await click('Bravo');
  await closed('Clicking another project title closes the previous project menu');
  await right('Alpha'); await review.click('.pd-sidebar-brand .pd-brand-mark');
  await closed('Clicking the sidebar brand closes the context menu');
  await review.click(more('Alpha')); await review.waitFor(`Boolean(document.querySelector(${q(menu)}))`);
  await review.click(more('Alpha'));
  await closed('Clicking the same more button toggles its open menu closed');
  await review.click(more('Alpha')); await review.click(more('Bravo'));
  await review.assert(`document.querySelectorAll(${q(menu)}).length === 1 && document.querySelector(${q(more('Bravo'))}).getAttribute('aria-expanded') === 'true' && document.querySelector(${q(more('Alpha'))}).getAttribute('aria-expanded') === 'false'`, 'Switching more buttons leaves one menu belonging to the latest project');
  await review.key('Escape');
  await review.assert(`!document.querySelector(${q(menu)}) && document.activeElement === document.querySelector(${q(more('Bravo'))})`, 'Escape restores keyboard focus to the actual project menu button');
  await right('Alpha'); await review.key('Escape');
  await review.assert(`document.activeElement === document.querySelector(${q(more('Alpha'))})`, 'Escape from a context menu opened on the title restores focus to its more button');
  await review.click(more('Alpha'));
  await review.clickText(`${menu} [role=menuitem]`, '在资源管理器中打开');
  await review.assert(`${state}.reveals.length === 1 && ${state}.reveals[0] === ${q(paths.Alpha)} && !document.querySelector(${q(menu)})`, 'A menu action executes once for the intended project and closes normally');
  await right('Alpha');
  const plus = await point(`${section('Alpha')} .pd-group-more:not([aria-haspopup])`);
  await review.mouseDown(plus.x, plus.y); await review.mouseMove(plus.x + 9, plus.y);
  await review.assert(`!document.querySelector('.pd-sidebar-drag-ghost') && !document.querySelector(${q(menu)})`, 'Pressing the project plus button closes its menu and never starts project dragging');
  await review.mouseUp();
  await review.waitFor(`${state}.newSessions === 1`);
  await review.assert(`${state}.newSessions === 1 && ${state}.newCalls[0].options?.cwd === ${q(paths.Alpha)} && window.__modelReview.snapshot.cwd === ${q(paths.Alpha)} && ${state}.conversationWorkspaces.length === 0`, 'The project plus button creates one conversation in its explicitly selected directory');
  await review.click(more('Alpha')); await review.clickText(`${menu} [role=menuitem]`, '置顶项目');
  await review.waitFor(`${state}.pinned.includes(${q(paths.Alpha)})`);
  await review.click(more('Alpha')); await review.clickText(`${menu} [role=menuitem]`, '取消置顶');
  await review.waitFor(`!${state}.pinned.includes(${q(paths.Alpha)})`);
  await review.assert(noBadges, 'Project headings display no total-session count badges');
  await review.assert(symbolsOnly, 'Project attention indicators preserve their symbols and accessible details without visible numeric badges');
  await review.click('[data-mode="grouped"]');
  await review.assert(`${noBadges} && ${uniqueRows}`, 'Custom groups and Ungrouped retain unique members without total-session count badges');
  await review.assert(symbolsOnly, 'Grouped attention indicators contain status symbols instead of visible counts');
  await review.click('.pd-sidebar-group[data-section-key="group:projects-review"] .pd-group-more');
  await review.clickText(`${menu} [role=menuitem]`, '重命名分组');
  await review.assert('document.activeElement === document.querySelector("#pd-sidebar-group-name") && Boolean(document.querySelector(".pd-sidebar-popover[role=dialog]"))', 'Changing the group menu into a rename dialog keeps focus in the new editor');
  await review.key('Escape');
  await review.click('[data-mode="project"]');
  await review.click('.pd-sidebar-organize-actions button[aria-label="视图选项"]');
  if (await review.evaluate(`[...document.querySelectorAll('.pd-sidebar-popover [role="menuitem"]')].some(item => item.textContent.trim() === '展开全部分组')`)) { await review.clickText('.pd-sidebar-popover [role="menuitem"]', '展开全部分组'); await review.click('.pd-sidebar-organize-actions button[aria-label="视图选项"]'); }
  await review.clickText('.pd-sidebar-popover [role="menuitem"]', '收起全部分组');
  await review.click('.pd-sidebar-group[data-section-key="pinned"] > .pd-sidebar-group-heading .pd-sidebar-group-toggle');
  await review.screenshot('sidebar-projects-menus-and-count-free-headings');

  // A short press remains a click; only moving past the threshold starts reordering.
  let p = await point(toggle('Alpha'));
  const beforeThreshold = await review.evaluate(`({ order: ${order}, preferences: localStorage.getItem(${q(prefKey)}), writes: ${state}.writes.length })`);
  await review.mouseDown(p.x, p.y); await review.mouseMove(p.x + 3, p.y);
  await review.assert(`!document.querySelector('.pd-sidebar-drag-ghost') && JSON.stringify(${order}) === ${q(JSON.stringify(beforeThreshold.order))}`, 'Movement below the drag threshold does not reorder projects');
  await review.mouseUp();
  await review.assert(expanded('Alpha'), 'Releasing a short press still expands the project');
  await click('Alpha');
  await review.assert(`!(${expanded('Alpha')}) && ${state}.writes.length === ${beforeThreshold.writes}`, 'A normal project-title click collapses without issuing a backend write');

  let audit;
  async function begin(name) {
    audit = await review.evaluate(`({ order: ${order}, persisted: JSON.stringify(${preferences}.projectOrder ?? []), collapsed: ${collapsed}, navigation: ${state}.navigation.length, writes: ${state}.writes.length, pinned: JSON.stringify(${state}.pinned) })`);
    const start = await point(toggle(name));
    await review.mouseDown(start.x, start.y); await review.mouseMove(start.x + 9, start.y);
    await review.waitFor('Boolean(document.querySelector(".pd-sidebar-drag-ghost"))');
  }
  async function aim(name, side) {
    const target = await point(heading(name), side === 'before' ? .2 : .8);
    await review.mouseMove(target.x, target.y, 3);
    await review.waitFor(`document.querySelector(${q(section(name))}).dataset.projectDrop === ${q(side)}`);
    await review.assert(`JSON.stringify(${preferences}.projectOrder ?? []) === ${q(audit.persisted)} && ${state}.writes.length === ${audit.writes}`, 'Held project dragging does not persist a preview or issue a backend write');
  }
  async function release(source, target, side) {
    const expected = audit.order.filter(path => path !== paths[source]);
    expected.splice(expected.indexOf(paths[target]) + Number(side === 'after'), 0, paths[source]);
    await review.mouseUp();
    await review.waitFor(`!document.querySelector('.pd-sidebar-drag-ghost') && JSON.stringify(${order}) === ${q(JSON.stringify(expected))}`);
    await review.assert(`${collapsed} === ${q(audit.collapsed)} && ${state}.navigation.length === ${audit.navigation}`, 'Releasing a reordered project neither toggles its expansion nor navigates to a conversation');
    await review.assert(`JSON.stringify(${state}.pinned) === ${q(audit.pinned)} && ${preferences}.projectOrder.length === new Set(${preferences}.projectOrder).size && ${state}.workspaces.every(path => ${preferences}.projectOrder.includes(path)) && ${noBadges}`, 'Saving project order preserves pin membership, unique project entries, and count-free headings');
  }
  await begin('Alpha'); await aim('Echo', 'after');
  await review.screenshot('sidebar-projects-drag-ghost-and-insertion-line');
  await release('Alpha', 'Echo', 'after');
  await review.assert(`${preferences}.projectOrder.indexOf(${q(paths.Bravo)}) === ${JSON.parse(audit.persisted).indexOf(paths.Bravo)} && ${preferences}.projectOrder.indexOf(${q(paths.Delta)}) === ${JSON.parse(audit.persisted).indexOf(paths.Delta)}`, 'Dragging ordinary projects retains pinned project positions for a later unpin');
  await begin('Foxtrot'); await aim('Charlie', 'before'); await release('Foxtrot', 'Charlie', 'before');
  await begin('Charlie');
  await aim('Alpha', 'after'); await aim('Foxtrot', 'before'); await aim('Echo', 'after'); await aim('Alpha', 'after');
  await release('Charlie', 'Alpha', 'after');
  await review.screenshot('sidebar-projects-reordered-with-pinned-partition');

  await begin('Echo'); await aim('Foxtrot', 'before');
  await review.key('Escape'); await review.mouseUp();
  await review.assert(`!document.querySelector('.pd-sidebar-drag-ghost') && JSON.stringify(${order}) === ${q(JSON.stringify(audit.order))} && JSON.stringify(${preferences}.projectOrder ?? []) === ${q(audit.persisted)} && ${collapsed} === ${q(audit.collapsed)}`, 'Escape rolls back project dragging without saving order or toggling the pressed project');
  for (const lifecycle of ['pointercancel', 'blur']) {
    await begin('Echo'); await aim('Foxtrot', 'before');
    await review.evaluate(lifecycle === 'pointercancel'
      ? `window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: ${state}.pointers.findLast(event => event.type === 'pointerdown').pointerId, pointerType: 'mouse', bubbles: true, buttons: 0 }))`
      : `window.dispatchEvent(new Event('blur'))`);
    await review.record('synthetic-project-drag-' + lifecycle, `({ lifecycle: ${q(lifecycle)}, syntheticLifecycle: true, trustedPointerSteps: ${state}.pointers.filter(event => event.buttons === 1).length })`);
    await review.mouseUp();
    await review.assert(`!document.querySelector('.pd-sidebar-drag-ghost') && JSON.stringify(${order}) === ${q(JSON.stringify(audit.order))} && JSON.stringify(${preferences}.projectOrder ?? []) === ${q(audit.persisted)} && ${collapsed} === ${q(audit.collapsed)}`, lifecycle + ' cancels the real pointer drag without saving or collapsing a project');
  }
  await begin('Bravo'); await aim('Delta', 'after'); await release('Bravo', 'Delta', 'after');
  await begin('Echo');
  const pinnedTarget = await point(heading('Delta'));
  await review.mouseMove(pinnedTarget.x, pinnedTarget.y, 3);
  await review.assert(`!document.querySelector(${q(section('Delta'))}).dataset.projectDrop`, 'An unpinned project cannot advertise a drop into the pinned partition');
  await review.mouseUp();
  await review.assert(`JSON.stringify(${order}) === ${q(JSON.stringify(audit.order))} && JSON.stringify(${state}.pinned) === ${q(audit.pinned)} && JSON.stringify(${preferences}.projectOrder ?? []) === ${q(audit.persisted)}`, 'Cross-partition release keeps both pin membership and project order unchanged');
  await review.assert(`${state}.pointers.some(event => event.type === 'contextmenu' && event.trusted) && ${state}.pointers.some(event => event.type === 'pointermove' && event.buttons === 1) && ${state}.pointers.every(event => event.trusted)`, 'Context menus and drag moves were exercised with trusted mouse input');

  const expectedOrder = await review.evaluate(order);
  const saved = await review.evaluate(`({ pinned: ${state}.pinned })`);
  await review.reloadWithFixture(`(${installSidebarProjectsFixture.toString()})(${q(saved)});`);
  await review.waitFor(`document.querySelectorAll('.pd-sidebar-group[data-section-key^="project:"]').length === 6`);
  await review.assert(`JSON.stringify(${order}) === ${q(JSON.stringify(expectedOrder))} && ${noBadges}`, 'Renderer reload restores manual project order and the pinned partition even when the bridge returns its original order');
  await review.screenshot('sidebar-projects-reloaded-persistent-order');
}
