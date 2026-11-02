// Measure the vertical gap between the sidebar nav buttons (plugins row) and
// the conversation list below them.
// node tests/fixtures/model-settings/run.mjs --run --scenario=../sidebar-gap/scenarios.mjs
function installSidebarGapFixture() {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const clone = value => structuredClone(value);
  const home = fixture.snapshot.cwd;
  const row = (id, name, extra = {}) => ({ id, path: home + '\\' + id + '.jsonl', name, firstMessage: name, modified: '2026-10-03T00:00:00Z', messageCount: 2, ...extra });
  const rows = [row('one', '第一个对话'), row('two', '第二个对话')];
  bridge.getDefaultWorkspace = async () => home;
  bridge.listWorkspaces = async () => [home];
  bridge.listSessions = async () => clone(rows);
  bridge.listSessionGroups = async () => [];
  bridge.listPinnedWorkspaces = async () => [];
  Object.assign(fixture.snapshot, { cwd: home, sessionId: 'one', sessionPath: rows[0].path, status: 'idle', messages: [], activities: [], runs: [], historyTotal: 0, error: null });
  fixture.emitAgent({ ...clone(fixture.snapshot), type: 'ready' });
}

export default async function sidebarGapScenarios(review) {
  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-activity-bar"))');
  await review.viewport(1440, 1000);
  await review.reducedMotion(true);
  await review.reloadWithFixture(`(${installSidebarGapFixture.toString()})()`);
  await review.waitFor(`document.querySelectorAll('.pd-session-item[data-session-path]').length === 2`);
  const gap = await review.evaluate(`(() => {
    const plugins = document.querySelector('.pd-activity-plugins');
    const toolbar = document.querySelector('.pd-sidebar-organize-toolbar');
    const list = document.querySelector('.pd-project-section');
    if (!plugins || !toolbar || !list) return JSON.stringify({ missing: true });
    const navBottom = plugins.getBoundingClientRect().bottom;
    const listTop = list.getBoundingClientRect().top;
    const toolbarTop = toolbar.getBoundingClientRect().top;
    return JSON.stringify({
      navToListGap: Math.round(listTop - navBottom),
      navToToolbarGap: Math.round(toolbarTop - navBottom),
      hasSeparator: getComputedStyle(list).borderTopWidth !== '0px',
    });
  })()`);
  await review.record('sidebar-gap', JSON.stringify(gap));
  await review.screenshot('sidebar-gap');
}
