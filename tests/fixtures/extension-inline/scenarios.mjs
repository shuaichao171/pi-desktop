// zcode-style anchoring: a pending plugin/extension question docks with the
// composer at the conversation bottom; the empty draft stops centering it
// mid-screen like a modal.
// node tests/fixtures/model-settings/run.mjs --run --scenario=../extension-inline/scenarios.mjs
function installEmptyChatFixture() {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const clone = value => structuredClone(value);
  const home = fixture.snapshot.cwd;
  // Fresh empty conversation (new session, no messages).
  Object.assign(fixture.snapshot, { cwd: home, sessionId: 'draft', sessionPath: home + '\\draft.jsonl', status: 'idle', messages: [], activities: [], runs: [], historyTotal: 0, error: null });
  bridge.listWorkspaces = async () => [home];
  bridge.listSessions = async () => [];
  window.__emptyChatReview = {
    ask: request => fixture.emit('onExtensionDialog', request),
    answer: (id, value) => { fixture.calls.push({ name: 'respondExtensionDialog', args: [id, value] }); fixture.emit('onExtensionDialogClosed', id); },
  };
  bridge.respondExtensionDialog = async (id, value) => window.__emptyChatReview.answer(id, value);
  fixture.emitAgent({ ...clone(fixture.snapshot), type: 'ready' });
}

export default async function extensionInlineScenarios(review) {
  const q = JSON.stringify;
  const card = '.pd-extension-request[role="region"]';
  const cardBox = `(() => { const box = document.querySelector(${q(card)})?.getBoundingClientRect(); return box ? { top: Math.round(box.top), bottom: Math.round(box.bottom), centerY: Math.round(box.y + box.height / 2) } : null; })()`;
  const check = (value, message) => { if (value !== true) throw new Error(`Scenario check failed: ${message} (got ${JSON.stringify(value)})`); };
  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-composer-shell > textarea"))');
  await review.viewport(1440, 1000);
  await review.reducedMotion(true);
  await review.reloadWithFixture(`(${installEmptyChatFixture.toString()})()`);
  await review.waitFor(`document.querySelector('.pd-conversation-body')?.classList.contains('is-empty') === true`);

  // Empty draft + pending question: the card docks at the conversation bottom,
  // never hovering at the vertical middle of the screen.
  await review.evaluate(`window.__emptyChatReview.ask({ id: 'probe', kind: 'select', title: '插件询问：选择运行模式', message: '新会话开始时插件提出的问题', options: ['快速模式', '完整模式'] })`);
  await review.waitFor(`Boolean(document.querySelector(${q(card)}))`);
  await review.assert(`document.querySelector('.pd-conversation-body').classList.contains('has-extension-request')`, 'A pending question marks the conversation body');
  const sunk = await review.evaluate(cardBox);
  check(sunk.centerY > 600 && sunk.bottom <= 988, `empty-draft card docks near the bottom (centerY=${sunk?.centerY}, bottom=${sunk?.bottom})`);
  const geometry = await review.evaluate(`(() => { const card2 = document.querySelector(${q(card)}); const input = document.querySelector('.pd-composer-shell'); const box = card2.getBoundingClientRect(); const inputBox = input.getBoundingClientRect(); return { aboveComposer: box.bottom <= inputBox.top + 1, inColumn: Math.abs((box.left + box.right) / 2 - (inputBox.left + inputBox.right) / 2) <= 2 }; })()`);
  check(geometry.aboveComposer, 'the card sits directly above the composer');
  check(geometry.inColumn, 'the card shares the composer column width');
  await review.screenshot('extension-empty-docked');

  // Answering the question releases the draft back to its centered empty state.
  await review.evaluate(`window.__emptyChatReview.answer('probe', '快速模式')`);
  await review.waitFor(`!document.querySelector(${q(card)})`);
  await review.assert(`!document.querySelector('.pd-conversation-body').classList.contains('has-extension-request')`, 'Answering releases the anchored layout');
  await review.screenshot('extension-empty-released');

  // A running conversation keeps the same bottom dock (existing behavior).
  await review.evaluate(`(() => { const fixture = window.__modelReview; Object.assign(fixture.snapshot, { messages: [{ id: 'u1', order: 1, runId: 'r1', role: 'user', status: 'done', text: '帮我检查这个项目的测试', attachments: [] }, { id: 'a1', order: 2, runId: 'r1', role: 'assistant', status: 'done', text: '开始分析。', thinking: '', thinkingTruncated: false }], activities: [], runs: [], historyTotal: 2 }); fixture.emitAgent({ ...structuredClone(fixture.snapshot), type: 'ready' }); })()`);
  await review.waitFor(`!document.querySelector('.pd-conversation-body').classList.contains('is-empty')`);
  await review.evaluate(`window.__emptyChatReview.ask({ id: 'probe2', kind: 'confirm', title: '确认执行修改？', message: '插件准备写入文件' })`);
  await review.waitFor(`Boolean(document.querySelector(${q(card)}))`);
  const live = await review.evaluate(cardBox);
  check(live.centerY > 600 && live.bottom <= 988, `active-conversation card stays docked at the bottom (centerY=${live?.centerY}, bottom=${live?.bottom})`);
  await review.screenshot('extension-active-docked');

  const approval = {
    id: 'agy-command', kind: 'confirm', title: 'Antigravity 请求权限', message: '运行项目测试',
    approval: { source: 'Antigravity', cwd: 'C:\\review\\project', command: 'npm test', scopes: ['once', 'session', 'workspace'], agentOptions: [
      { id: 'once', label: 'Allow once', kind: 'allow_once' },
      { id: 'persist', label: 'Persist to settings', kind: 'allow_always' },
      { id: 'no', label: 'Deny', kind: 'reject_once' },
    ] },
  };
  await review.evaluate(`window.__emptyChatReview.answer('probe2', false)`);
  await review.evaluate(`window.__emptyChatReview.ask(${q(approval)})`);
  await review.waitFor(`document.querySelector('.pd-approval-command')?.textContent === 'npm test'`);
  await review.screenshot('antigravity-command-approval');
  await review.assert(`(() => { const buttons = [...document.querySelectorAll('.pd-agent-approval-options button')]; return !document.querySelector('.pd-agent-approval-options select') && buttons.at(-1).dataset.kind === 'allow_once' && buttons.at(-1).classList.contains('is-primary') && buttons[0].dataset.kind === 'reject_once' && buttons.filter(button => button.textContent === '拒绝').length === 0; })()`, 'Every native option is its own button: allow once is the primary action, the decline sits apart, and no extra decline button duplicates it');
  await review.clickText('.pd-agent-approval-options button', 'Persist to settings');
  await review.assert(`window.__modelReview.calls.some(call => call.name === 'respondExtensionDialog' && call.args[0] === 'agy-command' && call.args[1].optionId === 'persist')`, 'The native ACP option keeps its original ID and answers in one click');
  const claude = {
    id: 'claude-command', kind: 'confirm', title: 'Claude Code 请求权限', message: 'Run the test suite',
    approval: { source: 'Claude Code', cwd: 'C:\\review\\project', command: 'pnpm test -- --reporter=verbose', scopes: ['once', 'session'], agentOptions: [
      { id: 'allow', label: 'Yes', kind: 'allow_once' },
      { id: 'allow_always', label: "Yes, and don't ask again for pnpm test:* commands in C:\\review\\project", kind: 'allow_always' },
      { id: 'reject', label: 'No', kind: 'reject_once' },
    ] },
  };
  await review.evaluate(`window.__emptyChatReview.ask(${q(claude)})`);
  await review.waitFor(`document.querySelector('.pd-approval-command')?.textContent.startsWith('pnpm test')`);
  await review.screenshot('claude-command-approval');
  await review.assert(`document.querySelector('.pd-agent-approval-options [data-kind="allow_always"]').title === '允许，之后同类操作不再询问'`, 'Each option explains its lasting effect in the interface language');
  await review.click('.pd-agent-approval-options .is-primary');
  await review.assert(`window.__modelReview.calls.some(call => call.name === 'respondExtensionDialog' && call.args[0] === 'claude-command' && call.args[1].optionId === 'allow')`, 'The primary button allows once');
  await review.viewport(600, 560);
  await review.evaluate(`window.__emptyChatReview.ask(${q({ ...approval, id: 'agy-remember', approval: { ...approval.approval, command: 'npm test\n'.repeat(30) } })})`);
  await review.waitFor('document.querySelector(".pd-approval-command")?.textContent.length > 200');
  await review.assert(`(() => { const command = document.querySelector('.pd-approval-command'); const rect = command.getBoundingClientRect(); return command.contains(document.elementFromPoint(rect.left + 12, rect.top + 20)); })()`, 'The top of the command preview is visible when the card opens');
  await review.assert(`(() => { const actions = document.querySelector('.pd-agent-approval-options'); const body = actions.closest('.pd-extension-request-body'); return body.scrollHeight > body.clientHeight && actions.getBoundingClientRect().bottom <= body.getBoundingClientRect().bottom + 1; })()`, 'The approval actions remain inside the viewport when the command preview scrolls');
  await review.screenshot('antigravity-command-approval-narrow');
  await review.clickText('.pd-agent-approval-options button', '在此工作区记住这条命令');
  await review.assert(`window.__modelReview.calls.some(call => call.name === 'respondExtensionDialog' && call.args[0] === 'agy-remember' && call.args[1].approved && call.args[1].scope === 'workspace')`, 'Remembering a command is a separate user action');
  await review.evaluate(`window.__emptyChatReview.ask(${q({ ...approval, id: 'agy-decline' })})`);
  await review.waitFor(`document.querySelector('.pd-approval-command')?.textContent === 'npm test'`);
  await review.clickText('.pd-agent-approval-options button', 'Deny');
  await review.assert(`window.__modelReview.calls.some(call => call.name === 'respondExtensionDialog' && call.args[0] === 'agy-decline' && call.args[1].optionId === 'no')`, 'Decline answers with the agent reject option, not a cancelled turn');
}
