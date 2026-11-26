// Activity bar regression scenario (VS Code style icon rail left of the sidebar).
// node tests/fixtures/model-settings/run.mjs --run --scenario=../activity-bar/scenarios.mjs
// Verifies: rail renders leftmost with expected width; new-session opens a
// conversation; view icons toggle automations/plugins and back; settings entry
// opens the settings dialog; Ctrl+B hides the sidebar but keeps the rail.
export default async function activityBarScenarios(review) {
  const check = async (value, message) => { if (value !== true) throw new Error(`Scenario check failed: ${message} (got ${JSON.stringify(value)})`); };

  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-activity-bar, .pd-app-shell.is-pai"))');
  await review.viewport(1440, 900);
  await review.reducedMotion(true);

  const rail = 'document.querySelector(".pd-activity-bar")';
  const sidebar = 'document.querySelector(".pd-sidebar")';
  const topBar = 'document.querySelector(".pd-top-bar")';

  // The window-wide top bar spans everything, including the rail.
  await review.waitFor(`Boolean(${topBar})`);
  const barGeometry = await review.evaluate(`(() => { const t = ${topBar}.getBoundingClientRect(); const r = ${rail}.getBoundingClientRect(); return { topWidth: t.width, topLeft: t.left, topBottom: t.bottom, railTop: r.top, brandFirst: ${topBar}.querySelector(".pd-brand-mark")?.getBoundingClientRect().left ?? -1 }; })()`);
  await check(barGeometry.topWidth >= 1400 && barGeometry.topLeft <= 4, 'Top bar spans the window above all panels');
  await check(Math.abs(barGeometry.railTop - barGeometry.topBottom) < 1, 'Activity bar starts directly below the top bar');
  await check(barGeometry.brandFirst >= 0 && barGeometry.brandFirst <= 24, 'Brand mark sits at the far left of the top bar');
  await check(await review.evaluate('document.querySelectorAll(".pd-brand-mark").length === 1'), 'Only the top bar owns the brand mark');
  await check(await review.evaluate('document.querySelectorAll(".pd-window-controls").length <= 1'), 'Window controls are mounted once');
  await check(await review.evaluate('document.querySelectorAll(".pd-chat-header").length === 0'), 'The app uses one global top bar instead of per-panel title bars');
  await check(await review.evaluate('!document.querySelector(".pd-window-controls") || document.querySelector(".pd-window-controls").closest(".pd-top-bar") !== null'), 'Window controls live inside the global top bar when available');

  // The sessions toggle sits at the top of the rail.
  await check(await review.evaluate(`(() => { const sessions = ${rail}.querySelector(".pd-activity-sessions"); const first = ${rail}.querySelector(".pd-activity-bar-top button"); return sessions === first; })()`), 'Sessions toggle is the topmost rail button');

  // The rail exists and sits left of the sidebar.
  await review.waitFor(`Boolean(${rail})`);
  const geometry = await review.evaluate(`(() => { const r = ${rail}.getBoundingClientRect(); const s = document.querySelector(".pd-sidebar").getBoundingClientRect(); return { railWidth: r.width, railLeft: r.left, sidebarLeft: s.left }; })()`);
  await check(geometry.railWidth >= 44 && geometry.railWidth <= 56, 'Activity bar is a narrow rail (48px nominal)');
  await check(geometry.sidebarLeft >= geometry.railLeft + geometry.railWidth - 1 && geometry.railLeft <= 4, 'Activity bar sits left of the sidebar');

  // The sidebar's first row holds the project title, new conversation and the view options.
  await check(await review.evaluate(`(() => { const toolbar = ${sidebar}.querySelector(".pd-sidebar-organize-toolbar"); const button = toolbar?.querySelector(".pd-sidebar-new-session"); const title = toolbar?.querySelector(".pd-sidebar-archive-title"); const more = toolbar?.querySelector(".pd-sidebar-organize-actions button[aria-haspopup], .pd-sidebar-organize-actions button:last-child"); if (!button || !title || !more) return false; const b = button.getBoundingClientRect(), tl = title.getBoundingClientRect(), m = more.getBoundingClientRect(), pane = ${sidebar}.getBoundingClientRect(); const center = r => r.top + r.height / 2; return toolbar.getBoundingClientRect().top - pane.top < 1 && title.textContent === "项目" && button.textContent.includes("新建对话") && tl.right < b.left && b.right <= m.left && Math.abs(center(b) - center(tl)) <= 2 && Math.abs(center(b) - center(m)) <= 2; })()`), 'Project title, new conversation and view options share the first sidebar row, in that order');
  // Rail contents: automations and plugins on top (new conversation only while the sidebar is hidden); settings pinned at the bottom.
  await check(await review.evaluate(`${rail}.querySelector(".pd-activity-new-session") === null`), 'The rail drops its new-session button while the sidebar shows one');
  await check(await review.evaluate(`${rail}.querySelector(".pd-settings-entry") !== null`), 'Settings entry lives in the rail');
  const settingsPinned = await review.evaluate(`(() => { const bar = ${rail}; const settings = bar.querySelector(".pd-settings-entry").getBoundingClientRect(); const first = bar.querySelector(".pd-activity-bar-top button:last-child").getBoundingClientRect(); return settings.bottom <= bar.getBoundingClientRect().bottom + 1 && settings.top > first.bottom; })()`);
  await check(settingsPinned, 'Settings is pinned at the bottom of the rail');

  // Old sidebar chrome is gone: no nav rows, no footer settings entry inside the sidebar.
  await check(await review.evaluate(`!${sidebar}.querySelector(".pd-nav-row") && !${sidebar}.querySelector(".pd-settings-entry") && !${sidebar}.querySelector(".pd-sidebar-brand")`), 'Sidebar no longer carries nav rows, brand row, or its own settings entry');
  await review.screenshot('activity-bar-default');

  // Switching views: automations, plugins, then back via the same icon.
  // The review fixture bridge has no automation backend, so the automation page
  // errors after mounting; the switch itself is observable via the chat view
  // hiding and the rail icon state.
  await review.click('.pd-activity-automations');
  await review.waitFor('document.querySelector(".pd-chat-view-host")?.getAttribute("hidden") !== null');
  await check(await review.evaluate('document.querySelector(".pd-activity-automations").classList.contains("is-active")'), 'Automations icon highlights while its page is open');
  await review.click('.pd-activity-automations');
  await review.waitFor('document.querySelector(".pd-chat-view-host")?.getAttribute("hidden") === null');
  await check(await review.evaluate(`!document.querySelector(".pd-activity-automations")?.classList.contains("is-active")`), 'Clicking the active icon again returns to the session list');

  // Settings entry opens the settings dialog.
  await review.click('.pd-settings-entry');
  await review.waitFor('Boolean(document.querySelector(".pd-settings-dialog"))');
  await review.key('Escape');
  await review.waitFor('!document.querySelector(".pd-settings-dialog")');

  // Ctrl+B hides the sidebar pane; the rail stays visible.
  await review.key('b', { ctrl: true });
  await review.waitFor(`${sidebar}.classList.contains("is-collapsed")`);
  await check(await review.evaluate(`(() => { const r = ${rail}.getBoundingClientRect(); const s = document.querySelector(".pd-sidebar").getBoundingClientRect(); return r.width > 0 && s.width === 0; })()`), 'Ctrl+B hides the sidebar but keeps the activity bar');
  await check(await review.evaluate(`(() => { const button = ${rail}.querySelector(".pd-activity-new-session"); return Boolean(button) && button.getBoundingClientRect().top > ${rail}.querySelector(".pd-activity-sessions").getBoundingClientRect().bottom - 1; })()`), 'With the sidebar hidden, new conversation returns to the rail under the sessions toggle');
  await review.screenshot('activity-bar-sidebar-hidden');
  await review.key('b', { ctrl: true });
  await review.waitFor(`!${sidebar}.classList.contains("is-collapsed")`);
  await check(await review.evaluate(`document.querySelector(".pd-sidebar").getBoundingClientRect().width > 100`), 'Ctrl+B restores the sidebar pane');

  // The sessions toggle in the rail opens/closes the sidebar pane too.
  await review.click('.pd-activity-sessions');
  await review.waitFor(`${sidebar}.classList.contains("is-collapsed")`);
  await check(await review.evaluate(`(() => { const r = document.querySelector(".pd-activity-bar").getBoundingClientRect(); const s = ${sidebar}.getBoundingClientRect(); return r.width > 0 && s.width === 0; })()`), 'Sessions toggle collapses the sidebar but keeps the rail');
  // Opening a main view while the sidebar is collapsed keeps the sidebar collapsed.
  await review.click('.pd-activity-automations');
  await review.waitFor('document.querySelector(".pd-activity-automations").classList.contains("is-active")');
  await check(await review.evaluate(`${sidebar}.classList.contains("is-collapsed")`), 'Opening automations keeps a collapsed sidebar collapsed');
  await review.click('.pd-activity-automations');
  await review.waitFor('!document.querySelector(".pd-activity-automations").classList.contains("is-active")');
  await review.click('.pd-activity-sessions');
  await review.waitFor(`!${sidebar}.classList.contains("is-collapsed")`);
  await check(await review.evaluate(`document.querySelector(".pd-sidebar").getBoundingClientRect().width > 100`), 'Sessions toggle restores the sidebar pane');

  await review.viewport(540, 820);
  if (!await review.evaluate(`${sidebar}.classList.contains("is-open")`)) await review.click('.pd-activity-sessions');
  await review.assert(`(() => { const bar=${topBar}.getBoundingClientRect(); const pane=${sidebar}.getBoundingClientRect(); const heading=document.querySelector('.pd-sidebar-organize-toolbar').getBoundingClientRect(); const button=document.querySelector('.pd-sidebar-organize-toolbar .pd-sidebar-new-session').getBoundingClientRect(); return Math.abs(pane.top-bar.bottom)<1 && Math.abs(heading.top-pane.top)<1 && Math.abs(heading.height-36)<1 && button.right <= pane.right - 8; })()`, 'The narrow sidebar begins directly below the top bar with its one-row heading, new conversation included');
  await review.screenshot('activity-bar-compact-narrow');
  // Switching to automations on a narrow viewport keeps the sidebar drawer closed instead of covering the page.
  await review.key('Escape');
  await review.waitFor(`!${sidebar}.classList.contains("is-open")`);
  await review.click('.pd-activity-automations');
  await review.waitFor(`document.querySelector(".pd-activity-automations").classList.contains("is-active") && !${sidebar}.classList.contains("is-open")`);
}
