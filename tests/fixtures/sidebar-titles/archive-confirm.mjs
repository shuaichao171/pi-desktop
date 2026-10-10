// Focused verification for the zcode-style inline archive confirm and the
// optimistic session-meta overlay (flip first, converge via refetch, roll back
// on failure). Runs against the real renderer:
// node tests/fixtures/model-settings/run.mjs --run --scenario=../sidebar-titles/archive-confirm.mjs
function installArchiveConfirmFixture() {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const clone = value => structuredClone(value);
  const cwd = 'C:\\archive-confirm-review\\project';
  const rows = [
    { id: 'keep', name: '保留的对话' },
    { id: 'target', name: '要归档的对话' },
    { id: 'other', name: '相邻的对话' },
  ].map((row, order) => ({ ...row, path: cwd + '\\' + row.id + '.jsonl', firstMessage: row.name, order,
    modified: '2026-09-27T00:00:00Z', messageCount: 2 }));
  const state = { cwd, rows, writes: [], navigation: [], failNext: 0 };
  bridge.getDefaultWorkspace = async () => 'C:\\archive-confirm-review\\home';
  bridge.listWorkspaces = async () => [cwd];
  bridge.listSessions = async workspace => workspace === cwd ? clone(rows) : [];
  bridge.listSessionGroups = async () => [];
  bridge.updateSessionMeta = async (path, patch) => {
    if (state.failNext > 0) {
      state.failNext -= 1;
      // Keep the optimistic flip painted long enough to observe the rollback.
      await new Promise(resolve => setTimeout(resolve, 150));
      throw new Error('模拟归档写入失败');
    }
    const row = rows.find(item => item.path === path);
    if (!row) throw new Error('Unexpected session metadata target');
    state.writes.push({ path, patch: clone(patch) });
    Object.assign(row, patch);
  };
  bridge.switchSession = async path => { state.navigation.push(path); };
  Object.assign(fixture.snapshot, { cwd, sessionId: rows[0].id, sessionPath: rows[0].path,
    status: 'idle', messages: [], activities: [], runs: [], error: null });
  localStorage.setItem('pi-desktop.sidebar-width', '274');
  localStorage.setItem('pi-desktop.sidebar-organization.v1', JSON.stringify({ mode: 'grouped' }));
  localStorage.setItem('pi-desktop.theme', 'dark');
  window.__archiveConfirmReview = state;
}

export default async function archiveConfirmScenarios(review) {
  const q = JSON.stringify, state = 'window.__archiveConfirmReview';
  const row = id => `.pd-session-item[data-session-path$="${id}.jsonl"]`;
  const archiveButton = id => `${row(id)} [data-session-action="archive"]`;
  const armed = id => `document.querySelector(${q(row(id))})?.classList.contains('is-archive-confirming')`;
  const present = id => `Boolean(document.querySelector(${q(row(id))}))`;
  const away = () => review.mouseMove(700, 600);
  // Hover actions are hidden until the row is hovered; the harness checks
  // hit-testing before it moves the pointer, so hover the row first (as the
  // title scenarios do) and keep it hovered across the two clicks.
  const moveTo = async id => {
    const point = await review.evaluate(`(() => { const node = document.querySelector(${q(row(id))}); node.scrollIntoView({ block: 'nearest' }); const rect = node.getBoundingClientRect(); return { x: rect.left + 48, y: rect.top + rect.height / 2 }; })()`);
    await review.mouseMove(point.x, point.y);
    await review.waitFor(`document.querySelector(${q(row(id))}).matches(':hover')`);
  };

  await review.viewport(1440, 900);
  await review.reloadWithFixture(`(${installArchiveConfirmFixture.toString()})()`);
  await review.waitFor('document.querySelectorAll(".pd-session-title-text").length === 3');
  await away();

  // 1. The first click only arms the confirm, and the armed button stays
  //    visible even after the pointer leaves the row.
  await moveTo('target');
  await review.click(archiveButton('target'));
  await review.waitFor(armed('target'));
  await away();
  await review.assert(`(() => { const item = document.querySelector(${q(row('target'))}); const button = item.querySelector('[data-session-action="archive"]'); return button.classList.contains('is-confirming') && button.getAttribute('aria-label').startsWith('确认归档') && getComputedStyle(item.querySelector('.pd-session-actions')).opacity === '1' && ${state}.writes.length === 0; })()`, 'The first archive click arms a hover-independent inline confirm and writes nothing');
  await review.screenshot('archive-confirm-armed');

  // 2. Escape cancels the armed confirm.
  await review.key('Escape');
  await review.assert(`!${armed('target')} && ${state}.writes.length === 0`, 'Escape cancels the armed confirm without writing');

  // 3. A press outside the confirming row cancels it (and can open that row).
  await moveTo('other');
  await review.click(archiveButton('other'));
  await review.waitFor(armed('other'));
  await review.click(`${row('keep')} .pd-session-row`);
  await review.assert(`!${armed('other')} && ${state}.writes.length === 0`, 'A click outside the confirming row cancels it');

  // 4. The second click on the same row commits; the overlay removes the row
  //    from the active list before persistence resolves.
  await moveTo('target');
  await review.click(archiveButton('target'));
  await review.waitFor(armed('target'));
  await review.click(archiveButton('target'));
  await review.waitFor(`!document.querySelector(${q(row('target'))})`);
  await review.assert(`${state}.writes.length === 1 && ${state}.writes[0].patch.archived === true && ${state}.rows.find(r => r.id === 'target').archived === true && ${state}.navigation.length === 1`, 'The confirming second click archives exactly its conversation without opening it');
  await review.screenshot('archive-confirm-committed');

  // 5. Unarchive stays immediate: in the archive view one click restores the
  //    row, and the optimistic flip moves it back at once.
  await review.click('.pd-sidebar-organize-actions button[aria-label="视图选项"]'); await review.clickText('.pd-sidebar-popover [role="menuitem"]', '查看已归档');
  await review.waitFor(`Boolean(document.querySelector(${q(row('target'))}))`);
  await moveTo('target');
  await review.click(archiveButton('target'));
  await review.waitFor(`!document.querySelector(${q(row('target'))})`);
  await review.click('.pd-sidebar-organize-toolbar button[aria-label="返回对话列表"]');
  await review.waitFor(`Boolean(document.querySelector(${q(row('target'))}))`);
  await review.assert(`${state}.writes.length === 2 && ${state}.writes[1].patch.archived === false && ${state}.rows.find(r => r.id === 'target').archived === false`, 'Restoring from the archive view is a single immediate click in both views');

  // 6. A failed write rolls the optimistic flip back into the list.
  await review.evaluate(`${state}.failNext = 1`);
  await moveTo('target');
  await review.click(archiveButton('target'));
  await review.waitFor(armed('target'));
  await review.click(archiveButton('target'));
  await review.waitFor(`!document.querySelector(${q(row('target'))})`);
  await review.waitFor(`Boolean(document.querySelector(${q(row('target'))}))`, 2000);
  await review.assert(`${state}.writes.length === 2 && ${state}.rows.find(r => r.id === 'target').archived === false`, 'A failed archive write rolls the row back into the active list');
  await review.screenshot('archive-confirm-rollback');
}
