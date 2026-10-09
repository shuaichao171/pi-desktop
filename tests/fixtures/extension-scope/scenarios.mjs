// zcode per-task interactions: a plugin question raised in one conversation only
// shows while that conversation is open. Other conversations never see the card —
// their attention stays on the sidebar waiting indicator.
// node tests/fixtures/model-settings/run.mjs --run --scenario=../extension-scope/scenarios.mjs
function installExtensionScopeFixture() {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const home = fixture.snapshot.cwd;
  bridge.listWorkspaces = async () => [home];
  bridge.listSessions = async () => [];
  window.__scopeReview = {
    home,
    openConversation(id) {
      Object.assign(fixture.snapshot, { cwd: home, sessionId: id, sessionPath: home + '\\' + id + '.jsonl', status: 'idle', messages: [], activities: [], runs: [], historyTotal: 0, error: null });
      fixture.emitAgent({ ...structuredClone(fixture.snapshot), type: 'ready' });
    },
    ask: request => fixture.emit('onExtensionDialog', request),
    answer: (id, value) => { fixture.calls.push({ name: 'respondExtensionDialog', args: [id, value] }); fixture.emit('onExtensionDialogClosed', id); },
  };
  window.__scopeReview.openConversation('conv-a');
}

export default async function extensionScopeScenarios(review) {
  const q = JSON.stringify;
  const card = '.pd-extension-request[role="region"]';
  const state = 'window.__scopeReview';
  const body = `document.querySelector('.pd-conversation-body')`;
  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-composer-shell > textarea"))');
  await review.viewport(1440, 1000);
  await review.reducedMotion(true);
  await review.reloadWithFixture(`(${installExtensionScopeFixture.toString()})()`);
  await review.waitFor(`window.__modelReview.snapshot.sessionId === 'conv-a' && ${body}?.classList.contains('is-empty')`);

  // A question from conversation B must not render while A is open.
  await review.evaluate(`window.__scopeReview.ask({ id: 'bg-question', kind: 'select', title: '后台会话的问题', message: '另一个对话里的插件提问', options: ['继续', '停止'], scope: { cwd: window.__modelReview.snapshot.cwd, sessionPath: window.__scopeReview.home + '\\\\conv-b.jsonl', sessionId: 'conv-b' } })`);
  await review.settle();
  await review.assert(`!document.querySelector(${q(card)}) && !${body}.classList.contains('has-extension-request')`, 'a question from another conversation never shows while a different one is open');

  // Switching to the asking conversation reveals exactly that question.
  await review.evaluate(`${state}.openConversation('conv-b')`);
  await review.waitFor(`Boolean(document.querySelector(${q(card)}))`);
  await review.assert(`document.querySelector(${q(card)})?.textContent.includes('后台会话的问题') && ${body}.classList.contains('has-extension-request')`, 'switching to the asking conversation reveals its question');
  await review.screenshot('extension-scope-revealed');

  // Answering releases the layout; going back to A still shows nothing.
  await review.evaluate(`${state}.answer('bg-question', '继续')`);
  await review.waitFor(`!document.querySelector(${q(card)})`);
  await review.evaluate(`${state}.openConversation('conv-a')`);
  await review.settle();
  await review.assert(`!document.querySelector(${q(card)}) && !${body}.classList.contains('has-extension-request')`, 'the answered question leaves no trace in other conversations');

  // A scoped question for the OPEN conversation shows immediately.
  await review.evaluate(`window.__scopeReview.ask({ id: 'fg-question', kind: 'confirm', title: '当前会话的问题', message: '本对话插件请求确认', scope: { cwd: window.__modelReview.snapshot.cwd, sessionPath: window.__modelReview.snapshot.sessionPath, sessionId: window.__modelReview.snapshot.sessionId } })`);
  await review.waitFor(`Boolean(document.querySelector(${q(card)}))`);
  await review.assert(`document.querySelector(${q(card)})?.textContent.includes('当前会话的问题')`, 'a scoped question for the open conversation renders right away');
  await review.evaluate(`${state}.answer('fg-question', true)`);
  await review.waitFor(`!document.querySelector(${q(card)})`);
}
