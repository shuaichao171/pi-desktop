// zcode-style sidebar rows: left leading slot (spinner/dots/pin), archive right.
// node tests/fixtures/model-settings/run.mjs --run --scenario=../sidebar-runtime/scenarios.mjs
function installSidebarRuntimeFixture() {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const clone = value => structuredClone(value);
  const home = fixture.snapshot.cwd;
  const paths = { home, Alpha: 'C:\\sidebar-runtime\\Alpha' };
  const row = (id, workspace, name, extra = {}) => ({ id, path: paths[workspace] + '\\' + id + '.jsonl', name, firstMessage: name, modified: '2026-10-03T00:00:00Z', messageCount: 2, ...extra });
  const rows = {
    [home]: [
      row('idle-done', 'home', '已完成的对话'),
      row('running', 'home', '正在运行的对话', { runtime: { phase: 'running' } }),
      row('waiting', 'home', '等待输入的对话', { runtime: { phase: 'waiting-input', message: '需要补充信息' } }),
      row('failed', 'home', '失败的对话', { runtime: { phase: 'failed', message: '网络错误' } }),
      row('unread', 'home', '未读的对话', { unread: true }),
      row('pinned', 'home', '置顶的对话', { pinned: true }),
    ],
    [paths.Alpha]: [
      row('alpha-run', 'Alpha', 'Alpha 运行中的对话', { runtime: { phase: 'running' } }),
      row('alpha-fail', 'Alpha', 'Alpha 失败的对话', { runtime: { phase: 'failed', message: '网络错误' } }),
    ],
  };
  const state = window.__sidebarRuntimeReview = { paths, rows, workspaces: [home, paths.Alpha] };
  bridge.getDefaultWorkspace = async () => home;
  bridge.listWorkspaces = async () => clone(state.workspaces);
  bridge.listSessions = async cwd => clone(rows[cwd] ?? []);
  bridge.listSessionGroups = async () => [];
  bridge.listPinnedWorkspaces = async () => [];
  const runningRun = { id: 'run-1', startedAt: Date.now() - 45000, finishedAt: null, status: 'running' };
  Object.assign(fixture.snapshot, {
    cwd: home, sessionId: 'running', sessionPath: rows[home][1].path, status: 'busy',
    messages: [
      { id: 'u1', order: 1, runId: 'run-1', role: 'user', status: 'done', text: '帮我检查这个项目的测试', attachments: [] },
      { id: 'a1', order: 2, runId: 'run-1', role: 'assistant', status: 'streaming', text: '我先看一下测试文件。', thinking: '', thinkingTruncated: false },
    ],
    activities: [{ id: 't1', order: 3, runId: 'run-1', tool: 'read', title: '读取 tests/app.test.ts', status: 'running', state: {} }],
    runs: [runningRun], historyTotal: 3, error: null,
  });
  fixture.emitAgent({ ...clone(fixture.snapshot), type: 'ready' });
}

export default async function sidebarRuntimeScenarios(review) {
  const q = JSON.stringify;
  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-sidebar-mode"))');
  await review.viewport(1440, 1000);
  await review.reducedMotion(true);
  await review.reloadWithFixture(`(${installSidebarRuntimeFixture.toString()})()`);
  await review.waitFor(`document.querySelectorAll('.pd-session-item[data-session-path]').length === 8`);
  const rowOf = title => `[...document.querySelectorAll('.pd-session-item')].find(item => item.querySelector('.pd-session-title-text')?.textContent === ${q(title)})`;
  const rowProp = async (title, expression) => review.evaluate(`(() => { const item = ${rowOf(title)}; return item ? ${expression} : 'MISSING'; })()`);
  const check = async (value, message) => { if (value !== true) throw new Error(`Scenario check failed: ${message} (got ${JSON.stringify(value)})`); };
  // Left leading slot: status vocabulary replaces the old text labels.
  await check(await rowProp('正在运行的对话', `Boolean(item.querySelector('.pd-session-leading svg.pd-session-spinner')) && !item.querySelector('.pd-session-runtime')`), 'Running rows show the zcode spinner and no text label');
  await check(await rowProp('等待输入的对话', `item.querySelector('.pd-session-indicator.is-waiting') instanceof HTMLElement`), 'Waiting rows show the yellow waiting dot');
  await check(await rowProp('失败的对话', `item.querySelector('.pd-session-indicator.is-failed') instanceof HTMLElement`), 'Failed rows show the red dot');
  await check(await rowProp('未读的对话', `item.querySelector('.pd-session-indicator.is-unread') instanceof HTMLElement`), 'Unread rows show the sky dot');
  await check(await rowProp('已完成的对话', `item.querySelector('.pd-session-leading') && !item.querySelector('.pd-session-indicator') && !item.querySelector('svg.pd-session-spinner')`), 'Idle rows keep the leading slot empty');
  // Pin action lives on the left; the right side keeps archive only.
  await check(await rowProp('已完成的对话', `Boolean(item.querySelector('.pd-session-pin[data-session-action="pin"]')) && ![...item.querySelectorAll('.pd-session-actions [data-session-action]')].some(button => button.dataset.sessionAction === 'pin') && [...item.querySelectorAll('.pd-session-actions [data-session-action]')].every(button => button.dataset.sessionAction === 'archive')`), 'Pin moved to the left slot; only archive remains on the right');
  await check(await rowProp('置顶的对话', `getComputedStyle(item.querySelector('.pd-session-pin')).opacity === '1' && getComputedStyle(item.querySelector('.pd-session-pin')).pointerEvents === 'auto'`), 'A pinned row without live state keeps its pin visible');
  await check(await rowProp('置顶的对话', `getComputedStyle(item.querySelector('.pd-session-leading')).visibility !== 'hidden'`), 'Pinned rows without indicators do not hide the leading slot');
  await review.screenshot('sidebar-runtime-leading');
  // Hover swaps the indicator for the pin action (zcode behavior).
  const idleRow = await review.evaluate(`(() => { const item = ${rowOf('已完成的对话')}; const box = item.getBoundingClientRect(); return { x: Math.round(box.x + 12), y: Math.round(box.y + box.height / 2) }; })()`);
  await review.mouseMove(idleRow.x, idleRow.y);
  await check(await rowProp('已完成的对话', `getComputedStyle(item.querySelector('.pd-session-pin')).opacity === '1'`), 'Hovering a row reveals the left pin action');
  await review.screenshot('sidebar-runtime-hover-pin');
  await review.mouseMove(900, 500);
  // Hovering a conversation row must not open the right-side hover tooltip anymore.
  const rowCenter = await review.evaluate(`(() => { const item = ${rowOf('已完成的对话')}; const box = item.getBoundingClientRect(); return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }; })()`);
  await review.mouseMove(rowCenter.x, rowCenter.y);
  await review.waitFor(`Date.now() > ${Date.now() + 450}`);
  await check(await review.evaluate(`document.querySelector('.pd-hover-tooltip') === null`), 'Hovering a conversation row no longer opens the right-side tooltip');
  await review.screenshot('sidebar-runtime-row-hover-no-tooltip');
  await review.mouseMove(900, 500);
  // Project view keeps the same row vocabulary.
  await review.click('[data-mode="project"]');
  await review.waitFor(`document.querySelectorAll('.pd-sidebar-group[data-project-path]').length > 0`);
  await check(await rowProp('Alpha 运行中的对话', `Boolean(item.closest('.pd-sidebar-group[data-project-path]')?.querySelector('.pd-session-spinner'))`), 'Project view shows the running spinner too');
  // Aggregate vocabulary on the project heading: colored dots, no glyph text.
  await check(await review.evaluate(`(() => { const counts = document.querySelector('.pd-sidebar-group[data-project-path] .pd-session-state-counts'); if (!counts) return false; const dots = [...counts.querySelectorAll('b')]; return dots.length === 2 && dots.every(dot => dot.textContent === '' && getComputedStyle(dot).borderRadius !== '0px'); })()`), 'Project headings summarize state with colored dots');
  await review.screenshot('sidebar-runtime-project');
}
