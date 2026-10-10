// Chat polish: empty conversations hide the stats line, the find bar never covers
// messages, and the updates page uses the shared settings rows.
// node tests/fixtures/model-settings/run.mjs --run --scenario=../ui-polish/scenarios.mjs
function seedConversation() {
  const fixture = window.__modelReview, now = Date.now();
  Object.assign(fixture.snapshot, {
    status: 'idle', historyTotal: 2,
    runs: [{ id: 'polish-run', status: 'completed', startedAt: now - 8000, finishedAt: now - 1000 }],
    messages: [
      { id: 'polish-u', runId: 'polish-run', order: 0, role: 'user', text: '查找栏不能遮住这条第一条消息', status: 'done' },
      { id: 'polish-a', runId: 'polish-run', order: 1, role: 'assistant', text: '查找栏现在位于对话上方的独立区域。', status: 'done' },
    ],
  });
  fixture.emitAgent({ ...structuredClone(fixture.snapshot), type: 'ready' });
}

export default async function uiPolishScenarios(review) {
  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-sidebar-mode"))');
  await review.viewport(1440, 1000);
  await review.reducedMotion(true);
  await review.waitFor('Boolean(document.querySelector(".pd-empty-state"))');
  await review.assert('!document.querySelector(".pd-conversation-metrics")', 'An empty conversation shows no all-zero stats line');
  await review.screenshot('polish-01-empty-conversation');

  await review.evaluate(`(${seedConversation.toString()})()`);
  await review.waitFor('Boolean(document.querySelector("[data-message-id=polish-u]")) && Boolean(document.querySelector(".pd-conversation-metrics"))');
  await review.evaluate('document.querySelector(".pd-composer-shell > textarea").blur()');
  await review.key('f', { ctrl: true });
  await review.waitFor('Boolean(document.querySelector(".pd-transcript-find-input"))');
  await review.fill('.pd-transcript-find-input', '第一条消息');
  await review.waitFor('document.querySelector(".pd-transcript-find-count")?.textContent.includes("1/1")');
  await review.assert('(() => { const bar = document.querySelector(".pd-transcript-find").getBoundingClientRect(); const message = document.querySelector("[data-message-id=polish-u]").getBoundingClientRect(); return bar.bottom <= message.top; })()', 'The find bar sits above the first message instead of covering it');
  await review.screenshot('polish-02-find-bar');
  await review.key('Escape');

  await review.click('.pd-settings-entry');
  await review.clickText('.pd-settings-nav button', '更新');
  await review.waitFor('Boolean(document.querySelector(".pd-update-card"))');
  await review.assert("document.querySelector('[data-setting=\"auto-install-updates\"]')?.getAttribute('role') === 'switch' && document.querySelectorAll('.pd-settings-content .pd-settings-group').length === 2", 'Updates use the shared settings cards and a switch');
  await review.screenshot('polish-03-updates');
}
