// 识别项目目录：设置「常规」页的开关默认开启；临时对话的第一条消息写了目录时，输入框上方出现横幅，
// 可选择「转移」（回复进行中则等本轮结束）或点 X 关闭。全部为模拟 bridge。
// node tests/fixtures/model-settings/run.mjs --run --scenario=../project-auto-assign/scenarios.mjs
function installFixture() {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const state = window.__projectOfferReview = { resolved: [], submitted: [] };
  bridge.listSessionsPage = async () => ({ sessions: [], total: 0, hasMore: false, revision: 1 });
  bridge.resolveProjectDirectory = async candidates => { state.resolved.push(candidates); return 'D:\\work\\new-app'; };
  bridge.submitInput = async request => {
    state.submitted.push(request.text);
    const message = { id: 'entry-' + request.id, order: 0, role: 'user', text: request.text, attachments: [], status: 'done' };
    fixture.snapshot.messages.push(message);
    fixture.snapshot.historyTotal = 1;
    fixture.snapshot.status = 'busy';
    fixture.emitAgent({ type: 'user-message', ...message });
    fixture.emitAgent({ type: 'status', status: 'busy' });
    return { id: request.id, state: 'accepted' };
  };
}

export default async function projectAutoAssignScenarios(review) {
  const toggle = '[data-setting="project-auto-assign"]';
  const textarea = '.pd-composer-shell textarea';
  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-activity-bar"))');
  await review.viewport(1440, 900);
  await review.reducedMotion(true);
  await review.reloadWithFixture(`(${installFixture.toString()})()`);
  await review.waitFor(`Boolean(document.querySelector(${JSON.stringify(textarea)}))`);

  // Settings: on by default.
  await review.click('.pd-settings-entry');
  await review.waitFor(`[...document.querySelectorAll('.pd-settings-nav button')].some(e => e.textContent.trim() === '常规')`);
  await review.clickText('.pd-settings-nav button', '常规');
  await review.waitFor(`Boolean(document.querySelector('${toggle}'))`);
  await review.assert(`document.querySelector('${toggle}').getAttribute('aria-checked') === 'true'`, 'The switch is on by default');
  await review.evaluate(`document.querySelector('${toggle}').scrollIntoView({ block: 'center' })`);
  await review.screenshot('auto-assign-01-settings');
  await review.key('Escape');
  await review.waitFor('!document.querySelector(".pd-settings-dialog")');

  // The first message names a folder: it is sent as usual and the bar appears.
  await review.fill(textarea, 'D:\\work\\new-app 审查项目');
  await review.click(textarea);
  await review.key('Enter');
  await review.waitFor('Boolean(document.querySelector(".pd-project-offer"))');
  await review.assert(`window.__projectOfferReview.submitted.length === 1 && window.__projectOfferReview.submitted[0] === 'D:\\\\work\\\\new-app 审查项目'`, 'The message is sent unchanged without waiting for the bar');
  await review.assert(`window.__projectOfferReview.resolved[0]?.[0] === 'D:\\\\work\\\\new-app'`, 'The folder is checked by the main process');
  await review.assert(`document.querySelector('.pd-project-offer').textContent.includes('new-app') && Boolean(document.querySelector('.pd-project-offer-move'))`, 'The bar names the folder and offers to move');
  await review.screenshot('auto-assign-02-offer');

  // Accepting during a running reply waits for it to finish.
  await review.click('.pd-project-offer-move');
  await review.waitFor(`document.querySelector('.pd-project-offer')?.classList.contains('is-waiting')`);
  await review.screenshot('auto-assign-03-waiting');

  // X closes the bar.
  await review.click('.pd-project-offer-close');
  await review.waitFor('!document.querySelector(".pd-project-offer")');
  await review.assert('true', 'Closing removes the bar');
}
