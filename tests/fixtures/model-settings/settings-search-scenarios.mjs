export default async function settingsSearchScenarios(review) {
  const input = '.pd-settings-search input';
  const results = '.pd-settings-search-result';
  await review.waitFor('window.__modelReview?.ready === true');
  await review.click('.pd-settings-entry');
  await review.waitFor(`Boolean(document.querySelector(${JSON.stringify(input)}))`);
  await review.screenshot('settings-search-dark');

  await review.key('f', { ctrl: true });
  await review.assert(`document.activeElement === document.querySelector(${JSON.stringify(input)})`, 'Ctrl+F focuses settings search');
  await review.fill(input, '字号');
  await review.assert('document.querySelectorAll(".pd-settings-search-result").length === 3 && document.querySelector(".pd-settings-content h2").textContent === "常规"', 'Search finds settings on inactive pages without changing the current page');
  await review.screenshot('settings-search-results-dark');
  await review.key('ArrowDown');
  await review.key('Enter');
  await review.assert('document.querySelector(".pd-settings-content h2").textContent === "外观" && document.activeElement.matches("[data-setting=font] input") && Boolean(document.querySelector(".pd-settings-row.pd-settings-search-target"))', 'Keyboard selection opens the page, focuses the matching control, and highlights its row');
  await review.assert(`document.querySelector(${JSON.stringify(input)}).value === '' && document.querySelectorAll('.pd-settings-nav button').length === 13`, 'Choosing a result restores the complete category navigation');

  await review.fill(input, '  命令   字号  ');
  await review.assert('document.querySelectorAll(".pd-settings-search-result").length === 1', 'Search handles whitespace and multiple keywords');
  await review.click(results);
  await review.assert('document.activeElement.id === "pd-command-font"', 'A same-page result locates the matching setting');
  await review.fill(input, 'zz-no-such-setting');
  await review.assert('document.querySelector(".pd-settings-search-status").textContent === "未找到匹配的设置" && !document.querySelector(".pd-settings-search-result")', 'An unmatched query shows an empty state');
  await review.key('Escape');
  await review.assert('Boolean(document.querySelector(".pd-settings-dialog")) && Boolean(document.querySelector(".pd-settings-nav"))', 'Escape clears the query while keeping settings open');

  await review.clickText('.pd-settings-nav button', '常规');
  await review.waitFor('!document.querySelector(".pd-conversation-storage input").disabled');
  await review.fill('.pd-conversation-storage input', 'C:\\review-draft');
  await review.fill(input, '推理');
  await review.assert('document.querySelector(".pd-settings-search-result small").textContent === "对话"', 'Moved chat controls are indexed under their new category');
  await review.click(results);
  await review.waitFor('Boolean(document.querySelector(".pd-settings-discard"))');
  await review.clickText('.pd-settings-discard button', '继续编辑');
  await review.assert('document.querySelector(".pd-conversation-storage input").value === "C:\\\\review-draft" && document.querySelector(".pd-settings-content h2").textContent === "常规"', 'Search navigation preserves unsaved settings when continuing editing');
  await review.click(results);
  await review.clickText('.pd-settings-discard button', '舍弃修改');
  await review.assert('document.querySelector(".pd-settings-content h2").textContent === "对话" && document.activeElement.matches("[data-setting=show-reasoning]")', 'Discarding a draft completes search navigation to the new chat page');
  await review.assert('!window.__modelReview.calls.some(call => call.name === "setDesktopSettings")', 'Searching and discarding never saves settings');

  await review.fill(input, '提示自动消失');
  await review.assert('document.querySelector(".pd-settings-search-result small").textContent === "通知与声音"', 'Moved notice controls are indexed under notifications');
  await review.click(results);
  await review.assert('document.querySelector(".pd-settings-content h2").textContent === "通知与声音" && document.activeElement.matches("[data-setting=operation-notice-timeout]")', 'Notification search focuses the setting on its new page');
  await review.clickText('.pd-settings-nav button', '外观');
  await review.clickText('.pd-appearance-choice', '浅色');
  await review.fill(input, '通知');
  await review.assert('(() => { const style = getComputedStyle(document.querySelector(".pd-settings-search input")); return style.outlineStyle === "none" && style.boxShadow === "none" && style.backgroundColor === "rgba(0, 0, 0, 0)"; })()', 'Light-mode search uses one pill-shaped field and one focus ring');
  await review.screenshot('settings-search-results-light');
  await review.viewport(600, 800);
  await review.assert('document.documentElement.scrollWidth <= innerWidth && document.querySelector(".pd-settings-search-results").getBoundingClientRect().bottom <= document.querySelector(".pd-settings-content").getBoundingClientRect().top + 1', 'Narrow layout keeps search results above the settings content without overflow');
  await review.screenshot('settings-search-narrow');
  await review.click('.pd-settings-search-clear');
  await review.assert(`document.activeElement === document.querySelector(${JSON.stringify(input)}) && Boolean(document.querySelector('.pd-settings-nav'))`, 'Clear restores navigation and keeps focus in the search field');

  await review.viewport(1440, 1000);
  await review.clickText('.pd-settings-nav button', '常规');
  await review.clickText('.pd-language-options button', 'English');
  await review.fill(input, 'FONT SIZE');
  await review.assert('document.querySelectorAll(".pd-settings-search-result").length === 3 && document.querySelector(".pd-settings-search input").placeholder === "Search settings"', 'English search is localized and case insensitive');
  await review.screenshot('settings-search-english');
}
