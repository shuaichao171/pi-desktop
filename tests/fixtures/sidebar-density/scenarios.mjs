// Sidebar vertical density: "show more" rows match conversation rows, and the
// bottom "unassigned sessions" region keeps visible rows in short windows.
// node tests/fixtures/model-settings/run.mjs --run --theme=dark --scenario=../sidebar-density/scenarios.mjs
// node tests/fixtures/model-settings/run.mjs --run --theme=light --scenario=../sidebar-density/scenarios.mjs
function installSidebarDensityFixture(layout) {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const clone = value => structuredClone(value);
  const home = fixture.snapshot.cwd;
  const projects = { Alpha: 12, Bravo: 8, Charlie: 3, Delta: 6 };
  const paths = Object.fromEntries(Object.keys(projects).map(name => [name, 'C:\\sidebar-density\\' + name]));
  const day = index => new Date(Date.UTC(2026, 10, 20, 12, 0, 0) - index * 3600_000).toISOString();
  const rows = {};
  for (const [name, count] of Object.entries(projects)) rows[paths[name]] = Array.from({ length: count }, (_, index) => ({ id: `${name}-${index}`, path: `${paths[name]}\\${name}-${index}.jsonl`, name: `${name} 对话 ${index + 1}`, firstMessage: `${name} prompt ${index + 1}`, modified: day(index), messageCount: 2 }));
  rows[home] = Array.from({ length: 12 }, (_, index) => ({ id: `loose-${index}`, path: `${home}\\loose-${index}.jsonl`, name: `无归属对话 ${index + 1}`, firstMessage: `loose ${index + 1}`, modified: day(index), messageCount: 2 }));
  const workspaces = Object.values(paths);
  // Saved section heights and project groups are per-profile; each case starts from its own copy.
  if (layout) {
    localStorage.setItem('pi-desktop.sidebar-sections.v1', JSON.stringify({ collapsed: [], heights: layout.heights, hidden: [] }));
    localStorage.setItem('pi-desktop.project-groups.v1', JSON.stringify([{ id: 'density-work', name: '工作', projects: layout.groupProjects.map(name => paths[name]) }]));
  } else {
    localStorage.removeItem('pi-desktop.sidebar-sections.v1');
    localStorage.removeItem('pi-desktop.project-groups.v1');
  }
  bridge.getDefaultWorkspace = async () => home;
  bridge.listConversationWorkspaces = async () => [home];
  bridge.listWorkspaces = async () => clone(workspaces);
  bridge.listSessions = async cwd => clone(rows[cwd] ?? []);
  bridge.listSessionsPage = async (cwd, offset, limit) => {
    const entries = rows[cwd] ?? [];
    return { sessions: clone(entries.slice(offset, offset + limit)), total: entries.length, hasMore: offset + limit < entries.length, revision: 1 };
  };
  bridge.listSessionGroups = async () => [];
  bridge.listPinnedWorkspaces = async () => [];
  Object.assign(fixture.snapshot, { cwd: paths.Alpha, sessionId: 'Alpha-0', sessionPath: rows[paths.Alpha][0].path, status: 'idle', messages: [], activities: [], runs: [], historyTotal: 0, error: null });
  fixture.emitAgent({ ...clone(fixture.snapshot), type: 'ready' });
  fixture.emitAgent({ type: 'status', status: 'idle' });
}

const measure = `(() => {
  const box = node => node ? node.getBoundingClientRect() : null;
  const regions = Array.from(document.querySelectorAll('.pd-sidebar-regions > .pd-sidebar-region')).map(region => {
    const content = region.querySelector(':scope > .pd-sidebar-region-content');
    const rect = box(region), inner = box(content);
    const visibleRows = content ? Array.from(content.querySelectorAll('.pd-session-item[data-session-path]')).filter(row => { const r = row.getBoundingClientRect(); return r.top >= inner.top - 0.5 && r.bottom <= inner.bottom + 0.5; }).length : 0;
    return { id: region.dataset.regionId ?? 'loaded', height: Math.round(rect.height), contentHeight: inner ? Math.round(inner.height) : 0, visibleRows };
  });
  const row = box(document.querySelector('.pd-sidebar-region-content .pd-session-item[data-session-path]'));
  const more = document.querySelector('.pd-session-more');
  const moreStyle = more ? getComputedStyle(more) : null;
  const containerNode = document.querySelector('.pd-sidebar-regions');
  const container = box(containerNode);
  const looseContent = document.querySelector('[data-region-id="unassigned-sessions"] > .pd-sidebar-region-content');
  const looseMore = looseContent?.querySelector(':scope > .pd-session-more');
  const looseMoreVisible = Boolean(looseMore && (() => { const outer = box(looseContent), inner = box(looseMore); return inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5 && document.elementFromPoint(inner.left + inner.width / 2, inner.top + inner.height / 2)?.closest('.pd-session-more') === looseMore; })());
  return JSON.stringify({
    rowHeight: row ? Math.round(row.height) : null,
    moreHeight: more ? Math.round(box(more).height) : null,
    moreOuter: more ? Math.round(box(more).height + parseFloat(moreStyle.marginTop) + parseFloat(moreStyle.marginBottom)) : null,
    moreCount: document.querySelectorAll('.pd-session-more').length,
    regionsHeight: container ? Math.round(container.height) : null,
    regionsOverflow: containerNode ? containerNode.scrollHeight - containerNode.clientHeight : null,
    looseMoreVisible,
    regions,
  });
})()`;

// The second case reproduces a real profile: heights saved in a larger window
// (groups 646 / ungrouped 148 / unassigned 114) shown in a 1089x724 window.
const SAVED_LAYOUT = { heights: { 'project-groups': 646.4, 'ungrouped-projects': 148, 'unassigned-sessions': 113.6 }, groupProjects: ['Alpha', 'Bravo'] };
const CASES = [
  { name: '1440x900', width: 1440, height: 900, layout: null, roomy: true },
  { name: '1089x724-saved', width: 1089, height: 724, layout: SAVED_LAYOUT },
  { name: '1440x640', width: 1440, height: 640, layout: null, roomy: true },
  { name: '900x560', width: 900, height: 560, layout: null },
  // MAIN_WINDOW_MIN_HEIGHT is 520; below 880px wide the sidebar becomes a drawer.
  { name: '900x520-saved', width: 900, height: 520, layout: SAVED_LAYOUT },
];

export default async function sidebarDensityScenarios(review) {
  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-activity-bar"))');
  await review.reducedMotion(true);
  const theme = await review.evaluate('document.documentElement.dataset.theme === "light" ? "light" : "dark"');
  for (const { name, width, height, layout, roomy } of CASES) {
    await review.viewport(width, height);
    await review.reloadWithFixture(`(${installSidebarDensityFixture.toString()})(${JSON.stringify(layout)});`);
    await review.waitFor(`document.querySelectorAll('.pd-session-item[data-session-path*="loose-"]').length > 0 && document.querySelectorAll('.pd-session-more').length >= 3`);
    await review.record(`density-${theme}-${name}`, measure);
    const metrics = `JSON.parse(${measure})`;
    await review.assert(`(() => { const m = ${metrics}; return m.rowHeight === 22 && m.moreOuter === m.rowHeight; })()`, `${name}: "show more" takes exactly one 22px conversation row`);
    await review.assert(`(() => { const loose = ${metrics}.regions.find(region => region.id === 'unassigned-sessions'); return loose.height >= 96 && loose.visibleRows >= 2; })()`, `${name}: the bottom unassigned region keeps its heading and at least two rows`);
    await review.assert(`${metrics}.looseMoreVisible`, `${name}: the unassigned "show more" row is visible and clickable without scrolling`);
    // Nothing scrolls into view underneath the pinned "show more" row.
    await review.assert(`(() => { const content = document.querySelector('[data-region-id="unassigned-sessions"] > .pd-sidebar-region-content'), more = content.querySelector(':scope > .pd-session-more'), outer = content.getBoundingClientRect(), inner = more.getBoundingClientRect(); return outer.bottom - inner.bottom < 1; })()`, `${name}: the pinned "show more" row sits flush with the region bottom`);
    if (roomy) await review.assert(`(() => { const content = document.querySelector('[data-region-id="unassigned-sessions"] > .pd-sidebar-region-content'); return content.scrollHeight <= content.clientHeight + 1 && content.querySelector(':scope > .pd-session-more').getBoundingClientRect().bottom >= content.getBoundingClientRect().bottom - 1; })()`, `${name}: a roomy unassigned region shrinks to its rows instead of leaving blank space`);
    // The fade above the pinned row appears only while rows scroll beneath it.
    await review.assert(`(() => { const content = document.querySelector('[data-region-id="unassigned-sessions"] > .pd-sidebar-region-content'), more = content.querySelector(':scope > .pd-session-more'); const overflowing = content.scrollHeight > content.clientHeight + 1; return getComputedStyle(more.querySelector(':scope > span'), '::after').opacity === (overflowing ? '1' : '0'); })()`, `${name}: the fade above "show more" tracks whether rows scroll beneath it`);
    await review.screenshot(`density-${theme}-${name}`);
  }
  // Extra chrome (a filter chip, a long loaded list) can still leave less than the
  // minimums; then the region column scrolls rather than clipping the bottom region.
  await review.viewport(900, 400);
  await review.reloadWithFixture(`(${installSidebarDensityFixture.toString()})(${JSON.stringify(SAVED_LAYOUT)});`);
  await review.waitFor(`document.querySelectorAll('.pd-session-item[data-session-path*="loose-"]').length > 0`);
  await review.assert(`(() => { const column = document.querySelector('.pd-sidebar-regions'); return column.scrollHeight > column.clientHeight && getComputedStyle(column).overflowY === 'auto'; })()`, 'When minimum region heights exceed the window, the region column scrolls');
  await review.evaluate(`(() => { const column = document.querySelector('.pd-sidebar-regions'); column.scrollTop = column.scrollHeight; return column.scrollTop; })()`);
  await review.assert(`(() => { const column = document.querySelector('.pd-sidebar-regions').getBoundingClientRect(), loose = document.querySelector('[data-region-id="unassigned-sessions"]').getBoundingClientRect(); return loose.bottom <= column.bottom + 1; })()`, 'Scrolling the column reaches the bottom of the unassigned region');
  await review.screenshot(`density-${theme}-short-scrolled`);
}
