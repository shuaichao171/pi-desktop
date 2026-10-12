// Sidebar conversation row hover/selected highlight contrast (zcode task-item:
// hover = surface-hover, active = selected, selected stronger than hover).
// node tests/fixtures/model-settings/run.mjs --run --scenario=../sidebar-highlight/scenarios.mjs
function installSidebarHighlightFixture() {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const clone = value => structuredClone(value);
  const home = fixture.snapshot.cwd;
  const rows = Array.from({ length: 6 }, (_, index) => ({
    id: `session-${index}`,
    path: `${home}\\highlight-${index}.jsonl`,
    name: `对话 ${index + 1}`,
    firstMessage: `对话 ${index + 1}`,
    modified: new Date(Date.now() - index * 3600_000).toISOString(),
    messageCount: 2,
  }));
  bridge.getDefaultWorkspace = async () => home;
  bridge.listWorkspaces = async () => [home];
  bridge.listSessions = async () => clone(rows);
  bridge.listSessionGroups = async () => [];
  bridge.listPinnedWorkspaces = async () => [];
  Object.assign(fixture.snapshot, { sessionId: rows[0].id, sessionPath: rows[0].path });
  fixture.emitAgent({ ...clone(fixture.snapshot), type: 'ready' });
}

export default async function sidebarHighlightScenarios(review) {
  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-sidebar-mode"))');
  await review.viewport(1440, 1000);
  await review.reducedMotion(true);
  await review.reloadWithFixture(`(${installSidebarHighlightFixture.toString()})()`);
  await review.waitFor('document.querySelectorAll(".pd-session-item[data-session-path]").length >= 5');
  const idle = '.pd-session-item[data-session-path$="highlight-2.jsonl"]';
  const active = '.pd-session-item[data-session-path$="highlight-0.jsonl"]';
  const rgb = selector => `(() => { const canvas = document.createElement('canvas').getContext('2d'); canvas.fillStyle = getComputedStyle(document.querySelector(${JSON.stringify(selector)})).backgroundColor; const match = canvas.fillStyle.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/); return match ? [parseInt(match[1],16), parseInt(match[2],16), parseInt(match[3],16)] : null; })()`;
    const lum = rgb => Math.round((rgb[0] + rgb[1] + rgb[2]) / 3);
  const check = async (value, message) => { if (value !== true) throw new Error(`Scenario check failed: ${message} (got ${JSON.stringify(value)})`); };
  const measure = async theme => {
    await review.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
    await review.waitFor('Date.now() > ' + (Date.now() + 150));
    const base = lum(await review.evaluate(rgb('.pd-sidebar')));
    const activeBg = lum(await review.evaluate(rgb(active)));
    const point = await review.evaluate(`(() => { const rect = document.querySelector(${JSON.stringify(idle)}).getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }; })()`);
    await review.mouseMove(point.x, point.y);
    await review.waitFor('Date.now() > ' + (Date.now() + 250));
    const hovered = lum(await review.evaluate(rgb(idle)));
    await review.mouseMove(900, 500);
    await review.waitFor('Date.now() > ' + (Date.now() + 250));
    return { base, hovered, activeBg };
  };
  for (const theme of ['dark', 'light']) {
    const { base, hovered, activeBg } = await measure(theme);
    console.log(`${theme}: idle=${base} hover=${hovered} active=${activeBg}`);
    const hoverFloor = theme === 'dark' ? 15 : 10; // zcode light hover is ~Δ8; keep at least that strength.
    await check(Math.abs(hovered - base) >= hoverFloor, `${theme} hover highlight is clearly visible (Δ>=${hoverFloor})`);
    await check(Math.abs(activeBg - base) >= Math.max(15, hoverFloor) && Math.abs(activeBg - hovered) >= 4, `${theme} selected highlight is stronger than hover`);
    await review.screenshot(`sidebar-highlight-${theme}`);
  }
}
