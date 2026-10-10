// Session management page: machine-wide listing, search/filter, rename,
// archive toggle, and permanent single/bulk deletion with confirmations.
// node tests/fixtures/model-settings/run.mjs --run --scenario=../session-management/scenarios.mjs
function installSessionManagementFixture() {
  const fixture = window.__modelReview, bridge = window.piDesktop, clone = value => structuredClone(value);
  const cwd = fixture.snapshot.cwd;
  const rows = [
    { path: `${cwd}\\manage-current.jsonl`, id: 'manage-current', name: '当前打开的会话', firstMessage: '当前打开的会话', modified: '2026-10-09T09:00:00Z', messageCount: 24, cwd, registered: true, running: false, bytes: 8192 },
    { path: `${cwd}\\manage-alpha.jsonl`, id: 'manage-alpha', name: 'Alpha 归档会话', firstMessage: '第一条消息 alpha', modified: '2026-10-08T09:00:00Z', messageCount: 6, cwd, registered: true, running: false, bytes: 4096, archived: true, pinned: true },
    { path: `${cwd}\\manage-beta.jsonl`, id: 'manage-beta', firstMessage: 'beta 分支调试记录', modified: '2026-10-07T09:00:00Z', messageCount: 3, cwd, registered: true, running: false, bytes: 2048 },
    { path: `E:\\elsewhere\\manage-foreign.jsonl`, id: 'manage-foreign', name: '其他工作区的会话', firstMessage: '其他工作区的会话', modified: '2026-10-06T09:00:00Z', messageCount: 2, cwd: 'E:\\elsewhere', registered: false, running: true, bytes: 1024 },
  ];
  const state = { rows, meta: [], deletes: [] };
  Object.assign(fixture.snapshot, { sessionId: rows[0].id, sessionPath: rows[0].path });
  fixture.emitAgent({ ...clone(fixture.snapshot), type: 'ready' });
  bridge.listMachineSessions = async () => clone(state.rows);
  bridge.updateSessionMeta = async (path, patch) => { state.meta.push([path, clone(patch)]); const row = state.rows.find(item => item.path === path); if (row) Object.assign(row, patch); };
  bridge.deleteSession = async path => { state.deletes.push(path); state.rows = state.rows.filter(item => item.path !== path); };
  window.__sessionManagementReview = state;
}

export default async function sessionManagementScenarios(review) {
  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-sidebar-mode"))');
  await review.viewport(1440, 1000);
  await review.reducedMotion(true);
  await review.reloadWithFixture(`(${installSessionManagementFixture.toString()})()`);
  await review.click('.pd-settings-entry');
  await review.clickText('.pd-settings-nav button', '会话管理');
  await review.waitFor("Boolean(document.querySelector('.pd-session-management-row[data-session-path$=\"manage-beta.jsonl\"]'))");
  await review.assert("document.querySelectorAll('.pd-session-management-row').length === 4", 'Every machine-wide conversation is listed');
  await review.assert("document.querySelectorAll('.pd-session-management-group').length === 2", 'Conversations are grouped by workspace');
  await review.assert("document.querySelector('.pd-session-management-row[data-session-path$=\"manage-foreign.jsonl\"]').closest('.pd-session-management-group').querySelector('.pd-session-management-group-head').textContent.includes('未打开的工作区')", 'Unregistered workspaces are marked on the group header');
  await review.assert("document.querySelector('.pd-session-management-row[data-session-path$=\"manage-beta.jsonl\"]').textContent.includes('当前会话') === false", 'Only the open session carries the current badge');
  await review.screenshot('session-management-01-list');

  await review.evaluate(`(() => { const input = document.querySelector('.pd-session-management-toolbar input[type=search]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, 'beta 分支'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await review.waitFor("document.querySelectorAll('.pd-session-management-row').length === 1");
  await review.assert("document.querySelector('.pd-session-management-count').textContent.includes('显示 1 个')", 'Search narrows the visible rows');
  await review.evaluate(`(() => { const input = document.querySelector('.pd-session-management-toolbar input[type=search]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await review.waitFor("document.querySelectorAll('.pd-session-management-row').length === 4");

  await review.evaluate(`(() => { const row = document.querySelector('.pd-session-management-row[data-session-path$=\"manage-alpha.jsonl\"]'); [...row.querySelectorAll('button')].find(item => item.textContent === '取消归档').click(); })()`);
  await review.waitFor('window.__sessionManagementReview.meta.some(([path, patch]) => path.endsWith("manage-alpha.jsonl") && patch.archived === false)');
  await review.assert("window.__sessionManagementReview.meta.length === 1", 'Unarchive issues exactly one metadata update');

  await review.evaluate(`(() => { const row = document.querySelector('.pd-session-management-row[data-session-path$=\"manage-alpha.jsonl\"]'); [...row.querySelectorAll('button')].find(item => item.textContent === '重命名').click(); })()`);
  await review.waitFor("Boolean(document.querySelector('.pd-session-management-rename'))");
  await review.evaluate(`(() => { const input = document.querySelector('.pd-session-management-rename input'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, '已重命名的会话'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await review.evaluate(`(() => { [...document.querySelectorAll('.pd-session-management-rename footer button')].find(item => item.textContent === '保存').click(); })()`);
  await review.waitFor('window.__sessionManagementReview.meta.some(([path, patch]) => path.endsWith("manage-alpha.jsonl") && patch.name === "已重命名的会话")');

  await review.evaluate(`(() => { const row = document.querySelector('.pd-session-management-row[data-session-path$=\"manage-current.jsonl\"]'); const danger = [...row.querySelectorAll('button')].find(item => item.textContent === '删除'); if (!danger.disabled) throw new Error('current session must not be deletable'); })()`);
  await review.evaluate(`(() => { const row = document.querySelector('.pd-session-management-row[data-session-path$=\"manage-foreign.jsonl\"]'); const danger = [...row.querySelectorAll('button')].find(item => item.textContent === '删除'); if (!danger.disabled) throw new Error('running session must not be deletable'); })()`);

  await review.evaluate(`(() => { const row = document.querySelector('.pd-session-management-row[data-session-path$=\"manage-beta.jsonl\"]'); [...row.querySelectorAll('button')].find(item => item.textContent === '删除').click(); })()`);
  await review.waitFor("Boolean(document.querySelector('.pd-session-delete-dialog[open]'))");
  await review.assert("document.querySelector('.pd-session-delete-dialog').textContent.includes('永久删除')", 'Delete confirms permanent removal');
  await review.key('Escape');
  await review.waitFor("!document.querySelector('.pd-session-delete-dialog[open]')");
  await review.assert('window.__sessionManagementReview.deletes.length === 0', 'Esc cancels without deleting');
  await review.evaluate(`(() => { const row = document.querySelector('.pd-session-management-row[data-session-path$=\"manage-beta.jsonl\"]'); [...row.querySelectorAll('button')].find(item => item.textContent === '删除').click(); })()`);
  await review.waitFor("Boolean(document.querySelector('.pd-session-delete-dialog[open]'))");
  await review.evaluate(`(() => { [...document.querySelectorAll('.pd-session-delete-dialog button')].find(item => item.textContent === '永久删除').click(); })()`);
  await review.waitFor('window.__sessionManagementReview.deletes.some(path => path.endsWith("manage-beta.jsonl"))');
  await review.waitFor("!document.querySelector('.pd-session-management-row[data-session-path$=\"manage-beta.jsonl\"]')");
  await review.screenshot('session-management-02-after-delete');

  await review.evaluate(`(() => { document.querySelector('.pd-session-management-row[data-session-path$=\"manage-alpha.jsonl\"] input[type=checkbox]').click(); })()`);
  await review.clickText('.pd-session-management-toolbar button', '永久删除所选 (1)');
  await review.waitFor("Boolean(document.querySelector('.pd-session-delete-dialog[open]'))");
  await review.evaluate(`(() => { [...document.querySelectorAll('.pd-session-delete-dialog button')].find(item => item.textContent === '永久删除').click(); })()`);
  await review.waitFor('window.__sessionManagementReview.deletes.some(path => path.endsWith("manage-alpha.jsonl"))');
  await review.assert("!document.querySelector('.pd-session-management-row[data-session-path$=\"manage-alpha.jsonl\"]')", 'Bulk deletion removes the selected conversation');
  await review.screenshot('session-management-03-after-bulk');
}
