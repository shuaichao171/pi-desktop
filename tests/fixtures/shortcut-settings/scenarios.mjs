// Settings → keyboard shortcuts: grouped list, inline rebinding, conflicts and reset.
// node tests/fixtures/model-settings/run.mjs --run --scenario=../shortcut-settings/scenarios.mjs
const row = label => `[...document.querySelectorAll('.pd-shortcut-rows li')].find(item => item.querySelector('.pd-shortcut-label > span')?.textContent === ${JSON.stringify(label)})`;

export default async function shortcutSettingsScenarios(review) {
  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-sidebar-mode"))');
  await review.viewport(1440, 1000);
  await review.reducedMotion(true);
  await review.evaluate("localStorage.removeItem('pi-desktop.shortcuts.v1')");
  await review.click('.pd-settings-entry');
  await review.clickText('.pd-settings-nav button', '快捷键');
  await review.waitFor("Boolean(document.querySelector('.pd-shortcut-rows li'))");
  await review.assert("document.querySelectorAll('.pd-shortcut-group').length === 3", 'Shortcuts are grouped by scope');
  await review.assert(`${row('跳到上一轮对话')}.textContent.includes('↑') && !${row('跳到上一轮对话')}.textContent.includes('ArrowUp')`, 'Arrow keys render as glyph keycaps');
  await review.assert(`${row('停止生成')}.textContent.includes('Esc') && !${row('停止生成')}.querySelector('button')`, 'Fixed typing keys are not rebindable');
  await review.assert("[...document.querySelectorAll('.pd-shortcut-rows li')].some(row => row.textContent.includes('发送消息 / 任务进行时') && row.textContent.includes('Enter')) && [...document.querySelectorAll('.pd-shortcut-rows li')].some(row => row.textContent.includes('Ctrl') && row.textContent.includes('Enter') && row.classList.contains('is-fixed'))", 'Send and its alternate Ctrl+Enter are listed as fixed keys');
  await review.assert("document.querySelector('.pd-shortcut-reset-all').disabled", 'Reset all is disabled without overrides');
  await review.screenshot('shortcuts-01-list');
  await review.evaluate("(() => { const content = document.querySelector('.pd-settings-content'); content.scrollTop = content.scrollHeight; })()");
  await review.screenshot('shortcuts-01-fixed-keys');
  await review.evaluate("document.querySelector('.pd-settings-content').scrollTop = 0");

  await review.evaluate(`${row('展开或收起侧栏')}.querySelector('.pd-shortcut-capture').click()`);
  await review.waitFor("Boolean(document.querySelector('.pd-shortcut-capture.is-capturing'))");
  await review.screenshot('shortcuts-02-capturing');
  await review.key('Escape');
  await review.waitFor("!document.querySelector('.pd-shortcut-capture.is-capturing')");
  await review.assert(`${row('展开或收起侧栏')}.textContent.includes('B')`, 'Escape cancels capture without rebinding');

  await review.evaluate(`${row('展开或收起侧栏')}.querySelector('.pd-shortcut-capture').click()`);
  await review.key('k', { ctrl: true });
  await review.waitFor(`JSON.parse(localStorage.getItem('pi-desktop.shortcuts.v1') || '{}').toggleSidebar === 'Ctrl+K'`);
  await review.assert(`Boolean(${row('展开或收起侧栏')}.querySelector('.pd-shortcut-conflict')) && Boolean(${row('打开搜索')}.querySelector('.pd-shortcut-conflict'))`, 'Both sides of a conflict are flagged');
  await review.assert(`${row('展开或收起侧栏')}.textContent.includes('已修改') && !document.querySelector('.pd-shortcut-reset-all').disabled`, 'A rebound shortcut is marked modified');
  await review.screenshot('shortcuts-03-conflict');

  await review.evaluate(`${row('展开或收起侧栏')}.querySelector('.pd-shortcut-reset').click()`);
  await review.waitFor(`!JSON.parse(localStorage.getItem('pi-desktop.shortcuts.v1') || '{}').toggleSidebar`);
  await review.assert("!document.querySelector('.pd-shortcut-conflict')", 'Per-row reset clears the conflict');

  await review.evaluate(`${row('新会话')}.querySelector('.pd-shortcut-capture').click()`);
  await review.key('m', { ctrl: true, shift: true });
  await review.waitFor(`JSON.parse(localStorage.getItem('pi-desktop.shortcuts.v1') || '{}').newSession === 'Ctrl+Shift+M'`);
  await review.click('.pd-shortcut-reset-all');
  await review.waitFor(`Object.keys(JSON.parse(localStorage.getItem('pi-desktop.shortcuts.v1') || '{}')).length === 0`);

  await review.clickText('.pd-settings-nav button', '外观');
  await review.clickText('.pd-appearance-choice', '浅色');
  await review.clickText('.pd-settings-nav button', '快捷键');
  await review.waitFor("Boolean(document.querySelector('.pd-shortcut-rows li'))");
  await review.screenshot('shortcuts-04-light');
  await review.viewport(680, 900);
  await review.assert('document.documentElement.scrollWidth <= innerWidth', 'Shortcut settings have no horizontal overflow at narrow width');
  await review.screenshot('shortcuts-05-narrow');
}
