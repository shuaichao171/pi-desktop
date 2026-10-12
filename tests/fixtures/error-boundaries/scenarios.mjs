// Render failures stay inside the failing surface instead of blanking the window.
// Each surface gets a malformed bridge response that breaks it while rendering.
// node tests/fixtures/model-settings/run.mjs --run --scenario=../error-boundaries/scenarios.mjs
const alive = 'Boolean(document.querySelector(".pd-sidebar-mode")) && Boolean(document.querySelector(".pd-new-session"))';

export default async function errorBoundaryScenarios(review) {
  await review.waitFor(`window.__modelReview?.ready === true && ${alive}`);
  await review.viewport(1440, 1000);
  await review.reducedMotion(true);
  // React logs every error a boundary catches; collect them here and check they are only the forced ones.
  await review.evaluate("window.__boundaryErrors = []; console.error = (...args) => { window.__boundaryErrors.push(args.map(value => value instanceof Error ? value.message : String(value)).join(' ')); }");

  await review.evaluate("Object.assign(window.piDesktop, { getPluginCatalog: async () => ({}), newSession: async () => undefined })");
  await review.click('.pd-sidebar-plugins');
  await review.waitFor('Boolean(document.querySelector(".pd-main-view > .pd-scoped-error"))');
  await review.assert(alive, 'A plugins page failure keeps the sidebar and window usable');
  await review.screenshot('error-boundary-plugins');
  await review.click('.pd-new-session');
  await review.waitFor('!document.querySelector(".pd-main-view > .pd-scoped-error") && Boolean(document.querySelector(".pd-composer-shell"))');

  // A malformed search response breaks the dialog while it renders.
  await review.evaluate("Object.assign(window.piDesktop, { searchSessionsPage: async () => ({}), cancelDataSearch: async () => undefined })");
  await review.key('k', { ctrl: true });
  await review.waitFor('Boolean(document.querySelector(".pd-overlay-error-host > .pd-scoped-error"))');
  await review.assert(alive, 'A search failure is shown as an overlay without blanking the window');
  await review.screenshot('error-boundary-search');
  await review.clickText('.pd-overlay-error-host .pd-scoped-error > button', '重试此区域');
  await review.waitFor(`!document.querySelector(".pd-overlay-error-host") && ${alive}`);

  await review.evaluate("window.piDesktop.getPersonalization = async () => [{ id: 'user', path: { malformed: true }, exists: true, content: '', revision: null }]");
  await review.click('.pd-settings-entry');
  await review.clickText('.pd-settings-nav button', '个性化');
  await review.waitFor('Boolean(document.querySelector(".pd-settings-content .pd-scoped-error"))');
  await review.assert('Boolean(document.querySelector(".pd-settings-nav")) && Boolean(document.querySelector(".pd-settings-header > button"))', 'A settings page failure keeps the settings navigation and close button');
  await review.screenshot('error-boundary-settings');
  await review.clickText('.pd-settings-nav button', '常规');
  await review.waitFor('!document.querySelector(".pd-settings-content .pd-scoped-error") && document.querySelectorAll(".pd-settings-content .pd-settings-group").length === 4');
  await review.assert("(() => { const logged = window.__boundaryErrors.join(' | '); return logged.includes(\"reading 'find'\") && logged.includes(\"reading 'map'\") && /#31|Objects are not valid/.test(logged) && !/Unexpected bridge call/.test(logged); })()", 'Only the three forced render failures were reported');
}
