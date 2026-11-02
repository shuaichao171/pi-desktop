// Prepare only: node tests/fixtures/extension-requests/scenarios.mjs --check
// Run after building: node tests/fixtures/model-settings/run.mjs --run --scenario=../extension-requests/scenarios.mjs
// A built-renderer regression scenario; bridge responses stay in memory.

function installExtensionRequestsFixture() {
  const fixture = window.__modelReview;
  const state = window.__extensionRequestsReview = { attempts: [], responses: [], failNext: false };
  window.piDesktop.respondExtensionDialog = async (id, value) => {
    fixture.calls.push({ name: 'respondExtensionDialog', args: [id, value] });
    state.attempts.push({ id, value });
    if (state.failNext) {
      state.failNext = false;
      throw new Error('模拟发送失败，请重试');
    }
    state.responses.push({ id, value });
  };
}

export default async function extensionRequestsScenarios(review) {
  const q = JSON.stringify;
  const state = 'window.__extensionRequestsReview';
  const card = '.pd-extension-request[role="region"]';
  const head = card + ' .pd-extension-request-head';
  const actions = card + ' .pd-extension-request-actions';
  const options = card + ' .pd-extension-request-options button';
  const optionLabels = options + ' > span:nth-child(2)';
  const composer = '.pd-composer-shell > textarea';
  const text = selector => `document.querySelector(${q(selector)})?.textContent`;
  const response = (id, value) => `${state}.responses.some(entry => entry.id === ${q(id)} && entry.value === ${q(value)})`;
  const emit = async request => {
    await review.evaluate(`window.__modelReview.emit('onExtensionDialog', ${q(request)})`);
    await review.settle();
  };
  const visible = async title => review.waitFor(`${text(card)}?.includes(${q(title)})`);
  const dismissed = async () => review.waitFor(`!document.querySelector(${q(card)})`);
  const cancel = async () => review.clickText(actions + ' button', '取消');

  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-composer-shell > textarea"))');
  await review.viewport(1440, 1000);
  await review.reducedMotion(true);
  await review.evaluate(`(${installExtensionRequestsFixture.toString()})()`);
  const draft = '这段正在编辑的草稿，不能被新的询问打断。';
  await review.fill(composer, draft);
  await emit({ id: 'choice', kind: 'select', title: '下一步怎样处理？', message: '可以继续编辑对话，稍后再回答。', options: ['保留当前方案', '采用新的方案', '再检查一次'] });
  await visible('下一步怎样处理？');
  await review.assert(`document.activeElement === document.querySelector(${q(composer)}) && document.querySelector(${q(composer)}).value === ${q(draft)}`, 'An incoming question preserves the composer draft and keyboard focus');
  await review.assert(`(() => { const request=document.querySelector(${q(card)}), input=document.querySelector(${q(composer)}); return !document.querySelector('dialog[open]') && request.closest('.pd-composer-wrap') !== null && request.getBoundingClientRect().bottom <= input.closest('.pd-composer-shell').getBoundingClientRect().top + 1; })()`, 'The question appears above the composer without opening a modal dialog');
  await review.key('Escape');
  await review.assert(`${state}.attempts.length === 0 && Boolean(document.querySelector(${q(card)}))`, 'Escape while editing the composer does not cancel an unrelated question');
  await review.click('.pd-activity-sessions');
  await review.assert(`document.querySelector('.pd-sidebar').classList.contains('is-collapsed') && ${state}.attempts.length === 0`, 'A pending question does not block sidebar interaction');
  await review.click('.pd-activity-sessions');

  await review.click(head + ' button[aria-expanded="true"]');
  await review.assert(`Boolean(document.querySelector(${q(head + ' button[aria-expanded="false"]')})) && ${state}.attempts.length === 0`, 'Collapsing a question does not answer or cancel it');
  await review.fill(composer, draft + ' 仍能继续输入。');
  await review.screenshot('extension-question-collapsed');
  await review.click(head + ' button[aria-expanded="false"]');
  await review.assert(`${state}.attempts.length === 0 && document.querySelectorAll(${q(options)}).length === 3`, 'Expanding restores all choices without submitting a response');
  await review.evaluate(`(() => { const buttons=document.querySelectorAll(${q(card + ' button:not(:disabled), ' + card + ' input, ' + card + ' textarea')}); buttons[buttons.length-1].focus(); })()`);
  await review.key('Tab');
  await review.assert(`!document.activeElement.closest(${q(card)})`, 'Tab can leave the question and return to the normal page focus order');
  await review.screenshot('extension-question-inline');
  await review.evaluate(`document.documentElement.dataset.theme = 'light'`);
  await review.screenshot('extension-question-inline-light');
  await review.evaluate(`document.documentElement.dataset.theme = 'dark'`);

  await emit({ id: 'queued-confirm', kind: 'confirm', title: '确认后继续', message: '这是下一条排队的询问。' });
  await review.assert(`${text(card)}?.includes('下一步怎样处理？') && !${text(card)}?.includes('确认后继续')`, 'An additional request waits behind the current question');
  await review.clickText(optionLabels, '采用新的方案');
  await visible('确认后继续');
  await review.assert(response('choice', '采用新的方案'), 'Selecting an option returns its exact value and advances the queue');
  await review.click(actions + ' .is-primary');
  await dismissed();
  await review.assert(response('queued-confirm', true), 'Confirm sends a boolean response');

  const approval = { source: 'Workspace review extension', command: 'git diff -- src/demo.ts', cwd: '/demo', files: [{ path: 'src/demo.ts', diff: '--- a/src/demo.ts\n+++ b/src/demo.ts\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;' }], scopes: ['once', 'session'] };
  await emit({ id: 'structured-decline', kind: 'confirm', title: '检查命令与文件变更', message: '请确认以下操作', approval });
  await visible('检查命令与文件变更');
  await review.assert(`${text('.pd-approval-card')}?.includes('git diff -- src/demo.ts') && ${text('.pd-approval-diff')}?.includes('+const value = 2;')`, 'Structured approval displays the actual command and file diff');
  await review.fill('.pd-approval-feedback textarea', '先检查，不修改文件');
  await review.evaluate(`${state}.failNext = true`);
  await review.clickText(actions + ' button', '拒绝');
  await review.waitFor(`${text(card + ' [role="alert"]')}?.includes('模拟发送失败')`);
  await review.assert(`document.querySelector('.pd-approval-feedback textarea').value === '先检查，不修改文件'`, 'A failed approval response preserves rejection feedback');
  await review.screenshot('structured-approval-feedback');
  await review.clickText(actions + ' button', '拒绝');
  await dismissed();
  await review.assert(`${state}.responses.some(entry => entry.id === 'structured-decline' && !entry.value.approved && entry.value.feedback === '先检查，不修改文件')`, 'Rejection returns feedback to the requesting extension');
  await emit({ id: 'structured-allow', kind: 'confirm', title: '允许只读检查', approval });
  await visible('允许只读检查');
  await review.fill('.pd-approval-scope select', 'session');
  await review.clickText(actions + ' button', '允许');
  await dismissed();
  await review.assert(`${state}.responses.some(entry => entry.id === 'structured-allow' && entry.value.approved && entry.value.scope === 'session')`, 'Approval returns the explicitly selected authorization scope');

  await emit({ id: 'input', kind: 'input', title: '输入分支名', defaultValue: 'review/default', placeholder: '分支名称' });
  await visible('输入分支名');
  await review.assert(`document.querySelector(${q(card + ' input')}).value === 'review/default'`, 'A text question displays its default value');
  await review.fill(card + ' input', 'review/inline-question');
  await review.key('Enter');
  await dismissed();
  await review.assert(response('input', 'review/inline-question'), 'Enter submits the text question without sending the composer draft');

  await emit({ id: 'editor', kind: 'editor', title: '补充说明', defaultValue: '第一行默认内容\n第二行默认内容' });
  await visible('补充说明');
  await review.assert(`document.querySelector(${q(card + ' textarea')}).value === ${q('第一行默认内容\n第二行默认内容')}`, 'An editor question preserves its multiline default value');
  const editorDraft = '更新后的第一行\n第二行也需要保留';
  await review.fill(card + ' textarea', editorDraft);
  await review.evaluate(`${state}.failNext = true`);
  await review.click(actions + ' [type="submit"]');
  await review.waitFor(`${text(card + ' [role="alert"]')}?.includes('模拟发送失败')`);
  await review.assert(`document.querySelector(${q(card + ' textarea')}).value === ${q(editorDraft)} && !document.querySelector(${q(actions + ' [type="submit"]')}).disabled && !${response('editor', editorDraft)}`, 'A failed response retains the edited text and enables a retry');
  await review.screenshot('extension-question-retry');
  await review.click(actions + ' [type="submit"]');
  await dismissed();
  await review.assert(`${response('editor', editorDraft)} && ${state}.attempts.filter(entry => entry.id === 'editor').length === 2`, 'Retry submits the preserved editor value once successfully');

  for (const kind of ['select', 'input', 'editor', 'confirm']) {
    const id = 'cancel-' + kind;
    await emit({ id, kind, title: '取消测试 ' + kind, options: ['保留'], defaultValue: '取消前输入' });
    await visible('取消测试 ' + kind);
    await cancel();
    await dismissed();
    await review.assert(response(id, kind === 'confirm' ? false : null), `Cancelling ${kind} returns the expected cancellation value`);
  }

  await emit({ id: 'host-closed', kind: 'select', title: '由宿主结束的询问', options: ['无需选择'] });
  await emit({ id: 'after-close', kind: 'confirm', title: '宿主结束后继续' });
  await review.evaluate(`window.__modelReview.emit('onExtensionDialogClosed', 'host-closed')`);
  await visible('宿主结束后继续');
  await review.assert(`!${state}.attempts.some(entry => entry.id === 'host-closed')`, 'A host close advances the queue without inventing a user response');
  await emit({ id: 'host-closed', kind: 'select', title: '迟到的重复询问', options: ['不应再出现'] });
  await cancel();
  await dismissed();

  await emit({ id: 'timeout', kind: 'input', title: '即将过期的询问', defaultValue: '无需提交', timeout: 250 });
  await review.waitFor(response('timeout', null));
  await dismissed();
  await review.assert(`${state}.attempts.filter(entry => entry.id === 'timeout').length === 1`, 'An expired question closes and responds with null once');

  await emit({ id: 'notice', kind: 'notify', title: '背景通知', message: '通知继续以轻提示显示。', timeout: 60000 });
  await review.waitFor(`document.querySelector('.pd-extension-notice')?.textContent.includes('背景通知')`);
  await review.assert(`!document.querySelector(${q(card)}) && !document.querySelector('dialog[open]')`, 'Notifications retain their separate non-modal toast behavior');
  await review.click('.pd-extension-notice button');
  await review.waitFor(response('notice', null));

  await review.viewport(650, 700);
  const longOptions = Array.from({ length: 24 }, (_, index) => `方案 ${index + 1}：` + '这是一段需要完整换行显示的选项说明，便于用户看清含义后再做选择。'.repeat(3));
  await emit({ id: 'long-options', kind: 'select', title: '较多选项仍保留输入空间', message: '滚动选项区域查看其他方案。', options: longOptions });
  await visible('较多选项仍保留输入空间');
  await review.assert(`(() => { const request=document.querySelector(${q(card)}), shell=document.querySelector('.pd-composer-shell'); const box=request.getBoundingClientRect(), input= shell.getBoundingClientRect(); const scrollable=[request,...request.querySelectorAll('*')].some(element => element.clientHeight > 0 && element.scrollHeight > element.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(element).overflowY)); return box.top >= 0 && box.right <= innerWidth + 1 && box.bottom <= input.top + 1 && input.bottom <= innerHeight + 1 && request.scrollWidth <= request.clientWidth + 1 && scrollable; })()`, 'Long choices scroll inside the compact card while the narrow-screen composer stays visible');
  await review.screenshot('extension-question-narrow-long-options');
  await review.clickText(optionLabels, longOptions[longOptions.length - 1]);
  await dismissed();
  await review.assert(response('long-options', longOptions[longOptions.length - 1]), 'The last choice remains reachable through internal scrolling');

  await review.viewport(1440, 1000);

  // The RPC fallback folds option previews into the select title, so a real
  // questionnaire can be several lines. Keep it readable instead of clipping it.
  const longQuestion = '这道题里“同时拥有不同形状的苹果味和桃子味糖果”，你希望按哪种理解给出最终答案？\n\n--- 1. 交叉配对任一即可 预览 ---\n圆苹果 + 星桃子\n或 圆桃子 + 星苹果\n\n--- 2. 同口味同形状 预览 ---\n圆苹果 + 星苹果\n或 圆桃子 + 星桃子';
  const longQuestionOptions = ['1. 交叉配对任一即可（推荐） — 满足题干括号里的任意一种组合即可。', '2. 同口味同形状 — 需要苹果味同时有圆形和五角星形。'];
  await emit({ id: 'long-title', kind: 'select', title: longQuestion, options: longQuestionOptions });
  await visible('你希望按哪种理解给出最终答案');
  await review.assert(`(() => { const heading=document.querySelector(${q(head + ' h2')}), line=parseFloat(getComputedStyle(heading).lineHeight); return getComputedStyle(heading).whiteSpace === 'pre-wrap' && heading.scrollHeight > heading.clientHeight + 1 && heading.clientHeight > line * 2 + 1; })()`, 'A long multi-line question stays readable in the expanded card instead of being clipped to two lines');
  await review.screenshot('extension-question-long-title');
  await review.click(head + ' button[aria-expanded="true"]');
  await review.assert(`(() => { const heading=document.querySelector(${q(head + ' h2')}), line=parseFloat(getComputedStyle(heading).lineHeight); return heading.clientHeight <= line + 1; })()`, 'Collapsing a long question returns to a single summary line');
  await review.click(head + ' button[aria-expanded="false"]');
  await review.clickText(optionLabels, longQuestionOptions[1]);
  await dismissed();
  await review.assert(response('long-title', longQuestionOptions[1]), 'A long question can still be answered')
  await review.viewport(1440, 1000);
  await review.evaluate(`(() => { const modal=document.createElement('dialog'); modal.dataset.extensionReviewModal='true'; modal.style.cssText='width:760px;max-width:90vw;background:#242424;color:white;padding:24px;border:1px solid #555;border-radius:16px'; const heading=document.createElement('h2'); heading.textContent='插件安装确认'; const button=document.createElement('button'); button.textContent='保留插件窗口'; button.dataset.extensionReviewFocus='true'; modal.append(heading,button); document.body.append(modal); modal.showModal(); button.focus(); })()`);
  await emit({ id: 'plugin-input', kind: 'input', title: '插件需要安装选项', defaultValue: '默认配置' });
  await visible('插件需要安装选项');
  await review.waitFor(`Boolean(document.querySelector('dialog[data-extension-review-modal] ${card}'))`);
  await review.assert(`document.querySelectorAll('dialog:modal').length === 1 && document.activeElement === document.querySelector('[data-extension-review-focus]')`, 'An existing plugin modal hosts the question without adding another modal or stealing focus');
  await review.fill(card + ' input', '自定义配置尚未提交');
  await review.screenshot('extension-question-existing-plugin-modal');
  await review.evaluate(`document.querySelector('dialog[data-extension-review-modal]').close()`);
  await review.waitFor(`Boolean(document.querySelector('.pd-composer-wrap ${card}'))`);
  await review.assert(`document.querySelector(${q(card + ' input')}).value === '自定义配置尚未提交' && !${state}.attempts.some(entry => entry.id === 'plugin-input')`, 'Closing the plugin modal restores the question above the composer and retains its text');
  await review.evaluate(`document.querySelector('dialog[data-extension-review-modal]').remove()`);
  await review.evaluate(`(() => { const modal=document.createElement('div'); modal.dataset.extensionReviewCustom='true'; modal.setAttribute('role','dialog'); modal.setAttribute('aria-modal','true'); modal.style.cssText='position:fixed;inset:15%;z-index:100;background:#242424;color:white;padding:24px;border:1px solid #555'; const button=document.createElement('button'); button.textContent='已有设置窗口'; button.dataset.extensionReviewFirst='true'; modal.append(button); document.body.append(modal); })()`);
  await review.waitFor(`Boolean(document.querySelector('[data-extension-review-custom] ${card}'))`);
  await review.click(card + ' input');
  await review.key('Tab');
  await review.key('Tab');
  await review.key('Tab');
  await review.assert(`document.activeElement === document.querySelector('[data-extension-review-first]')`, 'A portaled card respects an existing custom modal focus boundary');
  await review.evaluate(`document.querySelector('[data-extension-review-custom]').remove()`);
  await review.waitFor(`Boolean(document.querySelector('.pd-composer-wrap ${card}'))`);
  await review.click(actions + ' [type="submit"]');
  await dismissed();
  await review.assert(`${response('plugin-input', '自定义配置尚未提交')} && document.querySelector(${q(composer)}).value === ${q(draft + ' 仍能继续输入。')}`, 'The restored question submits correctly and the conversation draft survives all requests');
  await review.record('extension-request-responses', `${state}.responses`);
}

if (process.argv.includes('--check')) {
  let count = 0;
  const compile = expression => { new Function(expression); count++; };
  await extensionRequestsScenarios({
    evaluate: async expression => compile(expression), waitFor: async expression => compile(expression),
    assert: async expression => compile(expression), record: async (_name, expression) => compile(expression),
    click: async () => {}, clickText: async () => {}, fill: async () => {}, key: async () => {},
    settle: async () => {}, screenshot: async () => {}, viewport: async () => {}, reducedMotion: async () => {},
  });
  console.log(`Prepared ${count} extension-request expressions; no browser launched.`);
}
