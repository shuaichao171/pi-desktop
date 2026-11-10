// 「猜你下一句」：设置里开关（默认关）与模型选择；开启后一次回复结束（busy → idle）请求一次，
// 空闲且输入框为空时以灰字显示，Tab 填入。全部为模拟 bridge，不调用真实模型。
// node tests/fixtures/model-settings/run.mjs --run --scenario=../next-input-suggestion/scenarios.mjs
function installSuggestionFixture() {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const state = window.__suggestionReview = { requests: [] };
  Object.assign(fixture.snapshot, {
    sessionId: 'suggest-session', sessionPath: fixture.snapshot.cwd + '\\suggest.jsonl', historyTotal: 2,
    messages: [
      { id: 'u1', order: 1, runId: 'r1', role: 'user', status: 'done', text: '帮我把设置页的卡片间距调小一点', attachments: [] },
      { id: 'a1', order: 2, runId: 'r1', role: 'assistant', status: 'done', text: '已把卡片间距从 16px 调整为 12px，并更新了快照测试。', thinking: '', thinkingTruncated: false },
    ],
  });
  bridge.listSessionsPage = async () => ({ sessions: [], total: 0, hasMore: false, revision: 1 });
  bridge.suggestNextInput = async request => { state.requests.push(request); return '运行一下测试确认没有回归'; };
}

export default async function nextInputSuggestionScenarios(review) {
  const textarea = '.pd-composer-shell textarea';
  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-activity-bar"))');
  await review.viewport(1440, 900);
  await review.reducedMotion(true);
  await review.reloadWithFixture(`(${installSuggestionFixture.toString()})()`);
  await review.waitFor(`Boolean(document.querySelector(${JSON.stringify(textarea)}))`);

  // Off by default: a settled reply asks nothing.
  await review.evaluate(`window.__modelReview.emitAgent({ type: 'status', status: 'busy' })`);
  await review.evaluate(`window.__modelReview.emitAgent({ type: 'status', status: 'idle' })`);
  await review.evaluate('new Promise(resolve => setTimeout(resolve, 300))');
  await review.assert(`window.__suggestionReview.requests.length === 0 && !document.querySelector(${JSON.stringify(textarea)}).dataset.suggestion`, 'The feature is off by default and makes no request');

  // Settings: switch on, model picker appears.
  await review.click('.pd-settings-entry');
  await review.waitFor(`[...document.querySelectorAll('.pd-settings-nav button')].some(e => e.textContent.trim() === '常规')`);
  await review.clickText('.pd-settings-nav button', '常规');
  await review.waitFor(`Boolean(document.querySelector('[data-setting="next-suggestion"]'))`);
  await review.assert(`document.querySelector('[data-setting="next-suggestion"]').getAttribute('aria-checked') === 'false'`, 'The settings switch starts off');
  await review.click('[data-setting="next-suggestion"]');
  await review.waitFor(`Boolean(document.querySelector('[data-setting="next-suggestion-model"]'))`);
  await review.assert(`[...document.querySelector('[data-setting="next-suggestion-model"]').options].length >= 2`, 'Turning it on offers a separate model choice');
  await review.evaluate(`document.querySelector('[data-setting="next-suggestion-model"]').scrollIntoView({ block: 'center' })`);
  await review.screenshot('suggestion-01-settings');
  await review.key('Escape');
  await review.waitFor('!document.querySelector(".pd-settings-dialog")');

  // A reply settles → one request → grey placeholder; Tab fills it in.
  await review.evaluate(`window.__modelReview.emitAgent({ type: 'status', status: 'busy' })`);
  await review.evaluate(`window.__modelReview.emitAgent({ type: 'status', status: 'idle' })`);
  await review.waitFor(`document.querySelector(${JSON.stringify(textarea)}).dataset.suggestion === 'true'`);
  await review.assert(`window.__suggestionReview.requests.length === 1 && window.__suggestionReview.requests[0].sessionPath.endsWith('suggest.jsonl')`, 'One request per settled reply, scoped to the open conversation');
  await review.assert(`document.querySelector(${JSON.stringify(textarea)}).placeholder === '运行一下测试确认没有回归'`, 'The guess shows as the empty input placeholder');
  await review.screenshot('suggestion-02-placeholder');
  await review.click(textarea);
  await review.key('Tab');
  await review.waitFor(`document.querySelector(${JSON.stringify(textarea)}).value === '运行一下测试确认没有回归'`);
  await review.assert('true', 'Tab fills the guessed sentence into the input');
  await review.screenshot('suggestion-03-filled');
}
