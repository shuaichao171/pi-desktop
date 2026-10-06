// Focused verification for the zcode-inspired batch archive deletion: one
// batched store call (single session-list refresh for the whole batch),
// pre-flight re-validation of the stale selection (skipped ≠ failed), and
// per-path independent outcomes. Runs against the real renderer:
// node tests/fixtures/model-settings/run.mjs --run --scenario=../sidebar-titles/bulk-delete.mjs
function installBulkDeleteFixture() {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const clone = value => structuredClone(value);
  const cwd = 'C:\\bulk-delete-review\\project';
  const rows = [
    { id: 'current', name: '当前对话' },
    { id: 'arch-a', name: '归档甲', archived: true },
    { id: 'arch-b', name: '归档乙', archived: true },
    { id: 'arch-c', name: '归档丙', archived: true },
  ].map((row, order) => ({ ...row, path: cwd + '\\' + row.id + '.jsonl', firstMessage: row.name, order,
    modified: '2026-09-27T00:00:00Z', messageCount: 2 }));
  const state = { cwd, rows, deletes: [], writes: [], listCalls: 0 };
  bridge.getDefaultWorkspace = async () => 'C:\\bulk-delete-review\\home';
  bridge.listWorkspaces = async () => [cwd];
  bridge.listSessions = async workspace => {
    state.listCalls += 1;
    return workspace === cwd ? clone(rows) : [];
  };
  bridge.listSessionGroups = async () => [];
  bridge.updateSessionMeta = async (path, patch) => {
    const row = rows.find(item => item.path === path);
    if (!row) throw new Error('Unexpected session metadata target');
    state.writes.push({ path, patch: clone(patch) });
    Object.assign(row, patch);
  };
  bridge.deleteSession = async path => {
    const index = rows.findIndex(item => item.path === path);
    if (index < 0) throw new Error('会话不存在');
    state.deletes.push(path);
    rows.splice(index, 1);
  };
  bridge.switchSession = async () => {};
  Object.assign(fixture.snapshot, { cwd, sessionId: rows[0].id, sessionPath: rows[0].path,
    status: 'idle', messages: [], activities: [], runs: [], error: null });
  localStorage.setItem('pi-desktop.sidebar-width', '274');
  localStorage.setItem('pi-desktop.sidebar-organization.v1', JSON.stringify({ mode: 'grouped' }));
  localStorage.setItem('pi-desktop.theme', 'dark');
  window.__bulkDeleteReview = state;
}

export default async function bulkDeleteScenarios(review) {
  const q = JSON.stringify, state = 'window.__bulkDeleteReview';
  const row = id => `.pd-session-item[data-session-path$="${id}.jsonl"]`;
  const present = id => `Boolean(document.querySelector(${q(row(id))}))`;
  const checkbox = id => `${row(id)} .pd-archive-session-checkbox`;

  await review.viewport(1440, 900);
  await review.reloadWithFixture(`(${installBulkDeleteFixture.toString()})()`);
  await review.waitFor('document.querySelectorAll(".pd-session-title-text").length === 1');
  await review.mouseMove(700, 600);

  // Enter the archive view and select two of the three archived conversations.
  await review.click('.pd-sidebar-organize-actions button[aria-label="显示归档对话"]');
  await review.waitFor('document.querySelectorAll(".pd-session-title-text").length === 3');
  await review.click(checkbox('arch-a'));
  await review.click(checkbox('arch-b'));
  await review.assert(`document.querySelector(${q(checkbox('arch-a'))}).checked && document.querySelector(${q(checkbox('arch-b'))}).checked`, 'Archive checkboxes select conversations for batch deletion');

  // Open the confirmation; while it sits open the selection goes stale: one
  // conversation was unarchived from the outside (zcode: the confirm dialog
  // may outlive the state it was opened from).
  await review.click('[data-action="delete-selected-archived"]');
  await review.waitFor('document.querySelector(".pd-session-bulk-trash-dialog")?.open === true');
  const baseline = await review.evaluate(`${state}.listCalls`);
  await review.evaluate(`(() => { const row = ${state}.rows.find(item => item.id === 'arch-b'); row.archived = false; })()`);

  // Confirm: the still-valid path is deleted, the stale one is skipped with an
  // explanatory note (not an error), the untouched one survives, and the whole
  // batch costs exactly one pre-flight + one refresh listSessions call.
  await review.click('.pd-session-bulk-trash-dialog footer .is-danger');
  await review.waitFor(`!${present('arch-a')}`);
  await review.waitFor('document.querySelectorAll(".pd-session-bulk-trash-list li").length === 1');
  await review.waitFor('Boolean(document.querySelector(".pd-session-trash-skip"))');
  await review.assert(`(() => { const skip = document.querySelector('.pd-session-trash-skip'); const failures = document.querySelectorAll('.pd-session-trash-error'); return skip && skip.textContent.includes('已跳过') && failures.length === 0 && document.querySelector('.pd-session-bulk-trash-dialog').open === true; })()`, 'A stale selection item is skipped with a note while the dialog stays open for review');
  await review.assert(`${state}.deletes.length === 1 && ${state}.deletes[0].endsWith('arch-a.jsonl') && ${state}.writes.length === 0 && ${present('arch-c')} && ${state}.listCalls - ${baseline} === 2`, 'The batch deletes only the still-archived path with one pre-flight plus one refresh refetch');
  await review.screenshot('bulk-delete-skipped');

  // Close the dialog: the unarchived conversation has left the archive view
  // via the single batch refresh and is back among active conversations.
  await review.click('.pd-session-bulk-trash-dialog footer button:not(.is-danger)');
  await review.waitFor('document.querySelector(".pd-session-bulk-trash-dialog") === null');
  await review.assert(`!${present('arch-b')} && ${present('arch-c')}`, 'After the batch the archive view reflects the refreshed state');
  await review.click('.pd-sidebar-organize-actions button[aria-label="关闭归档视图"]');
  await review.waitFor(`${present('current')} && ${present('arch-b')} && !${present('arch-a')}`);
  await review.assert(`${state}.rows.length === 3 && ${state}.rows.every(item => item.id !== 'arch-a')`, 'Closing the review dialog keeps the deletion and the unarchived restore');
}
