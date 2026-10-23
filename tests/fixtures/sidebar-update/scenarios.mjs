// Sidebar bottom-left update pill. It once hovered to var(--pd-brand-hover) under a
// fixed white label, which is unreadable when a palette's hover tone is light gray.
// The pill now uses the theme accent with --pd-send-ink, which is picked for
// contrast against the accent, so the check is readability rather than a hue.
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
  // WCAG contrast between the label and the pill background.
  const readable = `(() => { const context = document.createElement('canvas').getContext('2d'); const parse = value => { context.fillStyle = '#000'; context.fillStyle = value; const m = context.fillStyle.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i); return m ? m.slice(1).map(h => parseInt(h, 16) / 255) : null; }; const style = getComputedStyle(${button}); const bg = parse(style.backgroundColor), fg = parse(style.color); if (!bg || !fg) return false; const lum = c => { const [r, g, b] = c.map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }; const [hi, lo] = [lum(bg), lum(fg)].sort((a, b) => b - a); return (hi + 0.05) / (lo + 0.05) >= 4.5; })()`;
  await review.waitFor(`Boolean(${button})`);
  await check(await review.evaluate(readable), 'Update pill label is readable on its accent background');
  const base = await review.evaluate(rgbOf);
  await review.screenshot('sidebar-update-base');
  // Hover changes the tone but keeps the label readable.
  const box = await review.evaluate(`(() => { const rect = ${button}.getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }; })()`);
  await review.mouseMove(box.x, box.y);
  await review.waitFor(`Date.now() > ${Date.now() + 400}`);
  await check(await review.evaluate(readable), 'Hovered update pill keeps a readable label');
  const hovered = await review.evaluate(rgbOf);
  await check(await review.evaluate(`JSON.stringify(${rgbOf}) !== JSON.stringify(${JSON.stringify(base)})`), 'Hover visibly changes the pill color');
  console.log(`update pill base rgb(${base}) -> hover rgb(${hovered})`);
  await review.screenshot('sidebar-update-hover');
  await review.mouseMove(900, 500);
  // Moving away restores the base color.
  await review.waitFor(`Date.now() > ${Date.now() + 400}`);
  await check(await review.evaluate(`JSON.stringify(${rgbOf}) === JSON.stringify(${JSON.stringify(base)})`), 'Leaving the pill restores the base color');
}
