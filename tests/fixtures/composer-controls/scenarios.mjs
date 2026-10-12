// Prepare: node tests/fixtures/composer-controls/scenarios.mjs --check
// Run after build: node tests/fixtures/model-settings/run.mjs --run --scenario=../composer-controls/scenarios.mjs
// Uses only the runner's owned headless shell and an isolated renderer bridge.

function installComposerControlsHarness() {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const clone = value => structuredClone(value);
  const state = window.__composerControls = { calls: [], failAbort: 0, deferAbort: false, pendingAbort: null, pendingAborts: new Map(), failSubmit: 0, deferSubmit: false, pendingSubmit: null };
  state.scope = () => ({ cwd: fixture.snapshot.cwd, sessionPath: fixture.snapshot.sessionPath, sessionId: fixture.snapshot.sessionId });
  state.scopeKey = scope => JSON.stringify([scope.cwd, scope.sessionPath, scope.sessionId]);
  state.baseScope = state.scope();
  state.scopeA = { ...state.baseScope, sessionPath: state.baseScope.sessionPath + '-stop-a', sessionId: 'shared-stop-session-id' };
  state.scopeB = { ...state.baseScope, sessionPath: state.baseScope.sessionPath + '-stop-b', sessionId: 'shared-stop-session-id' };
  state.releaseAbort = scope => {
    const resolve = state.pendingAborts.get(state.scopeKey(scope));
    if (!resolve) throw new Error('No pending stop request for scope');
    resolve();
  };
  state.visible = node => !!node && !node.closest('[hidden],[inert],[aria-hidden="true"]') && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none';
  state.log = (name, request) => { state.calls.push({ name, request: clone(request) }); fixture.calls.push({ name: 'composerControls.' + name, args: [clone(request)] }); };
  state.setStatus = status => { fixture.snapshot.status = status; fixture.emitAgent({ type: 'status', status }); };
  state.ready = (status = 'busy', scope = state.baseScope) => {
    const running = status === 'busy', now = Date.now();
    const run = { id: 'composer-controls-run', startedAt: now - 5000, finishedAt: running ? null : now, status: running ? 'running' : 'completed' };
    Object.assign(fixture.snapshot, clone(scope), {
      status, error: null, runs: [run], activities: [], fileChanges: [], queuedCount: 0, queuedMessages: [], historyTotal: 2,
      messages: [
        { id: 'composer-controls-user', order: 0, role: 'user', status: 'done', runId: run.id, text: '请整理聊天框的发送与停止操作。' },
        { id: 'composer-controls-answer', order: 1, role: 'assistant', status: running ? 'streaming' : 'done', runId: run.id, text: '正在检查输入框和跟进消息的处理方式。' },
      ],
    });
    fixture.emitAgent({ ...clone(fixture.snapshot), type: 'ready' });
    state.setStatus(status);
  };
  bridge.submitInput = async request => {
    state.log('submit', request);
    if (state.failSubmit) { state.failSubmit--; throw new Error('模拟发送失败，请重试。'); }
    if (state.deferSubmit) {
      state.deferSubmit = false;
      await new Promise(resolve => { state.pendingSubmit = resolve; });
      state.pendingSubmit = null;
    }
    return { id: request.id, state: 'accepted' };
  };
  bridge.newSession = async () => {
    state.log('new-session', state.scope());
    await new Promise((resolve, reject) => { state.pendingNavigation = { resolve, reject }; });
    state.pendingNavigation = null;
  };
  bridge.abort = async () => {
    const scope = state.scope(), key = state.scopeKey(scope);
    state.log('abort', scope);
    if (state.failAbort) { state.failAbort--; throw new Error('模拟停止失败，请重试。'); }
    if (state.deferAbort) {
      state.deferAbort = false;
      let release;
      await new Promise(resolve => { release = resolve; state.pendingAbort = resolve; state.pendingAborts.set(key, resolve); });
      state.pendingAborts.delete(key);
      if (state.pendingAbort === release) state.pendingAbort = null;
    }
    if (state.scopeKey(state.scope()) === key) state.setStatus('idle');
  };
  state.ready();
}

export default async function composerControlsScenarios(review) {
  const c = 'window.__composerControls';
  const textarea = '.pd-composer-shell > textarea';
  const stop = '.pd-send-button[data-action="stop"]';
  const send = '.pd-send-button[data-action="send"]';
  const behaviorSetting = '[data-setting="busy-input-behavior"]';
  const singleAction = action => review.assert(`(() => {
    const shell = document.querySelector('.pd-composer-shell');
    const buttons = [...shell.querySelectorAll('.pd-send-button')].filter(${c}.visible);
    return buttons.length === 1 && buttons[0].dataset.action === ${JSON.stringify(action)}
      && ![...shell.querySelectorAll('.pd-composer-action')].some(button => ${c}.visible(button) && /停止|引导|排队/.test(button.textContent + (button.getAttribute('aria-label') ?? '')))
      && !shell.querySelector('.pd-steer-action');
  })()`, `The composer exposes one primary ${action} control without separate stop or steer buttons`);
  const openGeneral = async () => {
    await review.click('.pd-settings-entry');
    await review.clickText('.pd-settings-nav button', '常规');
    await review.waitFor(`Boolean(document.querySelector('${behaviorSetting}'))`);
  };
  const closeSettings = async () => { await review.key('Escape'); await review.waitFor('!document.querySelector(".pd-settings-dialog")'); };
  const submitAndAssert = async (text, modifiers, behavior) => {
    await review.fill(textarea, text);
    await review.key('Enter', modifiers);
    await review.waitFor(`${c}.calls.some(call => call.name === 'submit' && call.request.text === ${JSON.stringify(text)}) && document.querySelector('${textarea}').value === ''`);
    await review.assert(`${c}.calls.filter(call => call.name === 'submit').at(-1).request.behavior === ${JSON.stringify(behavior)}`, `Keyboard submission uses ${behavior}: ${text}`);
  };
  const clickSendAndAssert = async (text, behavior) => {
    await review.fill(textarea, text);
    await singleAction('send');
    await review.evaluate(`${c}.abortsBeforeSend = ${c}.calls.filter(call => call.name === 'abort').length`);
    await review.click(send);
    await review.waitFor(`${c}.calls.some(call => call.name === 'submit' && call.request.text === ${JSON.stringify(text)}) && document.querySelector('${textarea}').value === '' && !!document.querySelector('${stop}')`);
    await review.assert(`${c}.calls.filter(call => call.name === 'submit').at(-1).request.behavior === ${JSON.stringify(behavior)} && ${c}.calls.filter(call => call.name === 'abort').length === ${c}.abortsBeforeSend`, `Primary busy send uses ${behavior}, preserves the running task and restores stop after clearing: ${text}`);
  };

  await review.waitFor('window.__modelReview?.ready === true');
  await review.reducedMotion(true);
  await review.viewport(1440, 1000);
  await review.evaluate(`(${installComposerControlsHarness.toString()})()`);
  await review.waitFor(`Boolean(document.querySelector('${stop}')) && document.querySelector('${textarea}')?.value === ''`);
  await singleAction('stop');
  await review.assert(`!document.querySelector('${stop}').disabled && !!document.querySelector('${stop} svg rect')`, 'A busy empty composer offers an enabled square stop button');
  await review.screenshot('composer-busy-empty-dark-1440');
  await review.click(stop);
  await review.waitFor(`Boolean(document.querySelector('${send}'))`);
  await review.assert(`${c}.calls.filter(call => call.name === 'abort').length === 1 && !${c}.calls.some(call => call.name === 'submit') && document.querySelector('${send}').disabled`, 'Stopping an empty composer calls abort once and restores disabled idle send');

  await review.evaluate(`${c}.ready()`);
  await review.waitFor(`Boolean(document.querySelector('${stop}'))`);
  await review.fill(textarea, '任务进行中也可以点击发送。');
  await singleAction('send');
  await review.assert(`!document.querySelector('${send}').disabled && document.querySelector('${send}').getAttribute('aria-label') === '发送' && !!document.querySelector('${send} svg path') && !document.querySelector('${send} svg rect')`, 'Typing while busy replaces the stop square with an enabled, labelled send arrow');
  await review.screenshot('composer-busy-draft-dark-1440');
  await review.fill(textarea, '');
  await singleAction('stop');
  await review.fill(textarea, '   ');
  await singleAction('stop');
  await review.fill(textarea, '发送失败后保留这段草稿。');
  await review.evaluate(`${c}.failSubmit = 1`);
  await review.click(send);
  await review.waitFor(`document.body.textContent.includes('模拟发送失败，请重试。') && !document.querySelector('${send}')?.disabled`);
  await review.assert(`document.querySelector('${textarea}').value === '发送失败后保留这段草稿。' && ${c}.calls.filter(call => call.name === 'submit').length === 1 && ${c}.calls.filter(call => call.name === 'abort').length === 1`, 'Failed busy send preserves the draft and enabled send control without stopping the task');
  await review.evaluate(`${c}.deferSubmit = true`);
  await review.click(send);
  await review.waitFor(`${c}.pendingSubmit !== null`);
  await review.assert(`document.querySelector('${send}').disabled && document.querySelector('${send}').getAttribute('aria-busy') === 'true' && document.querySelector('${textarea}').value === '发送失败后保留这段草稿。'`, 'A pending send retry stays an arrow, disables duplicate submission and keeps its draft until accepted');
  await review.evaluate(`${c}.pendingSubmit()`);
  await review.waitFor(`Boolean(document.querySelector('${stop}')) && document.querySelector('${textarea}').value === ''`);
  await review.assert(`(() => { const submits = ${c}.calls.filter(call => call.name === 'submit'); return submits.length === 2 && submits[0].request.id === submits[1].request.id && submits.every(call => call.request.behavior === 'followUp') && ${c}.calls.filter(call => call.name === 'abort').length === 1; })()`, 'Retry uses the same request id and default queue behavior; accepted busy send restores stop without aborting');
  await review.assert(`!document.body.textContent.includes('模拟发送失败，请重试。')`, 'A successful send retry clears the previous error');

  // Stop remains available only for an empty composer, including retries.
  await review.evaluate(`${c}.failAbort = 1`);
  await review.click(stop);
  await review.waitFor(`document.body.textContent.includes('模拟停止失败，请重试。') && !document.querySelector('${stop}')?.disabled`);
  await review.assert(`document.querySelector('${textarea}').value === '' && ${c}.calls.filter(call => call.name === 'submit').length === 2`, 'A failed empty-composer stop allows retry without submitting');
  await review.evaluate(`${c}.deferAbort = true`);
  await review.click(stop);
  await review.waitFor(`${c}.pendingAbort !== null`);
  await review.assert(`document.querySelector('${stop}').disabled && document.querySelector('${textarea}').value === '' && ${c}.calls.filter(call => call.name === 'abort').length === 3`, 'The stop retry remains disabled while pending');
  await review.evaluate(`${c}.pendingAbort()`);
  await review.waitFor(`Boolean(document.querySelector('${send}')) && document.querySelector('${send}').disabled`);
  await singleAction('send');
  await review.assert(`document.querySelector('${textarea}').value === '' && !!document.querySelector('${send} svg path') && !document.querySelector('${send} svg rect')`, 'Stopping an empty composer restores the disabled idle send arrow');
  await review.assert(`!document.body.textContent.includes('模拟停止失败，请重试。')`, 'A successful stop retry clears the previous error');
  await review.fill(textarea, '空闲时正常发送。');
  await review.click(send);
  await review.waitFor(`${c}.calls.filter(call => call.name === 'submit').length === 3 && document.querySelector('${textarea}').value === ''`);
  await review.assert(`${c}.calls.filter(call => call.name === 'submit').at(-1).request.behavior == null`, 'Idle primary send starts a normal request without a follow-up override');

  // Independent stop requests retain their pending state across session switches.
  await review.evaluate(`${c}.abortsBeforeOverlap = ${c}.calls.filter(call => call.name === 'abort').length; ${c}.ready('busy', ${c}.scopeA)`);
  await review.waitFor(`Boolean(document.querySelector('${stop}')) && !document.querySelector('${stop}').disabled && document.querySelector('${textarea}').value === ''`);
  await review.evaluate(`${c}.deferAbort = true`);
  await review.click(stop);
  await review.waitFor(`${c}.pendingAborts.has(${c}.scopeKey(${c}.scopeA)) && document.querySelector('${stop}').disabled`);
  await review.evaluate(`${c}.ready('busy', ${c}.scopeB)`);
  await review.waitFor(`Boolean(document.querySelector('${stop}')) && !document.querySelector('${stop}').disabled && document.querySelector('${textarea}').value === ''`);
  await review.evaluate(`${c}.deferAbort = true`);
  await review.click(stop);
  await review.waitFor(`${c}.pendingAborts.has(${c}.scopeKey(${c}.scopeB)) && document.querySelector('${stop}').disabled`);
  await review.evaluate(`${c}.ready('busy', ${c}.scopeA)`);
  await review.waitFor(`document.querySelector('${textarea}').value === '' && document.querySelector('${stop}')?.disabled`);
  await review.assert(`document.querySelector('${stop}').disabled && document.querySelector('${stop}').getAttribute('aria-busy') === 'true' && ${c}.pendingAborts.size === 2`, 'Returning to session A retains its pending stop while session B also stops');
  await review.evaluate(`${c}.releaseAbort(${c}.scopeB)`);
  await review.waitFor(`!${c}.pendingAborts.has(${c}.scopeKey(${c}.scopeB))`);
  await review.assert(`window.__modelReview.snapshot.status === 'busy' && document.querySelector('${stop}').disabled && document.querySelector('${stop}').getAttribute('aria-busy') === 'true' && document.querySelector('${textarea}').value === ''`, 'Finishing session B stop cannot unlock session A or change its status and composer');
  await review.evaluate(`${c}.releaseAbort(${c}.scopeA)`);
  await review.waitFor(`Boolean(document.querySelector('${send}')) && document.querySelector('${send}').disabled && ${c}.pendingAborts.size === 0`);
  await review.assert(`document.querySelector('${textarea}').value === '' && ${c}.calls.filter(call => call.name === 'abort').length === ${c}.abortsBeforeOverlap + 2 && [${c}.scopeA, ${c}.scopeB].every(scope => ${c}.calls.filter(call => call.name === 'abort' && ${c}.scopeKey(call.request) === ${c}.scopeKey(scope)).length === 1)`, 'Completing session A restores send and each overlapping session was stopped exactly once');
  await review.record('overlapping-stop-requests', `({scopes: [${c}.scopeA, ${c}.scopeB], aborts: ${c}.calls.filter(call => call.name === 'abort'), pending: ${c}.pendingAborts.size})`);

  // New conversations open an editable local draft immediately while Pi prepares
  // in the background (docs/new-conversation-responsiveness.md). The previous
  // conversation's draft must not leak into it, a first message is held locally
  // instead of reaching the previous session, and a failed creation restores it.
  for (const status of ['idle', 'busy']) {
    await review.evaluate(`${c}.ready(${JSON.stringify(status)}); ${c}.pendingNavigation = null`);
    await review.fill(textarea, `切换期间保留草稿 ${status}`);
    await review.evaluate(`${c}.navigationActionsBefore = ${c}.calls.filter(call => call.name === 'submit' || call.name === 'abort').length`);
    await review.click('.pd-new-session');
    await review.waitFor(`${c}.pendingNavigation !== null && !document.querySelector('${textarea}').disabled && document.querySelector('${textarea}').value === '' && document.activeElement === document.querySelector('${textarea}')`);
    await review.fill(textarea, `新会话首条消息 ${status}`);
    await review.key('Enter');
    await review.waitFor(`document.querySelector('${textarea}').value === ''`);
    await review.assert(`${c}.calls.filter(call => call.name === 'submit' || call.name === 'abort').length === ${c}.navigationActionsBefore`, `A first message typed while a new conversation prepares (${status}) is held locally and never reaches the previous session`);
    if (status === 'busy') await review.screenshot('composer-navigation-pending-dark-1440');
    await review.evaluate(`${c}.pendingNavigation.reject(new Error('模拟新建失败，保留草稿')); ${c}.pendingNavigation = null`);
    await review.waitFor(`document.querySelector('.pd-composer-error')?.textContent.includes('模拟新建失败，保留草稿') && Boolean(document.querySelector('.pd-composer-retry'))`);
    await review.assert(`document.querySelector('${textarea}').value === ${JSON.stringify(`新会话首条消息 ${status}`)} && !document.querySelector('${textarea}').disabled && ${c}.calls.filter(call => call.name === 'submit' || call.name === 'abort').length === ${c}.navigationActionsBefore`, 'A failed new conversation restores the held message for retry without sending it');
    // Clear the restored text, then retry: the conversation is created without sending anything.
    // Previous-draft preservation is covered by tests/fixtures/new-conversation.
    await review.fill(textarea, '');
    await review.click('.pd-composer-retry');
    await review.waitFor(`${c}.pendingNavigation !== null`);
    await review.evaluate(`${c}.pendingNavigation.resolve()`);
    await review.waitFor(`${c}.pendingNavigation === null && !document.querySelector('.pd-composer-error') && !document.querySelector('${textarea}').disabled`);
    await review.assert(`${c}.calls.filter(call => call.name === 'submit' || call.name === 'abort').length === ${c}.navigationActionsBefore`, `Retrying the failed new conversation (${status}) never sends the cleared draft`);
  }
  await review.fill(textarea, '');

  // With no queued rows, settings remain available and control the mounted composer immediately.
  await review.evaluate(`${c}.ready()`);
  await openGeneral();
  await review.assert(`document.querySelector('${behaviorSetting} button[aria-pressed="true"]').textContent.trim() === '排队'`, 'Default busy Enter behavior is queueing and is exposed in General settings');
  await review.screenshot('composer-behavior-settings-dark-1440');
  await closeSettings();
  await clickSendAndAssert('默认按钮点击加入队列', 'followUp');
  await submitAndAssert('默认 Enter 加入队列', {}, 'followUp');
  await submitAndAssert('默认 Ctrl+Enter 立即引导', { ctrl: true }, 'steer');
  await submitAndAssert('默认 Cmd+Enter 立即引导', { meta: true }, 'steer');

  await review.fill(textarea, '保留换行');
  await review.evaluate(`${c}.submitsBeforeComposition = ${c}.calls.filter(call => call.name === 'submit').length`);
  await review.key('Enter', { shift: true });
  await review.assert(`document.querySelector('${textarea}').value === ${JSON.stringify('保留换行\n')} && ${c}.calls.filter(call => call.name === 'submit').length === ${c}.submitsBeforeComposition`, 'Shift+Enter adds a newline without queueing or steering');
  await review.fill(textarea, '输入法组合中的文字');
  await review.evaluate(`(() => {
    const input = document.querySelector('${textarea}');
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '文字' }));
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 }));
  })()`);
  await review.settle();
  await review.assert(`${c}.calls.filter(call => call.name === 'submit').length === ${c}.submitsBeforeComposition && document.querySelector('${textarea}').value === '输入法组合中的文字'`, 'IME Enter preserves composed input without sending it');
  await review.evaluate(`document.querySelector('${textarea}').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '文字' }))`);
  await review.fill(textarea, '');

  await openGeneral();
  await review.clickText(`${behaviorSetting} button`, '引导');
  await review.assert(`localStorage.getItem('pi-desktop:busy-input-behavior') === 'steer'`, 'Changing busy Enter behavior persists the selection');
  await review.clickText('.pd-settings-nav button', '快捷键');
  await review.assert(`[...document.querySelectorAll('.pd-shortcut-rows li')].some(row => row.textContent.includes('发送消息 / 任务进行时引导') && row.textContent.includes('Enter')) && [...document.querySelectorAll('.pd-shortcut-rows li')].some(row => row.textContent.includes('排队') && row.textContent.includes('Ctrl'))`, 'Keyboard shortcut settings immediately describe the selected default and its alternate');
  await closeSettings();
  await clickSendAndAssert('设置修改后按钮点击立即引导', 'steer');
  await submitAndAssert('设置修改后 Enter 立即引导', {}, 'steer');
  await submitAndAssert('设置修改后 Ctrl+Enter 反向排队', { ctrl: true }, 'followUp');
  await submitAndAssert('设置修改后 Cmd+Enter 反向排队', { meta: true }, 'followUp');
  await review.fill(textarea, '窄屏下输入文字后显示发送按钮。');
  await review.viewport(680, 900);
  await singleAction('send');
  await review.assert(`(() => { const box = document.querySelector('${send}').getBoundingClientRect(); return document.documentElement.scrollWidth <= innerWidth && box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight; })()`, 'The narrow busy composer and send button stay within the viewport');
  await review.screenshot('composer-busy-draft-dark-680');
  await review.viewport(1440, 1000);
  await openGeneral();
  await review.viewport(680, 900);
  await review.screenshot('composer-behavior-settings-dark-680');
  await review.clickText('.pd-settings-nav button', '外观');
  await review.clickText('.pd-appearance-choice', '浅色');
  await closeSettings();
  await review.waitFor('document.documentElement.dataset.theme === "light"');
  await review.screenshot('composer-busy-draft-light-680');
  await review.evaluate(`${c}.setStatus('idle')`);
  await review.waitFor(`Boolean(document.querySelector('${send}'))`);
  await review.screenshot('composer-idle-draft-light-680');

  // A true page reload reconstructs the preference hook from persisted storage.
  await review.assert('window.__modelReview.errors.length === 0 && window.__modelReview.unexpected.length === 0', 'No renderer errors or unexpected bridge calls occurred before reload');
  await review.record('composer-controls-before-reload', `({calls: ${c}.calls, preference: localStorage.getItem('pi-desktop:busy-input-behavior')})`);
  await review.evaluate('setTimeout(() => location.reload(), 0); true');
  await review.waitFor('window.__modelReview?.ready === true && !window.__composerControls');
  await review.evaluate(`(${installComposerControlsHarness.toString()})()`);
  await review.viewport(1440, 1000);
  await openGeneral();
  await review.assert(`document.querySelector('${behaviorSetting} button[aria-pressed="true"]').textContent.trim() === '引导'`, 'General settings restore the saved follow-up preference after a full reload');
  await closeSettings();
  await submitAndAssert('重载后 Enter 仍然引导', {}, 'steer');
  await review.assert(`${c}.calls.filter(call => call.name === 'abort').length === 0`, 'Keyboard follow-up delivery never invokes stop');
  await review.record('composer-controls-after-reload', `({calls: ${c}.calls, preference: localStorage.getItem('pi-desktop:busy-input-behavior')})`);
}

if (process.argv.includes('--check')) {
  let count = 0;
  const compile = expression => { new Function(expression); count++; };
  const noop = async () => {};
  await composerControlsScenarios({ evaluate: async value => compile(value), waitFor: async value => compile(value), assert: async value => compile(value), record: async (_name, value) => compile(value), reducedMotion: noop, viewport: noop, click: noop, clickText: noop, key: noop, fill: noop, settle: noop, screenshot: noop });
  console.log(`Prepared ${count} composer-controls expressions; no browser launched.`);
}
