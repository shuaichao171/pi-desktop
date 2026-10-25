// Operation-notice auto-dismiss in the real built renderer: the 常规 → 通知
// duration control, its persistence, and the timer itself (including the
// hover hold). Static preparation: node tests/fixtures/model-settings/notice-timeout-scenarios.mjs --check
// Run after build: node tests/fixtures/model-settings/run.mjs --run --scenario=notice-timeout-scenarios.mjs
export default async function noticeTimeoutScenarios(review) {
  const select = '[data-setting="operation-notice-timeout"]';
  const notice = '.pd-operation-notice';
  const present = `Boolean(document.querySelector(${JSON.stringify(notice)}))`;
  const menuItem = '[role="menuitem"]';
  const storageKey = 'pi-desktop:operation-notice-timeout';
  const wait = (ms) => review.evaluate(`new Promise(resolve => setTimeout(resolve, ${ms}))`);
  // A failing export is the cheapest deterministic notice: the run wrapper turns
  // the rejection into an error notice with the reason and a retry action.
  const failExport = () => review.evaluate(`(() => { window.piDesktop.exportSession = async () => { throw new Error('模拟导出失败'); }; return true; })()`);
  const openNotice = async () => {
    await failExport();
    await review.click('.pd-chat-header-more');
    await review.clickText(menuItem, '导出 HTML…');
    await review.waitFor(present);
  };

  await review.waitFor('window.__modelReview?.ready === true');
  await review.click('.pd-settings-entry');
  await review.clickText('.pd-settings-nav button', '常规');
  await review.waitFor(`Boolean(document.querySelector(${JSON.stringify(select)}))`);
  await review.assert(`document.querySelector(${JSON.stringify(select)}).value === '5'`, 'Notices default to a 5-second lifetime');
  await review.assert(`(() => { const s = document.querySelector(${JSON.stringify(select)}); return s.options.length === 5 && [...s.options].map(o => o.textContent.trim()).join('|') === '不限|3 秒|5 秒|10 秒|30 秒'; })()`, 'The duration control offers 不限 plus four presets');
  await review.evaluate(`document.querySelector(${JSON.stringify(select)}).scrollIntoView({ block: 'center' })`);
  await review.settle();
  await review.screenshot('notices-01-duration-setting');
  await review.evaluate(`(() => { const s = document.querySelector(${JSON.stringify(select)}); s.value = '3'; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
  await review.settle();
  await review.assert(`document.querySelector(${JSON.stringify(select)}).value === '3'`, 'Choosing 3 秒 applies to the control');
  await review.assert(`window.localStorage.getItem(${JSON.stringify(storageKey)}) === '3'`, 'The chosen duration persists in local storage');
  await review.assert('document.querySelector(".pd-settings-row-footer [role=status]") === null', 'A persisted duration reports no save failure');

  await review.click('.pd-settings-header button');
  await review.waitFor('document.querySelector(".pd-settings-dialog") === null');
  await openNotice();
  await review.assert(`(() => { const n = document.querySelector(${JSON.stringify(notice)}); return n.classList.contains('is-error') && n.textContent.includes('模拟导出失败'); })()`, 'The failed action shows its reason in an error notice');
  await review.screenshot('notices-02-error-notice');
  // Errors hold twice the configured time, so 3 秒 must still be visible at 2 秒.
  await wait(2000);
  await review.assert(present, 'The error notice is still readable before its 6-second deadline');
  // Hovering holds the countdown: past the deadline it must survive, then leave
  // once the pointer moves away.
  const box = await review.evaluate(`(() => { const box = document.querySelector(${JSON.stringify(notice)}).getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`);
  await review.mouseMove(box.x, box.y);
  await wait(5000);
  await review.assert(present, 'Hovering past the deadline keeps the notice on screen');
  await review.mouseMove(5, 5);
  await review.waitFor(`document.querySelector(${JSON.stringify(notice)}) === null`, 8000);
  await review.assert('true', 'Releasing the pointer lets the held notice dismiss itself');

  // 不限 (0) leaves the notice alone until it is closed by hand.
  await review.click('.pd-settings-entry');
  await review.clickText('.pd-settings-nav button', '常规');
  await review.evaluate(`(() => { const s = document.querySelector(${JSON.stringify(select)}); s.value = '0'; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
  await review.settle();
  await review.assert(`window.localStorage.getItem(${JSON.stringify(storageKey)}) === '0'`, '不限 is stored as 0');
  await review.click('.pd-settings-header button');
  await review.waitFor('document.querySelector(".pd-settings-dialog") === null');
  await openNotice();
  await wait(3000);
  await review.assert(present, '不限 keeps the notice until it is closed');
  await review.click('.pd-operation-notice-close');
  await review.waitFor(`document.querySelector(${JSON.stringify(notice)}) === null`, 4000);
  await review.assert('true', 'The close button still dismisses a 不限 notice');
}
