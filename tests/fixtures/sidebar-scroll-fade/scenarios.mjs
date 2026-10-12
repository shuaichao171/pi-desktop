// Sidebar conversation list scroll edge fade (zcode WorkspaceSidebar pattern):
// CSS mask on the scroll container fades 32px at the top/bottom edge while
// content continues beyond it; reaching a boundary removes that side's fade.
// node tests/fixtures/model-settings/run.mjs --run --scenario=../sidebar-scroll-fade/scenarios.mjs
function installSidebarScrollFadeFixture() {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const clone = value => structuredClone(value);
  const home = fixture.snapshot.cwd;
  // 8 groups x 5 sessions: every section renders in full (SECTION_PAGE_SIZE = 5),
  // so the list overflows the viewport and can scroll.
  const groups = Array.from({ length: 8 }, (_, group) => ({
    id: `group-${group}`,
    name: `分组 ${String(group + 1).padStart(2, '0')}`,
    sessionPaths: Array.from({ length: 5 }, (_, item) => `${home}\\scroll-fade-${group}-${item}.jsonl`),
  }));
  const rows = groups.flatMap((group, groupIndex) => group.sessionPaths.map((path, item) => ({
    id: `session-${groupIndex}-${item}`,
    path,
    name: `对话 ${groupIndex + 1}-${item + 1}`,
    firstMessage: `对话 ${groupIndex + 1}-${item + 1}`,
    modified: new Date(Date.now() - (groupIndex * 5 + item) * 3600_000).toISOString(),
    messageCount: 3,
  })));
  bridge.getDefaultWorkspace = async () => home;
  bridge.listWorkspaces = async () => [home];
  bridge.listSessions = async () => clone(rows);
  bridge.listSessionGroups = async () => clone(groups);
  bridge.listPinnedWorkspaces = async () => [];
  fixture.emitAgent({ ...clone(fixture.snapshot), type: 'ready' });
}

export default async function sidebarScrollFadeScenarios(review) {
  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-sidebar-mode"))');
  await review.viewport(1440, 1000);
  await review.reducedMotion(true);
  await review.reloadWithFixture(`(${installSidebarScrollFadeFixture.toString()})()`);
  await review.waitFor('document.querySelectorAll(".pd-session-item[data-session-path]").length === 40');
  const list = 'document.querySelector(".pd-organized-list")';
  const mask = `(() => { const style = getComputedStyle(${list}); return style.maskImage !== 'none' && style.maskImage !== '' ? style.maskImage : style.webkitMaskImage; })()`;
  const check = async (value, message) => { if (value !== true) throw new Error(`Scenario check failed: ${message} (got ${JSON.stringify(value)})`); };
  await check(await review.evaluate(`${list}.scrollHeight > ${list}.clientHeight + 1`), 'List overflows and can scroll');
  // Top of the list: only the bottom edge fades out.
  await review.waitFor(`Boolean(${mask})`);
  await check(await review.evaluate(`${mask}.includes('rgba(0, 0, 0, 0) 100%') && !${mask}.includes('rgba(0, 0, 0, 0) 0px')`), 'At the top only the bottom edge fades');
  await review.screenshot('sidebar-scroll-fade-top');
  // Middle: both edges fade.
  await review.evaluate(`${list}.scrollTop = Math.round((${list}.scrollHeight - ${list}.clientHeight) / 2)`);
  await review.waitFor(`${mask}.includes('rgba(0, 0, 0, 0) 0px') && ${mask}.includes('rgba(0, 0, 0, 0) 100%')`);
  await review.screenshot('sidebar-scroll-fade-middle');
  // Bottom: only the top edge fades.
  await review.evaluate(`${list}.scrollTop = ${list}.scrollHeight`);
  await review.waitFor(`${mask}.includes('rgba(0, 0, 0, 0) 0px') && !${mask}.includes('rgba(0, 0, 0, 0) 100%')`);
  await review.screenshot('sidebar-scroll-fade-bottom');
  // Back to the top: the top fade disappears again.
  await review.evaluate(`${list}.scrollTop = 0`);
  await review.waitFor(`!${mask}.includes('rgba(0, 0, 0, 0) 0px') && ${mask}.includes('rgba(0, 0, 0, 0) 100%')`);
  await review.screenshot('sidebar-scroll-fade-back-top');
}
