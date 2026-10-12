// Sidebar bottom-left update pill: accent blue on hover in both themes.
// The old rule hovered to var(--pd-brand-hover), which is light gray in the
// light theme (white label on light gray) and near-black in the dark theme.
// node tests/fixtures/model-settings/run.mjs --run --scenario=../sidebar-update/scenarios.mjs
function installSidebarUpdateFixture() {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const clone = value => structuredClone(value);
  const state = { update: { phase: 'available', currentVersion: '0.1.25-review', availableVersion: '0.1.26', installRequested: false } };
  bridge.getUpdateState = async () => clone(state.update);
}

export default async function sidebarUpdateScenarios(review) {
  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-sidebar-mode"))');
  await review.viewport(1440, 1000);
  await review.reducedMotion(true);
  await review.reloadWithFixture(`(${installSidebarUpdateFixture.toString()})()`);
  const check = async (value, message) => { if (value !== true) throw new Error(`Scenario check failed: ${message} (got ${JSON.stringify(value)})`); };
  const button = 'document.querySelector("button.pd-sidebar-update")';
  // Canvas fillStyle normalizes rgb()/color(srgb) serializations to #rrggbb.
  const rgbOf = `(() => { const style = getComputedStyle(${button}); const context = document.createElement('canvas').getContext('2d'); context.fillStyle = style.backgroundColor; const match = context.fillStyle.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/); if (!match) return null; return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)]; })()`;
  const isBlue = `(() => { const rgb = ${rgbOf}; return rgb !== null && rgb[2] > rgb[0] + 100 && rgb[2] > 150 && rgb[1] > rgb[0]; })()`;
  await review.waitFor(`Boolean(${button})`);
  await check(await review.evaluate(isBlue), 'Update pill base color is accent blue');
  const base = await review.evaluate(rgbOf);
  await review.screenshot('sidebar-update-base');
  // Hover keeps the blue family instead of jumping to the theme brand gray.
  const box = await review.evaluate(`(() => { const rect = ${button}.getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }; })()`);
  await review.mouseMove(box.x, box.y);
  await review.waitFor(`Date.now() > ${Date.now() + 400}`);
  await check(await review.evaluate(isBlue), 'Hovered update pill stays in the blue family');
  const hovered = await review.evaluate(rgbOf);
  await check(await review.evaluate(`JSON.stringify(${rgbOf}) !== JSON.stringify(${JSON.stringify(base)})`), 'Hover visibly changes the pill color');
  console.log(`update pill base rgb(${base}) -> hover rgb(${hovered})`);
  await review.screenshot('sidebar-update-hover');
  await review.mouseMove(900, 500);
  // Moving away restores the base color.
  await review.waitFor(`Date.now() > ${Date.now() + 400}`);
  await check(await review.evaluate(`JSON.stringify(${rgbOf}) === JSON.stringify(${JSON.stringify(base)})`), 'Leaving the pill restores the base color');
}
