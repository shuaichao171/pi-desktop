// 「已加载会话」：右键加载、拖到左上角已加载区、Ctrl+Tab 切换、拖到对话右侧分屏打开，
// 以及窗格自身关闭仅隐藏、从已加载区恢复或彻底关闭。全部为模拟 bridge，不启动真实窗格。
// node tests/fixtures/model-settings/run.mjs --run --scenario=../loaded-sessions/scenarios.mjs
function installLoadedSessionsFixture() {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const clone = value => structuredClone(value);
  const home = fixture.snapshot.cwd;
  const row = (id, name) => ({ id, path: home + '\\' + id + '.jsonl', name, firstMessage: name, modified: '2026-11-0' + (id.length % 9 + 1) + 'T00:00:00Z', messageCount: 4 });
  const rows = [row('login-flow', '调研登录流程'), row('release-notes', '整理发布说明'), row('build-script', '修复构建脚本')];
  const state = window.__loadedReview = { rows, loads: [], unloads: [], switches: [], opened: [], hidden: [], closed: [], panes: [], nextPane: 7 };
  const changed = new Set(), closed = new Set();
  const emitPanes = () => { for (const listener of changed) listener(clone(state.panes)); };
  bridge.getDefaultWorkspace = async () => home;
  bridge.listWorkspaces = async () => [home];
  bridge.listSessions = async cwd => clone(cwd === home ? rows : []);
  bridge.listSessionsPage = async (cwd, offset, limit) => { const list = cwd === home ? rows : []; return { sessions: clone(list.slice(offset, offset + limit)), total: list.length, hasMore: offset + limit < list.length, revision: 1 }; };
  bridge.listSessionGroups = async () => [];
  bridge.listPinnedWorkspaces = async () => [];
  bridge.loadSession = async (cwd, path) => { state.loads.push(path); };
  bridge.unloadSession = async path => { state.unloads.push(path); };
  bridge.describeSplitPanes = async () => clone(state.panes);
  bridge.listSplitPanes = async () => state.panes.map(pane => pane.paneId);
  bridge.onSplitPaneChanged = listener => { changed.add(listener); return () => changed.delete(listener); };
  bridge.onSplitPaneClosed = listener => { closed.add(listener); return () => closed.delete(listener); };
  bridge.setSplitPaneBounds = async () => {};
  bridge.focusHostedSession = async () => false;
  bridge.openSplitPane = async (cwd, path) => {
    const paneId = state.nextPane++;
    state.opened.push(path);
    state.panes.push({ paneId, cwd, sessionPath: path, hidden: false, busy: false });
    emitPanes();
    return paneId;
  };
  bridge.setSplitPaneHidden = async (hidden, paneId) => {
    const pane = state.panes.find(item => item.paneId === paneId);
    if (!pane) throw new Error('fixture pane missing');
    state.hidden.push({ paneId, hidden });
    pane.hidden = hidden;
    emitPanes();
  };
  bridge.closeSplitPane = async paneId => {
    state.closed.push(paneId);
    state.panes = state.panes.filter(item => item.paneId !== paneId);
    emitPanes();
    for (const listener of closed) listener(paneId);
  };
  bridge.switchSession = async path => {
    state.switches.push(path);
    const target = rows.find(item => item.path === path);
    Object.assign(fixture.snapshot, { sessionId: target?.id ?? 'other', sessionPath: path, messages: [], activities: [], historyTotal: 0 });
    fixture.emitAgent({ ...clone(fixture.snapshot), type: 'ready' });
  };
}

export default async function loadedSessionsScenarios(review) {
  const q = JSON.stringify;
  const rowOf = title => `[...document.querySelectorAll('.pd-session-item')].find(item => item.querySelector('.pd-session-title-text')?.textContent === ${q(title)})`;
  const center = selectorExpression => review.evaluate(`(() => { const e = ${selectorExpression}; if (!e) throw new Error('missing'); e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
  const loadedTitles = `[...document.querySelectorAll('.pd-loaded-session-title')].map(e => e.textContent)`;

  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-activity-bar"))');
  await review.viewport(1440, 900);
  await review.reducedMotion(true);
  await review.reloadWithFixture(`(${installLoadedSessionsFixture.toString()})()`);
  await review.waitFor(`document.querySelectorAll('.pd-session-item[data-session-path]').length >= 3 && Boolean(document.querySelector('.pd-loaded-sessions'))`);
  await review.assert(`document.querySelector('.pd-sidebar-regions').firstElementChild.classList.contains('pd-loaded-sessions')`, 'The loaded-sessions region sits at the top of the sidebar regions');
  await review.assert(`document.querySelector('.pd-loaded-sessions-empty')?.textContent.includes('拖动')`, 'An empty loaded list explains right-click and drag');
  await review.screenshot('loaded-01-empty');

  // Right-click → 加载到已加载会话.
  const first = await center(rowOf('调研登录流程'));
  await review.rightClick(first.x, first.y);
  await review.clickText('[role="menuitem"]', '加载到已加载会话');
  await review.waitFor(`${loadedTitles}.includes('调研登录流程')`);
  await review.assert(`window.__loadedReview.loads.length === 1 && window.__loadedReview.loads[0].endsWith('login-flow.jsonl')`, 'Loading from the menu asks the main agent to keep the conversation warm');

  // Drag a row onto the loaded region.
  const second = await center(rowOf('整理发布说明'));
  const region = await center(`document.querySelector('.pd-loaded-sessions')`);
  await review.mouseDown(second.x, second.y);
  await review.mouseMove(second.x + 10, second.y - 10, 2);
  await review.mouseMove(region.x, region.y, 8);
  await review.waitFor(`Boolean(document.querySelector('.pd-loaded-sessions.is-drop-hover')) && Boolean(document.querySelector('.pd-session-drag-ghost'))`);
  await review.assert(`document.querySelector('.pd-session-drag-ghost').textContent === '整理发布说明'`, 'The drag ghost names the dragged conversation');
  await review.screenshot('loaded-02-drag-to-loaded');
  await review.mouseUp();
  await review.waitFor(`${loadedTitles}.includes('整理发布说明')`);
  await review.assert(`!document.querySelector('.pd-session-drag-ghost') && !document.querySelector('.pd-session-split-drop')`, 'Dropping clears the ghost and the split drop zone');
  await review.assert(`window.__loadedReview.switches.length === 0`, 'A drag never doubles as a click that opens the conversation');
  await review.assert(`JSON.parse(localStorage.getItem('pi-desktop:loaded-sessions')).length === 2`, 'The loaded list persists for the next launch');
  await review.screenshot('loaded-03-two-loaded');

  // Ctrl+Tab cycles the loaded conversations.
  await review.evaluate(`document.activeElement?.blur?.()`);
  await review.key('Tab', { ctrl: true });
  await review.waitFor(`window.__loadedReview.switches.length === 1`);
  await review.assert(`window.__loadedReview.switches[0].endsWith('login-flow.jsonl')`, 'Ctrl+Tab from an unlisted conversation enters at the first loaded one');
  await review.waitFor(`document.querySelector('.pd-loaded-session.is-active .pd-loaded-session-title')?.textContent === '调研登录流程'`);
  await review.key('Tab', { ctrl: true });
  await review.waitFor(`window.__loadedReview.switches.length === 2`);
  await review.assert(`window.__loadedReview.switches[1].endsWith('release-notes.jsonl')`, 'Ctrl+Tab moves to the next loaded conversation');
  await review.waitFor(`document.querySelector('.pd-loaded-session.is-active .pd-loaded-session-title')?.textContent === '整理发布说明'`);
  await review.key('Tab', { ctrl: true, shift: true });
  await review.waitFor(`window.__loadedReview.switches.length === 3`);
  await review.assert(`window.__loadedReview.switches[2].endsWith('login-flow.jsonl')`, 'Ctrl+Shift+Tab goes back');
  await review.screenshot('loaded-04-ctrl-tab');

  // Drag a row onto the right part of the chat area → split pane.
  const third = await center(rowOf('修复构建脚本'));
  const chat = await review.evaluate(`(() => { const b = document.querySelector('.pd-chat-view-host:not([hidden])').getBoundingClientRect(); return { x: Math.round(b.right - b.width * 0.2), y: Math.round(b.y + b.height / 2) }; })()`);
  await review.mouseDown(third.x, third.y);
  await review.mouseMove(third.x + 12, third.y, 2);
  await review.mouseMove(chat.x, chat.y, 10);
  await review.waitFor(`Boolean(document.querySelector('.pd-session-split-drop.is-hover'))`);
  await review.assert(`document.querySelector('.pd-session-split-drop').textContent.includes('分屏')`, 'The split drop zone says what dropping does');
  await review.screenshot('loaded-05-drag-to-split');
  await review.mouseUp();
  await review.waitFor(`window.__loadedReview.opened.length === 1`);
  await review.assert(`window.__loadedReview.opened[0].endsWith('build-script.jsonl')`, 'Dropping on the chat area opens that conversation in a split pane');
  await review.waitFor(`Boolean(document.querySelector('.pd-loaded-session[data-loaded-kind="pane"]'))`);
  await review.assert(`document.querySelector('.pd-loaded-session[data-loaded-kind="pane"] .pd-loaded-session-badge').textContent === '分屏'`, 'The new pane is listed under loaded sessions');
  await review.assert(`Boolean(document.querySelector('[data-pane-id="7"]'))`, 'The main window lays out a region for the shown pane');

  // The pane's own close only hides it; the list restores or closes it for real.
  await review.evaluate(`window.piDesktop.setSplitPaneHidden(true, 7)`);
  await review.waitFor(`document.querySelector('.pd-loaded-session[data-loaded-kind="pane"]')?.classList.contains('is-hidden-pane') && !document.querySelector('[data-pane-id="7"]')`);
  await review.assert(`document.querySelector('.pd-loaded-session[data-loaded-kind="pane"] .pd-loaded-session-badge').textContent === '已隐藏'`, 'A hidden pane stays listed as hidden');
  await review.screenshot('loaded-06-hidden-pane');
  await review.click('.pd-loaded-session[data-loaded-kind="pane"] .pd-loaded-session-main');
  await review.waitFor(`window.__loadedReview.hidden.at(-1)?.hidden === false && Boolean(document.querySelector('[data-pane-id="7"]'))`);
  await review.assert('true', 'Clicking a hidden pane shows it again');
  const paneRow = await center(`document.querySelector('.pd-loaded-session[data-loaded-kind="pane"]')`);
  await review.mouseMove(paneRow.x, paneRow.y);
  await review.click('.pd-loaded-session[data-loaded-kind="pane"] .pd-loaded-session-close');
  await review.waitFor(`window.__loadedReview.closed.includes(7) && !document.querySelector('.pd-loaded-session[data-loaded-kind="pane"]')`);
  await review.assert('true', 'The list closes a pane for real');

  // Unload from the list.
  const loadedRow = await center(`document.querySelector('.pd-loaded-session[data-loaded-kind="main"]')`);
  await review.mouseMove(loadedRow.x, loadedRow.y);
  await review.click('.pd-loaded-session[data-loaded-kind="main"] .pd-loaded-session-close');
  await review.waitFor(`window.__loadedReview.unloads.length >= 1 && document.querySelectorAll('.pd-loaded-session[data-loaded-kind="main"]').length === 1`);
  await review.assert('true', 'Unloading drops the row and releases the warm copy');
  await review.screenshot('loaded-07-after-close');
}
