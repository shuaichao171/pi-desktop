// Built renderer with trusted pointer/key input and in-memory session mutations only.
// node tests/fixtures/model-settings/run.mjs --run --scenario=../archive-selection/scenarios.mjs
function installArchiveSelectionFixture() {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const clone = value => structuredClone(value);
  const workspaces = ['C:\\archive-review\\Alpha', 'D:\\archive-review\\Beta'];
  const row = (id, workspace, extra = {}) => ({ id, path: workspace + '\\' + id + '.jsonl', name: '归档 ' + id, firstMessage: id + ' prompt', modified: '2026-09-27T00:00:00Z', messageCount: 2, archived: true, ...extra });
  const active = row('active', workspaces[0], { archived: false, pinned: true, name: '正在使用的非归档对话' });
  const entries = [row('Alpha', workspaces[0], { pinned: true, unread: true }), row('Bravo', workspaces[1], { unread: true }), row('Charlie', workspaces[0]), row('Delta', workspaces[1])];
  const late = row('Later', workspaces[0], { name: '确认后新增的归档' });
  const state = { workspaces, active, entries, late, rows: { [workspaces[0]]: [active, entries[0], entries[2]], [workspaces[1]]: [entries[1], entries[3]] }, navigation: [], deletes: [], failures: {}, deferNext: false, pending: null, injectLate: false };
  bridge.getDefaultWorkspace = async () => 'C:\\archive-review\\automatic';
  bridge.listConversationWorkspaces = async () => [];
  bridge.listWorkspaces = async () => clone(workspaces);
  bridge.listSessions = async cwd => clone(state.rows[cwd] ?? []);
  bridge.listSessionGroups = async () => [];
  bridge.listPinnedWorkspaces = async () => [];
  bridge.switchSession = async path => { state.navigation.push(path); };
  bridge.deleteSession = async path => {
    state.deletes.push(path);
    if (state.deferNext) { state.deferNext = false; await new Promise(resolve => { state.pending = resolve; }); state.pending = null; }
    if (state.failures[path]) { state.failures[path]--; throw new Error('模拟归档删除失败'); }
    for (const cwd of workspaces) state.rows[cwd] = state.rows[cwd].filter(entry => entry.path !== path);
    if (state.injectLate) { state.injectLate = false; state.rows[workspaces[0]].push(clone(late)); }
  };
  fixture.sessionStats = { sessionId: active.id, userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, tokens: { input: 1234, output: 432, cacheRead: 876, cacheWrite: 54, total: 2596 }, cost: 0, timing: { sampledAt: Date.now(), durationMs: 54000, running: false, latestRun: { id: 'archive-review-run', durationMs: 12000, outputTokens: 432, running: false } } };
  // The snapshot matches fixture.sessionStats: one finished run with a user message and its reply.
  const runAt = Date.now();
  Object.assign(fixture.snapshot, { cwd: workspaces[0], sessionId: active.id, sessionPath: active.path, status: 'idle', activities: [], error: null,
    runs: [{ id: 'archive-review-run', status: 'completed', startedAt: runAt - 12000, finishedAt: runAt }],
    messages: [{ id: 'archive-review-u', runId: 'archive-review-run', order: 0, role: 'user', text: '整理归档会话', status: 'done' }, { id: 'archive-review-a', runId: 'archive-review-run', order: 1, role: 'assistant', text: '归档会话已整理。', status: 'done' }] });
  localStorage.setItem('pi-desktop.sidebar-organization.v1', JSON.stringify({ mode: 'grouped', projectView: 'project', filter: 'all', sort: 'newest', collapsed: [], projectOrder: [] }));
  localStorage.setItem('pi-desktop:conversation-metrics', JSON.stringify({ speed: true, tokens: true, cache: true, duration: true }));
  window.__archiveSelectionReview = state;
}

export default async function archiveSelectionScenarios(review) {
  const q = JSON.stringify, state = 'window.__archiveSelectionReview';
  const toolbar = '.pd-archive-selection-toolbar';
  const all = `${toolbar} input[aria-label="全选归档会话"]`;
  const remove = `${toolbar} button[data-action="delete-selected-archived"]`;
  const dialog = 'dialog.pd-session-bulk-trash-dialog';
  const selected = 'document.querySelectorAll("input.pd-archive-session-checkbox:checked").length';
  const checkboxes = 'document.querySelectorAll("input.pd-archive-session-checkbox").length';
  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-sidebar-mode"))');
  await review.viewport(1440, 1000);
  await review.reloadWithFixture(`(${installArchiveSelectionFixture.toString()})();`);
  await review.waitFor('document.querySelectorAll(".pd-metric-group").length === 4');
  const data = await review.evaluate(`({ entries: ${state}.entries, active: ${state}.active, late: ${state}.late, workspaces: ${state}.workspaces })`);
  const row = path => `.pd-session-item[data-session-path=${q(path)}]`;
  const checkbox = path => `${row(path)} input.pd-archive-session-checkbox`;
  async function hover(selector) {
    const point = await review.evaluate(`(() => { const e = document.querySelector(${q(selector)}); e.scrollIntoView({block:'nearest'}); const r = e.getBoundingClientRect(); return { x:r.left+r.width/2, y:r.top+r.height/2 }; })()`);
    await review.mouseMove(point.x, point.y);
    await review.evaluate('new Promise(resolve => setTimeout(resolve, 250))');
  }
  async function filter(text) {
    await review.click('.pd-sidebar-organize-actions button[aria-label="视图选项"]');
    await review.clickText('.pd-sidebar-popover [role="menuitemradio"]', text);
    await review.key('Escape');
  }
  async function openArchive() {
    await review.click('.pd-sidebar-organize-actions button[aria-label="视图选项"]'); await review.clickText('.pd-sidebar-popover [role="menuitem"]', '查看已归档');
    await review.waitFor(`Boolean(document.querySelector(${q(toolbar)})) && ${checkboxes} === 4`);
  }
  async function cancel() {
    await review.clickText(`${dialog} footer button`, '取消');
    await review.assert(`!document.querySelector(${q(dialog)}) && ${state}.deletes.length === 0`, 'Cancelling the selection confirmation performs no session deletion');
  }

  // Visible metrics remain readable and accessible without hover descriptions.
  for (const selector of ['.pd-metric-speed', '.pd-metric-input', '.pd-metric-cache', '.pd-metric-duration']) {
    await hover(selector);
    await review.assert('!document.querySelector("[role=tooltip]") && !document.querySelector(".pd-conversation-metrics [title], .pd-conversation-metrics [aria-describedby]")', 'Conversation statistics do not create a pointer tooltip or native title');
  }
  await review.assert('Array.from(document.querySelectorAll(".pd-metric-group")).every(element => element.getAttribute("aria-label") && element.tabIndex < 0) && document.querySelector(".pd-conversation-metrics").textContent.includes("36 t/s")', 'All metric values remain displayed with accessible descriptions and no extra keyboard tab stops');
  await review.evaluate('document.querySelector(".pd-settings-entry").focus()');
  await hover('.pd-settings-entry');
  await review.assert('document.activeElement === document.querySelector(".pd-settings-entry") && !document.querySelector("[role=tooltip]") && !document.querySelector(".pd-settings-entry[title], .pd-settings-entry[aria-describedby]")', 'Settings accepts keyboard focus and pointer hover without displaying a tooltip');
  await review.key('Enter');
  await review.waitFor('Boolean(document.querySelector(".pd-settings-dialog"))');
  await review.click('.pd-settings-header button[aria-label="关闭设置"]');

  await openArchive();
  await review.assert(`!document.querySelector(${q(row(data.active.path))}) && document.querySelector(${q(remove)}).disabled && !document.querySelector(${q(all)}).checked`, 'The archive starts unselected and excludes the active non-archived conversation');
  // Hovering a conversation row must not open the right-side hover tooltip.
  await hover(row(data.entries[0].path));
  await review.assert(`document.querySelector('.pd-hover-tooltip') === null`, 'Hovering a conversation row no longer opens the right-side tooltip');
  await review.screenshot('archive-selection-row-hover-no-tooltip');
  await review.click(checkbox(data.entries[0].path));
  await review.assert(`${selected} === 1 && document.querySelector(${q(all)}).indeterminate && ${state}.navigation.length === 0 && !document.querySelector(${q(remove)}).disabled`, 'Selecting a single archive entry sets the partial checkbox state without opening the conversation');
  await review.click(remove);
  await review.waitFor(`Boolean(document.querySelector(${q(dialog)}))`);
  await review.assert(`document.querySelector(${q(dialog)}).textContent.includes(${q(data.entries[0].name)}) && !document.querySelector(${q(dialog)}).textContent.includes(${q(data.entries[1].name)})`, 'The confirmation names only the selected session');
  await cancel();
  await review.click('.pd-sidebar-organize-toolbar button[aria-label="返回对话列表"]');
  await review.assert(`!document.querySelector(${q(toolbar)}) && ${checkboxes} === 0`, 'Archive selection controls disappear outside the archive');
  await openArchive();
  await review.assert(`${selected} === 0 && !document.querySelector(${q(all)}).indeterminate`, 'Leaving and re-entering the archive clears its previous selection');

  await filter('仅置顶');
  await review.waitFor(`${checkboxes} === 1`);
  await review.click(all);
  await review.assert(`${selected} === 1 && document.querySelector(${q(checkbox(data.entries[0].path))}).checked && document.querySelector(${q(all)}).checked && !document.querySelector(${q(all)}).indeterminate`, 'Select all selects only archived conversations matching the active pinned filter');
  await review.click(remove);
  await review.assert(`document.querySelector(${q(dialog)}).textContent.includes(${q(data.entries[0].name)}) && !document.querySelector(${q(dialog)}).textContent.includes(${q(data.active.name)}) && !document.querySelector(${q(dialog)}).textContent.includes(${q(data.entries[1].name)})`, 'Filtered bulk deletion cannot include non-archived or filtered-out sessions');
  await cancel();
  await review.click('.pd-sidebar-filter-chip');
  await review.waitFor(`${checkboxes} === 4`);
  if (await review.evaluate(`document.querySelector(${q(all)}).checked`)) await review.click(all);
  await review.click(all);
  await review.assert(`${selected} === 4 && document.querySelector(${q(all)}).checked && !document.querySelector(${q(all)}).indeterminate && ${state}.navigation.length === 0`, 'Select all includes archived sessions across project directories without navigating');
  await review.screenshot('archive-selection-all-with-metrics');
  await review.click(remove);
  await review.assert(`${state}.entries.every(entry => document.querySelector(${q(dialog)}).textContent.includes(entry.name))`, 'The bulk confirmation shows every chosen session title before a write');
  await review.screenshot('archive-selection-confirmation');

  // Entries are snapshotted when confirmation opens. A refreshed archive entry
  // arriving during deletion must never become an implicit deletion target.
  await review.evaluate(`${state}.failures[${q(data.entries[1].path)}] = 1; ${state}.deferNext = true; ${state}.injectLate = true;`);
  await review.clickText(`${dialog} footer button`, '永久删除');
  await review.waitFor(`Boolean(${state}.pending)`);
  await review.key('Escape');
  await review.assert(`Boolean(document.querySelector(${q(dialog)})) && Array.from(document.querySelectorAll(${q(dialog + ' footer button')})).every(button => button.disabled) && ${state}.deletes.length === 1`, 'An in-flight deletion cannot be dismissed or submitted twice');
  await review.evaluate(`${state}.pending()`);
  await review.waitFor(`${state}.deletes.length === 4 && Boolean(document.querySelector(${q(dialog + ' [role="alert"]')})) && Array.from(document.querySelectorAll(${q(dialog + ' footer button')})).some(button => !button.disabled)`);
  await review.assert(`document.querySelector(${q(dialog)}).textContent.includes(${q(data.entries[1].name)}) && !document.querySelector(${q(dialog)}).textContent.includes(${q(data.entries[0].name)}) && !document.querySelector(${q(dialog)}).textContent.includes(${q(data.entries[2].name)}) && !document.querySelector(${q(dialog)}).textContent.includes(${q(data.entries[3].name)})`, 'A partially failed operation retains only the failed title in its retry list');
  await review.assert(`${state}.deletes.every(path => ${state}.entries.some(entry => entry.path === path)) && !${state}.deletes.includes(${q(data.late.path)}) && !${state}.deletes.includes(${q(data.active.path)})`, 'Only the confirmed snapshot is deleted despite a newly arriving archived conversation');
  await review.screenshot('archive-selection-partial-failure');
  await review.clickText(`${dialog} footer button`, '重试');
  await review.waitFor(`!document.querySelector(${q(dialog)}) && ${state}.deletes.length === 5 && ${checkboxes} === 1`);
  await review.assert(`${state}.entries.every(entry => ${state}.deletes.filter(path => path === entry.path).length === (entry.path === ${q(data.entries[1].path)} ? 2 : 1)) && Boolean(document.querySelector(${q(row(data.late.path))})) && ${selected} === 0 && document.querySelector(${q(remove)}).disabled && !document.querySelector(${q(all)}).checked && !document.querySelector(${q(all)}).indeterminate`, 'Retry deletes only the failed entry once more, leaves new entries intact, and clears successful selection');
  await review.click(all);
  await review.click(remove);
  await review.clickText(`${dialog} footer button`, '永久删除');
  await review.waitFor(`!document.querySelector(${q(dialog)}) && ${checkboxes} === 0`);
  await review.assert(`${state}.deletes.length === 6 && document.querySelector(${q(all)}).disabled && document.querySelector(${q(remove)}).disabled && !document.querySelector(${q(all)}).indeterminate && ${state}.navigation.length === 0 && ${state}.rows[${q(data.workspaces[0])}].some(entry => entry.path === ${q(data.active.path)})`, 'Deleting the final visible archive entry leaves an empty disabled selector and preserves the active conversation');
  await review.screenshot('archive-selection-empty');
}
