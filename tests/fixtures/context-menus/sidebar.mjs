// Isolated renderer interactions; no real sessions or projects are changed.
function installContextMenusFixture() {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const cwd = 'C:\\context-menu-review\\project';
  const rows = Array.from({ length: 14 }, (_, index) => ({ id: `session-${index}`, path: `${cwd}\\session-${index}.jsonl`, name: index ? `对话 ${index + 1}` : '右键菜单位置验证', firstMessage: '菜单位置', modified: '2026-09-27T00:00:00Z', messageCount: 2 }));
  const state = { groups: [
    { id: 'context-top', name: '菜单位置分组', sessionPaths: rows.slice(0, 12).map(row => row.path) },
    { id: 'context-bottom', name: '底部分组', sessionPaths: [rows[12].path] },
  ], writes: [] };
  bridge.getDefaultWorkspace = async () => 'C:\\context-menu-review\\home';
  bridge.listWorkspaces = async () => [cwd];
  bridge.listSessions = async workspace => workspace === cwd ? structuredClone(rows) : [];
  bridge.listSessionGroups = async () => structuredClone(state.groups);
  bridge.updateSessionGroups = async change => { state.writes.push(structuredClone(change)); return structuredClone(state.groups); };
  // Project groups are renderer preferences; seed one so its heading menu can be exercised.
  localStorage.setItem('pi-desktop.project-groups.v1', JSON.stringify([{ id: 'context-top', name: '菜单位置分组', projects: [cwd] }]));
  Object.assign(fixture.snapshot, { cwd, sessionId: rows[0].id, sessionPath: rows[0].path });
  window.__contextMenusReview = state;
}

export default async function sidebarContextMenus(review) {
  const q = JSON.stringify;
  const menu = '.pd-sidebar-popover[role="menu"]';
  const session = '.pd-session-item .pd-session-row';
  const project = '.pd-sidebar-group[data-project-path] .pd-sidebar-group-toggle';
  const more = '.pd-sidebar-group[data-project-path] .pd-group-more[aria-haspopup="menu"]';
  const group = '.pd-sidebar-project-subgroup > .pd-sidebar-group-heading[data-project-group-target="context-top"]';
  const groupToggle = `${group} .pd-sidebar-group-toggle`;
  const groupMore = `${group} .pd-group-more[aria-haspopup="menu"]`;
  const pointFor = selector => review.evaluate(`(() => { const node = document.querySelector(${q(selector)}); node.scrollIntoView({ block: 'nearest' }); const r = node.getBoundingClientRect(); return { x: r.left + 42, y: r.top + r.height / 2 }; })()`);
  async function assertPosition(point, message) {
    await review.assert(`(() => { const r = document.querySelector(${q(menu)}).getBoundingClientRect(); return Math.abs(r.left - Math.max(8, Math.min(${point.x}, innerWidth - r.width - 8))) < 1 && Math.abs(r.top - Math.max(8, Math.min(${point.y}, innerHeight - r.height - 8))) < 1 && r.right <= innerWidth - 7 && r.bottom <= innerHeight - 7; })()`, message);
  }
  async function right(selector) {
    const point = await pointFor(selector);
    await review.rightClick(point.x, point.y);
    await review.waitFor(`Boolean(document.querySelector(${q(menu)}))`);
    return point;
  }
  await review.reloadWithFixture(`(${installContextMenusFixture.toString()})()`);
  await review.viewport(1440, 900);
  await review.reducedMotion(true);
  // A project previews its newest rows; reveal the rest so the bottom-edge row exists.
  await review.waitFor('Boolean(document.querySelector(".pd-session-more"))');
  while (await review.evaluate('Boolean(document.querySelector(".pd-session-more"))')) await review.click('.pd-session-more');
  await review.waitFor('document.querySelectorAll(".pd-session-row").length === 14');
  let point = await right(session);
  await assertPosition(point, 'Conversation menu begins at the right-click point');
  await review.screenshot('conversation-menu-at-pointer');
  await review.key('Escape');
  await review.key('F10', { shift: true });
  await review.waitFor(`Boolean(document.querySelector(${q(menu)}))`);
  await review.assert(`(() => { const r = document.querySelector(${q(session)}).getBoundingClientRect(), m = document.querySelector(${q(menu)}).getBoundingClientRect(); return Math.abs(m.top - (r.bottom + 5)) < 1 && document.activeElement?.getAttribute('role') === 'menuitem'; })()`, 'Keyboard conversation menu uses its row and focuses an action');
  await review.key('Escape');
  point = await right(project);
  await assertPosition(point, 'Project menu begins at the right-click point');
  await review.screenshot('project-menu-at-pointer');
  await review.key('Escape');
  await review.assert(`document.activeElement === document.querySelector(${q(more)})`, 'Escape restores focus to the project menu control');
  await review.key('F10', { shift: true });
  await review.waitFor(`Boolean(document.querySelector(${q(menu)}))`);
  await review.assert(`(() => { const r = document.querySelector(${q(project)}).parentElement.getBoundingClientRect(), m = document.querySelector(${q(menu)}).getBoundingClientRect(); return Math.abs(m.top - (r.bottom + 5)) < 1; })()`, 'Keyboard project menus do not reuse a previous mouse position');
  await review.key('Escape');
  await review.click(more);
  await review.assert(`(() => { const r = document.querySelector(${q(more)}).getBoundingClientRect(), m = document.querySelector(${q(menu)}).getBoundingClientRect(); return Math.abs(m.top - (r.bottom + 5)) < 1; })()`, 'The more button keeps its existing anchored placement');
  await review.key('Escape');
  await review.viewport(960, 600);
  point = await right('.pd-session-item[data-session-path$="session-13.jsonl"] .pd-session-row');
  await assertPosition(point, 'A conversation menu near the bottom stays fully inside the window');
  await review.screenshot('conversation-menu-bottom-edge');
  await review.key('Escape');
  await review.assert(`!document.querySelector(${q(menu)})`, 'Menus remain dismissible with Escape');

  await review.viewport(1440, 900);
  const expandedBefore = await review.evaluate(`document.querySelector(${q(groupToggle)}).getAttribute('aria-expanded')`);
  point = await right(groupToggle);
  await assertPosition(point, 'Project group menu begins at the right-click point');
  await review.assert(`(() => { const items = [...document.querySelectorAll(${q(menu + ' [role="menuitem"]')})]; return items.length === 1 && items[0].textContent.trim() === '解散分组'; })()`, 'The project group menu offers dissolving the group');
  await review.mouseMove(point.x + 12, point.y);
  await review.assert(`document.querySelector(${q(groupToggle)}).getAttribute('aria-expanded') === ${q(expandedBefore)} && !document.querySelector('.pd-sidebar-drag-ghost')`, 'Right-clicking a project group neither toggles it nor starts dragging');
  await review.screenshot('project-group-menu-at-pointer');
  await review.key('Escape');
  await review.assert(`!document.querySelector(${q(menu)})`, 'Escape closes the project group menu');
  await review.click(groupMore);
  await review.assert(`(() => { const r = document.querySelector(${q(groupMore)}).getBoundingClientRect(), m = document.querySelector(${q(menu)}).getBoundingClientRect(); return Math.abs(m.top - (r.bottom + 5)) < 1 && document.querySelector(${q(groupMore)}).getAttribute('aria-expanded') === 'true'; })()`, 'The project group more button opens its menu below itself');
  await review.click(groupMore);
  await review.assert(`!document.querySelector(${q(menu)}) && document.querySelector(${q(groupMore)}).getAttribute('aria-expanded') === 'false'`, 'The same project group more button toggles its menu closed');
  await review.assert(`document.querySelector(${q(groupToggle)}).textContent.includes('菜单位置分组') && JSON.parse(localStorage.getItem('pi-desktop.project-groups.v1')).length === 1`, 'Opening and closing project group menus leaves the group intact');
}
