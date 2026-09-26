// Prepare only: node tests/fixtures/composer-queue/scenarios.mjs --check
// Run after the renderer build: node tests/fixtures/model-settings/run.mjs --run --scenario=../composer-queue/scenarios.mjs
// Renderer-only queue protocol fixture. It never submits a real model request or edits a project file.

function installQueueHarness() {
  const fixture = window.__modelReview, bridge = window.piDesktop, clone = value => structuredClone(value);
  const state = window.__queueReview = {
    calls: [], queues: new Map(), drafts: new Map(), payloads: new Map(), pendingGets: [], pendingMutations: [],
    failNext: {}, rejectAfterApply: {}, deferNextGet: false, deferNextMutation: null, staleScopeCalls: [],
    originalDraft: '保留主输入框草稿：先检查登录流程。\n不要把它替换成排队指令。',
    editedText: '修改后的排队指令：补充登录失败测试，并保留原附件。',
  };
  state.scopeA = { cwd: fixture.snapshot.cwd, sessionPath: fixture.snapshot.sessionPath + '-queue-a', sessionId: 'same-queue-session' };
  state.scopeB = { ...state.scopeA, sessionPath: fixture.snapshot.sessionPath + '-queue-b' };
  state.scopeC = { ...state.scopeA, sessionPath: fixture.snapshot.sessionPath + '-queue-keyboard' };
  state.key = scope => JSON.stringify([scope?.cwd, scope?.sessionPath, scope?.sessionId]);
  state.draftKey = scope => JSON.stringify([scope?.cwd, scope?.sessionPath]);
  state.visible = node => !!node && !node.closest('[hidden],[inert],[aria-hidden="true"]') && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none';
  state.metadata = attachment => ({ kind: attachment.kind, name: attachment.name, mimeType: attachment.mimeType });
  state.item = (id, text, extra = {}) => ({ id, text, behavior: 'followUp', version: 1, state: 'accepted', ...extra });
  const queueAttachments = [
    { kind: 'text', name: 'queued-context.md', mimeType: 'text/markdown', text: 'SERVER-ONLY queued attachment payload; retain every byte.' },
    { kind: 'image', name: 'queued-screen.png', mimeType: 'image/png', data: 'SERVER-ONLY queued image payload' },
  ];
  state.payloads.set('queue-edit-002', clone(queueAttachments));
  state.originalQueuePayload = JSON.stringify(queueAttachments);
  state.initialItems = [
    state.item('queue-first-001', '第一条：检查登录与认证流程，先阅读相关实现。\n第二行仍保留在完整内容中。'),
    state.item('queue-edit-002', '第二条：根据附件补充回归测试。', { attachments: queueAttachments.map(state.metadata) }),
    state.item('queue-move-003', '第三条：核对移动顺序和立即引导。'),
    state.item('queue-delete-004', '第四条：这是一条稍后删除的排队指令。'),
    state.item('queue-recover-005', '重启前的指令：确认后才重新排入。', { state: 'recovered', message: '上次运行的消费状态不确定；请确认恢复。' }),
    state.item('queue-tail-006', '最后一条：检查深浅色主题与窄窗口布局。'),
  ];
  state.queues.set(state.key(state.scopeA), { scope: clone(state.scopeA), version: 1, paused: false, items: clone(state.initialItems) });
  state.queues.set(state.key(state.scopeB), { scope: clone(state.scopeB), version: 1, paused: false, items: [state.item('queue-other-001', '另一会话独有的排队指令')] });
  state.queues.set(state.key(state.scopeC), { scope: clone(state.scopeC), version: 1, paused: false, items: [state.item('queue-keyboard-001', '保留此项以操作默认发送偏好')] });
  const draftAttachment = { kind: 'text', name: 'draft-notes.txt', mimeType: 'text/plain', text: 'Original unsent draft attachment payload.' };
  state.stored = new Map([['draft-attachment-001', draftAttachment]]);
  const storedRef = (id, attachment) => ({ id, version: 1, ...state.metadata(attachment), size: (attachment.text ?? attachment.data ?? '').length });
  state.drafts.set(state.draftKey(state.scopeA), { version: 1, text: state.originalDraft, attachments: [storedRef('draft-attachment-001', draftAttachment)], missing: [] });
  state.drafts.set(state.draftKey(state.scopeB), { version: 0, text: '另一会话草稿', attachments: [], missing: [] });
  state.log = (name, request) => { const call = { name, request: clone(request) }; state.calls.push(call); fixture.calls.push({ name: 'queueFixture.' + name, args: [clone(request)] }); };
  state.currentQueue = () => state.queues.get(state.key(state.active));
  state.snapshot = scope => clone(state.queues.get(state.key(scope)));
  state.checkScope = scope => {
    if (!scope || typeof scope.cwd !== 'string' || !Object.hasOwn(scope, 'sessionPath') || typeof scope.sessionId !== 'string') throw new Error('Queue scope is required');
    const queue = state.queues.get(state.key(scope));
    if (!queue) throw new Error('Unknown queue scope');
    return queue;
  };
  state.publish = () => {
    const queue = state.currentQueue();
    fixture.snapshot.queuedMessages = clone(queue.items);
    fixture.snapshot.queuedCount = queue.items.length;
    fixture.emitAgent({ type: 'queue', count: queue.items.length, items: clone(queue.items) });
  };
  state.ready = (scope = state.scopeA, status = 'busy') => {
    state.active = clone(scope);
    const queue = state.checkScope(scope), now = Date.now(), running = status === 'busy';
    const run = { id: 'queue-fixture-run', startedAt: now - 8000, finishedAt: running ? null : now, status: running ? 'running' : 'completed' };
    const messages = [
      { id: 'queue-fixture-user', order: 0, role: 'user', status: 'done', runId: run.id, text: '请检查登录流程，并按队列继续处理。' },
      { id: 'queue-fixture-answer', order: 1, role: 'assistant', status: running ? 'streaming' : 'done', runId: run.id, text: '正在检查相关实现。排队指令会在合适的时机继续处理。' },
    ];
    Object.assign(fixture.snapshot, clone(scope), { messages, activities: [], runs: [run], status, error: null, historyTotal: 2, fileChanges: [], queuedCount: queue.items.length, queuedMessages: clone(queue.items) });
    fixture.emitAgent({ ...clone(fixture.snapshot), type: 'ready' });
    fixture.emitAgent({ type: 'status', status });
    state.publish();
  };
  state.setStatus = status => { fixture.snapshot.status = status; fixture.emitAgent({ type: 'status', status }); };
  state.resetQueue = (items = state.initialItems, paused = false) => {
    const queue = state.currentQueue(), previous = new Map(queue.items.map(item => [item.id, item.version]));
    queue.items = clone(items).map(item => ({ ...item, version: Math.max(item.version, previous.get(item.id) ?? 0, queue.version) + 1 }));
    queue.paused = paused; queue.version++; state.publish();
  };
  state.consume = id => {
    const queue = state.currentQueue();
    if (!queue.items.some(item => item.id === id)) throw new Error('Cannot consume a missing fixture item');
    queue.items = queue.items.filter(item => item.id !== id); queue.version++; state.publish();
  };
  state.releaseGet = index => { const pending = state.pendingGets.splice(index ?? 0, 1)[0]; if (!pending) throw new Error('No deferred queue read'); pending.resolve(clone(pending.snapshot)); };
  state.releaseMutation = index => { const pending = state.pendingMutations.splice(index ?? 0, 1)[0]; if (!pending) throw new Error('No deferred queue mutation'); pending.resolve(clone(pending.snapshot)); };
  bridge.getInputQueue = async scope => {
    state.log('get', scope); const queue = state.checkScope(scope), snapshot = clone(queue);
    if (state.deferNextGet) { state.deferNextGet = false; return new Promise(resolve => state.pendingGets.push({ scope: clone(scope), snapshot, resolve })); }
    return snapshot;
  };
  bridge.mutateInputQueue = async request => {
    state.log('mutate', request);
    const queue = state.checkScope(request.scope);
    if (state.key(request.scope) !== state.key(state.active)) { state.staleScopeCalls.push(clone(request)); throw new Error('Active queue scope changed'); }
    if (request.expectedVersion !== queue.version) throw new Error('队列已更新，请重试。');
    if (state.failNext[request.action]) { state.failNext[request.action]--; throw new Error('模拟保存失败，请重试。'); }
    const item = queue.items.find(entry => entry.id === request.id), action = request.action;
    if (action === 'pause' || action === 'resume') queue.paused = action === 'pause';
    else {
      if (!item) throw new Error('该输入已消费或不存在。');
      if (action === 'beginEdit') {
        if (item.state !== 'accepted' || queue.items.some(entry => entry.state === 'editing')) throw new Error('无法开始编辑此输入。');
        item.state = 'editing';
      } else if (action === 'cancelEdit') {
        if (item.state !== 'editing') throw new Error('Cannot cancel an input without an editing hold');
        item.state = 'accepted';
      }
      else if (action === 'edit') {
        if (item.state !== 'editing') throw new Error('编辑锁已失效。');
        if (typeof request.text !== 'string' || !request.text.trim()) throw new Error('排队文字不能为空。');
        if ('attachments' in request) throw new Error('Queue metadata must not replace stored attachment payloads');
        item.text = request.text; item.state = 'accepted';
      } else if (item.state === 'editing') throw new Error('该输入正在编辑。');
      else if (action === 'remove') queue.items = queue.items.filter(entry => entry.id !== item.id);
      else if (action === 'confirm') {
        if (item.state !== 'recovered') throw new Error('该输入无需恢复。');
        item.state = 'accepted'; delete item.message;
      } else if (item.state === 'recovered') throw new Error('请先确认恢复。');
      else if (action === 'steer') {
        if (item.behavior !== 'followUp') throw new Error('该输入已经是引导。');
        item.behavior = 'steer';
        queue.items = [...queue.items.filter(entry => entry.id !== item.id), item].sort((a, b) => a.behavior === b.behavior ? 0 : a.behavior === 'steer' ? -1 : 1);
      } else if (action === 'move') {
        const before = request.beforeId == null ? null : queue.items.find(entry => entry.id === request.beforeId);
        if (before && (before.behavior !== item.behavior || before.state !== 'accepted' || before.id === item.id)) throw new Error('只能移动同类待发送项。');
        const next = queue.items.filter(entry => entry.id !== item.id);
        const index = before ? next.indexOf(before) : next.length; next.splice(index, 0, item); queue.items = next;
      } else throw new Error('Unsupported queue mutation: ' + action);
      item.version++;
    }
    queue.version++; const snapshot = clone(queue); state.publish();
    if (state.rejectAfterApply[action]) { state.rejectAfterApply[action]--; throw new Error('模拟操作已应用但响应丢失。'); }
    if (state.deferNextMutation === action) { state.deferNextMutation = null; return new Promise(resolve => state.pendingMutations.push({ scope: clone(request.scope), snapshot, resolve })); }
    return snapshot;
  };
  bridge.getInputDraft = async scope => { state.log('getDraft', scope); return clone(state.drafts.get(state.draftKey(scope)) ?? { version: 0, text: '', attachments: [], missing: [] }); };
  bridge.readInputAttachment = async (scope, id) => { state.log('readAttachment', { scope, id }); if (!state.stored.has(id)) throw new Error('Missing fixture attachment'); return clone(state.stored.get(id)); };
  bridge.putInputAttachment = async (scope, attachment) => { state.log('putAttachment', { scope, attachment }); const id = 'draft-put-' + state.stored.size; state.stored.set(id, clone(attachment)); return storedRef(id, attachment); };
  bridge.saveInputDraft = async request => {
    state.log('saveDraft', request);
    const draft = { version: request.expectedVersion + 1, text: request.text, attachments: request.attachmentIds.map(id => storedRef(id, state.stored.get(id))), missing: [] };
    state.drafts.set(state.draftKey(request), draft); return clone(draft);
  };
  bridge.submitInput = async request => {
    state.log('submit', request);
    if (!state.allowSubmit) throw new Error('Queue editing must not submit the unrelated main draft');
    if (request.sessionId !== state.active.sessionId) throw new Error('Input session changed');
    if (fixture.snapshot.status === 'busy') {
      const queue = state.currentQueue();
      queue.items.push(state.item(request.id, request.text, { behavior: request.behavior ?? 'followUp', attachments: request.attachments?.map(state.metadata) ?? [] }));
      queue.items.sort((a, b) => a.behavior === b.behavior ? 0 : a.behavior === 'steer' ? -1 : 1); queue.version++; state.publish();
    }
    return { id: request.id, state: 'accepted' };
  };
  bridge.prompt = async (...args) => { state.log('prompt', args); throw new Error('Unexpected regular prompt in queue review'); };
  bridge.abort = async () => { state.log('abort', {}); state.setStatus('idle'); };
  bridge.updateQueuedMessage = async (...args) => { state.log('legacyMutation', args); throw new Error('Scoped queue API must be used'); };
  bridge.switchSession = async path => { state.ready(path === state.scopeA.sessionPath ? state.scopeA : state.scopeB); };
  state.ready();
}

async function clickVisibleButton(review, labelPattern, within = 'body') {
  await review.evaluate(`(() => {
    document.querySelectorAll('[data-queue-review-target]').forEach(node => node.removeAttribute('data-queue-review-target'));
    const root = document.querySelector(${JSON.stringify(within)});
    const pattern = new RegExp(${JSON.stringify(labelPattern)}, 'i');
    const button = [...(root?.querySelectorAll('button,[role="menuitem"]') ?? [])].find(node => window.__queueReview.visible(node) && pattern.test([node.textContent.trim(), node.getAttribute('aria-label') ?? '', node.title].join(' ')));
    if (!button) throw new Error('Queue action not found: ' + ${JSON.stringify(labelPattern)});
    button.setAttribute('data-queue-review-target', 'true');
  })()`);
  await review.click('[data-queue-review-target="true"]');
}

export default async function composerQueueScenarios(review) {
  const row = id => `.pd-composer-queue-item[data-queue-id="${id}"]`;
  const editor = '.pd-queue-composer-edit textarea';
  const q = 'window.__queueReview';
  const openMenu = async id => { await review.click(`${row(id)} [aria-label="更多操作"]`); };
  const beginEdit = async id => { await openMenu(id); await clickVisibleButton(review, '^编辑(?:消息)?(?: |$)'); await review.waitFor(`Boolean(document.querySelector('${editor}'))`); };
  const assertDraft = async message => {
    await review.waitFor(`${q}.mainTextarea?.isConnected && ${q}.visible(${q}.mainTextarea)`);
    await review.assert(`${q}.mainTextarea.value === ${q}.originalDraft && [...document.querySelectorAll('.pd-composer-attachment')].some(node => ${q}.visible(node) && node.textContent.includes('draft-notes.txt'))`, message);
  };
  await review.waitFor('window.__modelReview?.ready === true');
  await review.reducedMotion(true);
  await review.viewport(1440, 1000);
  await review.evaluate(`(${installQueueHarness.toString()})()`);
  await review.waitFor(`document.querySelectorAll('.pd-composer-queue-item').length === 6 && document.querySelector('.pd-composer-shell textarea')?.value === ${q}.originalDraft`);
  await review.evaluate(`${q}.mainTextarea=document.querySelector('.pd-composer-shell textarea'); ${q}.mainDraftBefore=JSON.stringify(${q}.drafts.get(${q}.draftKey(${q}.scopeA)));`);
  await review.assert(`![...document.querySelectorAll('.pd-composer-queue-item textarea, .pd-composer-queue-item details')].some(${q}.visible) && document.querySelectorAll('.pd-composer-queue-item').length === ${q}.initialItems.length`, 'All queue entries use compact rows without an inline editor or per-row disclosure');
  await review.assert(`${q}.calls.filter(call=>call.name==='get').every(call=>${q}.key(call.request)===${q}.key(${q}.scopeA))`, 'Initial queue reads include workspace, session path, and session ID');
  await review.screenshot('queue-dark-1440');
  await review.click(`${row('queue-first-001')} .pd-composer-queue-text`);
  await review.waitFor('document.querySelector(".pd-queue-details-dialog")?.open === true');
  await review.assert(`document.querySelector('.pd-queue-details-dialog').textContent.includes('第二行仍保留在完整内容中。')`, 'Opening a compact row reveals the full multi-line message');
  await review.key('Escape');
  await review.waitFor('!document.querySelector(".pd-queue-details-dialog")');
  await review.assert(`document.activeElement === document.querySelector('${row('queue-first-001')} .pd-composer-queue-text') && !${q}.calls.some(call=>call.name==='abort')`, 'Closing message details returns focus to the row without stopping the busy task');
  await openMenu('queue-first-001');
  await review.key('End');
  await review.assert('document.activeElement?.getAttribute("role") === "menuitemcheckbox"', 'End reaches the queue default setting in the actions menu');
  await review.key('Home');
  await review.assert('document.activeElement?.textContent.trim() === "编辑"', 'Home returns to the first enabled queue action');
  await review.key('Escape');
  await review.assert(`document.activeElement === document.querySelector('${row('queue-first-001')} [aria-label="更多操作"]') && !document.querySelector('.pd-queue-menu')`, 'Escape closes the actions menu and restores its trigger focus');

  // Editing holds the existing entry, preserving its position and stored attachment payloads.
  await beginEdit('queue-edit-002');
  await review.waitFor(`${q}.currentQueue().items.find(item=>item.id==='queue-edit-002').state === 'editing'`);
  await review.assert(`document.querySelector('${editor}').value === ${q}.initialItems[1].text && !document.querySelector('${editor}').closest('.pd-composer-queue-item') && !${q}.visible(${q}.mainTextarea)`, 'Edit opens in the main composer area and temporarily hides the untouched regular draft');
  await review.assert(`document.querySelector('.pd-queue-composer-edit').textContent.includes('queued-context.md') && document.querySelector('.pd-queue-composer-edit').textContent.includes('queued-screen.png') && JSON.stringify(${q}.payloads.get('queue-edit-002')) === ${q}.originalQueuePayload`, 'Queued attachments remain visible as labels and retain their server-side payloads');
  await review.assert(`document.querySelector('${row('queue-edit-002')}')?.dataset.state === 'editing' && !document.querySelector('${row('queue-edit-002')} .is-steer') && [...document.querySelectorAll('${row('queue-edit-002')} .pd-composer-queue-action')].some(button=>button.disabled && /删除|移除/.test(button.getAttribute('aria-label') ?? ''))`, 'The held row exposes its editing state and disables steering or deleting that entry');
  await review.evaluate(`${q}.editIndex=${q}.currentQueue().items.findIndex(item=>item.id==='queue-edit-002'); ${q}.setStatus('idle');`);
  await review.assert(`document.querySelector('${editor}') !== null && ${q}.currentQueue().items[${q}.editIndex].state === 'editing'`, 'Finishing a run does not discard or send the entry held for editing');
  await review.fill(editor, '修改后的排队指令：补充登录失败测试，并保留原附件。');
  await review.screenshot('queue-edit-dark-1440');
  await review.key('Enter');
  await review.waitFor(`!document.querySelector('${editor}') && ${q}.currentQueue().items[${q}.editIndex].text === ${q}.editedText`);
  await review.assert(`${q}.currentQueue().items[${q}.editIndex].id === 'queue-edit-002' && ${q}.currentQueue().items[${q}.editIndex].state === 'accepted' && JSON.stringify(${q}.payloads.get('queue-edit-002')) === ${q}.originalQueuePayload && !${q}.calls.some(call=>['submit','prompt','legacyMutation'].includes(call.name))`, 'Enter saves in place through the scoped edit API without submitting a new prompt or replacing attachments');
  await assertDraft('Saving a queue edit restores the original unsent draft and its attachment');

  await beginEdit('queue-edit-002');
  await review.fill(editor, '取消后不能写入队列');
  await review.key('Enter', { shift: true });
  await review.assert(`document.querySelector('${editor}').value.includes(String.fromCharCode(10)) && ${q}.currentQueue().items.find(item=>item.id==='queue-edit-002').state === 'editing'`, 'Shift+Enter inserts a line break while retaining the editing lock');
  await review.key('Escape');
  await review.waitFor(`!document.querySelector('${editor}') && ${q}.currentQueue().items.find(item=>item.id==='queue-edit-002').state === 'accepted'`);
  await review.assert(`${q}.currentQueue().items.find(item=>item.id==='queue-edit-002').text === ${q}.editedText`, 'Escape cancels the edit without changing the queued text');
  await assertDraft('Canceling a queue edit restores the independent composer draft');

  // Escape belongs to the entire queue editor, including its action buttons.
  await review.evaluate(`${q}.setStatus('busy')`);
  await beginEdit('queue-edit-002');
  await review.fill(editor, '取消按钮聚焦时也必须取消编辑');
  await review.evaluate(`[...document.querySelectorAll('.pd-queue-composer-edit button')].find(button=>button.textContent.trim()==='取消').focus()`);
  await review.assert(`document.activeElement?.textContent.trim() === '取消'`, 'The queue editor cancel button receives keyboard focus');
  await review.key('Escape');
  await review.waitFor(`!document.querySelector('${editor}') && ${q}.currentQueue().items.find(item=>item.id==='queue-edit-002').state === 'accepted'`);
  await review.assert(`${q}.currentQueue().items.find(item=>item.id==='queue-edit-002').text === ${q}.editedText && ${q}.calls.filter(call=>call.name==='abort').length === 0 && window.__modelReview.snapshot.status === 'busy'`, 'Escape from a focused cancel button releases the edit without aborting the active task');
  await assertDraft('Cancel-button Escape restores the original draft and attachment');

  // Saving failures leave the held text editable; the next save retries the same entry.
  await beginEdit('queue-edit-002');
  await review.fill(editor, '保存失败后重试的文本');
  await review.evaluate(`${q}.failNext.edit=1`);
  await review.key('Enter');
  await review.waitFor(`document.querySelector('${editor}')?.value === '保存失败后重试的文本' && [...document.querySelectorAll('[role="alert"]')].some(node=>node.textContent.includes('模拟保存失败'))`);
  await review.assert(`${q}.currentQueue().items.find(item=>item.id==='queue-edit-002').state === 'editing' && !${q}.visible(${q}.mainTextarea)`, 'A failed save preserves the edit and keeps its consumption lock');
  await clickVisibleButton(review, '^保存到队列(?: |$)', '.pd-queue-composer-edit');
  await review.waitFor(`!document.querySelector('${editor}') && ${q}.currentQueue().items.find(item=>item.id==='queue-edit-002').text === '保存失败后重试的文本'`);
  await assertDraft('Retrying a failed edit still preserves the original draft and attachment');

  // A lost cancel response can leave the editor open after the authoritative hold is gone.
  await beginEdit('queue-edit-002');
  await review.fill(editor, '取消响应丢失时保留以供复制的文本');
  await review.evaluate(`${q}.rejectAfterApply.cancelEdit=1`);
  await clickVisibleButton(review, '^取消(?: |$)', '.pd-queue-composer-edit');
  await review.waitFor(`document.querySelector('${editor}')?.value === '取消响应丢失时保留以供复制的文本' && document.querySelector('${row('queue-edit-002')}')?.dataset.state === 'accepted' && [...document.querySelectorAll('[role="alert"]')].some(node=>node.textContent.includes('模拟操作已应用但响应丢失'))`);
  await review.assert(`[...document.querySelectorAll('.pd-queue-composer-edit button')].some(button=>button.textContent.trim()==='保存到队列' && button.disabled)`, 'An editor whose hold has already been released cannot save stale text');
  await review.evaluate(`${q}.cancelCallsAfterLostResponse=${q}.calls.filter(call=>call.name==='mutate' && call.request.action==='cancelEdit').length; [...document.querySelectorAll('.pd-queue-composer-edit button')].find(button=>button.textContent.trim()==='取消').focus()`);
  await review.key('Escape');
  await review.waitFor(`!document.querySelector('${editor}')`);
  await review.assert(`${q}.calls.filter(call=>call.name==='mutate' && call.request.action==='cancelEdit').length === ${q}.cancelCallsAfterLostResponse && ${q}.calls.filter(call=>call.name==='abort').length === 0 && ${q}.currentQueue().items.find(item=>item.id==='queue-edit-002').text === '保存失败后重试的文本'`, 'Escape locally dismisses the released editor without canceling an accepted row again or aborting the task');
  await assertDraft('Dismissing the editor after a lost cancel response restores the unrelated draft and attachment');

  // Menus provide a keyboard-accessible reorder alternative to dragging.
  await openMenu('queue-move-003');
  await clickVisibleButton(review, '^上移(?:输入|消息)?(?: |$)');
  await review.waitFor(`${q}.currentQueue().items.findIndex(item=>item.id==='queue-move-003') < ${q}.currentQueue().items.findIndex(item=>item.id==='queue-edit-002')`);
  await review.assert(`JSON.stringify([...document.querySelectorAll('.pd-composer-queue-item')].map(node=>node.dataset.queueId)) === JSON.stringify(${q}.currentQueue().items.map(item=>item.id))`, 'Reordering changes the displayed order to match the authoritative queue');
  await review.evaluate(`(() => {const handle=document.querySelector('${row('queue-tail-006')} [draggable="true"]'); if(!handle) throw new Error('Queue drag handle missing'); ${q}.dragTransfer=new DataTransfer(); handle.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:${q}.dragTransfer}));})()`);
  await review.waitFor(`document.querySelector('${row('queue-tail-006')}')?.classList.contains('is-dragging')`);
  await review.evaluate(`(() => {const target=document.querySelector('${row('queue-first-001')}'),box=target.getBoundingClientRect();target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:${q}.dragTransfer,clientY:box.top+2}));})()`);
  await review.waitFor(`document.querySelector('${row('queue-first-001')}')?.classList.contains('drop-before')`);
  await review.evaluate(`document.querySelector('${row('queue-first-001')}').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:${q}.dragTransfer}));`);
  await review.waitFor(`${q}.currentQueue().items[0].id === 'queue-tail-006'`);
  await review.assert(`document.querySelector('.pd-composer-queue-item').dataset.queueId === 'queue-tail-006'`, 'Dragging by the handle updates both queue order and rendered rows');
  await review.evaluate(`document.querySelector('${row('queue-tail-006')} .pd-queue-drag').focus()`);
  await review.key('ArrowDown');
  await review.waitFor(`${q}.currentQueue().items[1].id === 'queue-tail-006'`);
  await review.assert(`document.activeElement?.closest('[data-queue-id]')?.dataset.queueId === 'queue-tail-006'`, 'The drag handle also supports keyboard reordering without losing the moved row focus');
  await review.evaluate(`${q}.setStatus('busy')`);
  await review.click(`${row('queue-move-003')} .pd-composer-queue-action.is-steer`);
  await review.waitFor(`${q}.currentQueue().items.find(item=>item.id==='queue-move-003').behavior === 'steer'`);
  await review.assert(`!${q}.calls.some(call=>call.name==='abort') && ${q}.currentQueue().items.filter(item=>item.id==='queue-move-003').length === 1`, 'Steering an entry keeps its identity and does not interrupt the current task');
  await review.click(`${row('queue-delete-004')} .pd-composer-queue-action[aria-label="删除排队消息"]`);
  await review.waitFor(`!document.querySelector('${row('queue-delete-004')}')`);
  await review.assert(`!${q}.currentQueue().items.some(item=>item.id==='queue-delete-004')`, 'Deleting an entry removes exactly the requested queue item');

  // Recovery is explicit; the separate pause flag never silently confirms recovered items.
  await review.assert(`${q}.currentQueue().items.find(item=>item.id==='queue-recover-005').state === 'recovered'`, 'Recovered instructions remain unsent until explicitly confirmed');
  await review.screenshot('queue-recovered-dark-1440');
  await openMenu('queue-recover-005');
  await review.assert('[...document.querySelectorAll(".pd-queue-menu button")].some(button=>button.textContent.trim()==="编辑" && button.disabled)', 'Recovered input cannot be edited before the user confirms its recovery');
  await review.key('Escape');
  await review.click(`${row('queue-recover-005')} .pd-composer-queue-action.is-steer`);
  await review.waitFor(`${q}.currentQueue().items.find(item=>item.id==='queue-recover-005').state === 'accepted'`);
  await openMenu('queue-first-001');
  await clickVisibleButton(review, '暂停后续|暂停队列', '.pd-queue-menu');
  await review.waitFor(`${q}.currentQueue().paused === true`);
  await review.assert(`window.__modelReview.snapshot.status === 'busy' && !${q}.calls.some(call=>call.name==='abort')`, 'Pausing later input keeps the active model run alive');
  await clickVisibleButton(review, '恢复后续|恢复队列|继续队列|继续发送|^继续(?: |$)', '.pd-composer-queue');
  await review.waitFor(`${q}.currentQueue().paused === false`);

  // A stale read must not resurrect a row after a newer successful mutation.
  await review.evaluate(`${q}.deferNextGet=true; ${q}.publish();`);
  await review.waitFor(`${q}.pendingGets.length === 1`);
  await review.click(`${row('queue-tail-006')} .pd-composer-queue-action[aria-label="删除排队消息"]`);
  await review.waitFor(`!document.querySelector('${row('queue-tail-006')}')`);
  await review.evaluate(`${q}.releaseGet()`);
  await review.settle();
  await review.assert(`!document.querySelector('${row('queue-tail-006')}') && !${q}.currentQueue().items.some(item=>item.id==='queue-tail-006')`, 'A delayed older queue snapshot cannot restore an entry that was just removed');
  await review.evaluate(`${q}.versionAfterLateRead=${q}.currentQueue().version`);
  await openMenu('queue-first-001');
  await clickVisibleButton(review, '暂停后续|暂停队列', '.pd-queue-menu');
  await review.waitFor(`${q}.currentQueue().paused === true`);
  await review.assert(`${q}.calls.filter(call=>call.name==='mutate').at(-1).request.expectedVersion === ${q}.versionAfterLateRead`, 'The next mutation still uses the newest queue version after an older read resolves');
  await clickVisibleButton(review, '继续发送|继续队列|恢复队列', '.pd-composer-queue');
  await review.waitFor(`${q}.currentQueue().paused === false`);

  // A session ID alone is insufficient: isolate the queue and draft by path as well.
  await review.evaluate(`${q}.deferNextGet=true; ${q}.publish();`);
  await review.waitFor(`${q}.pendingGets.length === 1`);
  await review.evaluate(`${q}.ready(${q}.scopeB)`);
  await review.waitFor(`document.querySelector('${row('queue-other-001')}') !== null && !document.querySelector('${row('queue-first-001')}')`);
  await review.evaluate(`${q}.releaseGet()`);
  await review.settle();
  await review.assert(`document.querySelectorAll('.pd-composer-queue-item').length === 1 && document.querySelector('${row('queue-other-001')}') !== null && !document.querySelector('${editor}') && document.querySelector('.pd-composer-shell textarea')?.value === '另一会话草稿'`, 'A late read from the old path cannot overwrite another session using the same session ID');
  await review.evaluate(`${q}.ready(${q}.scopeA); ${q}.deferNextMutation='beginEdit';`);
  await review.waitFor(`document.querySelector('${row('queue-edit-002')}') !== null`);
  await openMenu('queue-edit-002');
  await clickVisibleButton(review, '^编辑(?:消息)?(?: |$)');
  await review.waitFor(`${q}.pendingMutations.length === 1`);
  await review.evaluate(`${q}.ready(${q}.scopeB); ${q}.releaseMutation()`);
  await review.waitFor(`document.querySelector('${row('queue-other-001')}') !== null && !document.querySelector('${editor}')`);
  await review.assert(`${q}.currentQueue().items[0].state === 'accepted'`, 'A delayed begin-edit response from a previous path cannot open an editor or hold input in the current path');
  await review.evaluate(`${q}.ready(${q}.scopeA); ${q}.resetQueue();`);
  await review.waitFor(`document.querySelector('${row('queue-edit-002')}') !== null && document.querySelector('.pd-composer-shell textarea')?.value === ${q}.originalDraft`);
  await review.evaluate(`${q}.mainTextarea=document.querySelector('.pd-composer-shell textarea'); void 0`);
  await beginEdit('queue-edit-002');
  await review.fill(editor, '跨会话时必须丢弃的编辑输入');
  await review.evaluate(`${q}.ready(${q}.scopeB)`);
  await review.waitFor(`!document.querySelector('${editor}') && document.querySelector('${row('queue-other-001')}') !== null`);
  await review.assert(`${q}.currentQueue().items.length === 1 && ${q}.currentQueue().items[0].text === '另一会话独有的排队指令'`, 'Switching paths closes the old editing surface without mutating the new session queue');

  // Canceling an abandoned hold invalidates the unsaved edit cached before a session switch.
  await review.evaluate(`${q}.ready(${q}.scopeA)`);
  await review.waitFor(`document.querySelector('${row('queue-edit-002')}')?.dataset.state === 'editing' && !document.querySelector('${editor}')`);
  await review.evaluate(`${q}.abandonedEditVersion=${q}.currentQueue().items.find(item=>item.id==='queue-edit-002').version; ${q}.mainTextarea=document.querySelector('.pd-composer-shell > textarea'); void 0`);
  await openMenu('queue-edit-002');
  await clickVisibleButton(review, '取消编辑，恢复排队', '.pd-queue-menu');
  await review.waitFor(`document.querySelector('${row('queue-edit-002')}')?.dataset.state === 'accepted'`);
  await review.assert(`${q}.currentQueue().items.find(item=>item.id==='queue-edit-002').version > ${q}.abandonedEditVersion`, 'Canceling an abandoned hold advances the authoritative item version');
  await review.evaluate(`${q}.versionAfterMenuCancel=${q}.currentQueue().items.find(item=>item.id==='queue-edit-002').version`);
  await beginEdit('queue-edit-002');
  await review.assert(`document.querySelector('${editor}').value === ${q}.currentQueue().items.find(item=>item.id==='queue-edit-002').text && document.querySelector('${editor}').value !== '跨会话时必须丢弃的编辑输入' && ${q}.currentQueue().items.find(item=>item.id==='queue-edit-002').version > ${q}.versionAfterMenuCancel`, 'Reopening an edit after its hold was canceled starts from queued text instead of resurrecting a stale unsaved cache');
  await review.key('Escape');
  await review.waitFor(`!document.querySelector('${editor}')`);
  await assertDraft('Canceling the new edit after returning to the session preserves its original draft');

  // Consumption can remove the element that opened details or the actions menu.
  await review.evaluate(`${q}.resetQueue([...${q}.currentQueue().items, ${q}.item('queue-consume-details','查看详情期间消费的排队指令'), ${q}.item('queue-consume-menu','打开菜单期间消费的排队指令')])`);
  await review.waitFor(`Boolean(document.querySelector('${row('queue-consume-details')}'))`);
  await review.click(`${row('queue-consume-details')} .pd-composer-queue-text`);
  await review.waitFor(`document.querySelector('.pd-queue-details-dialog')?.open === true`);
  await review.evaluate(`${q}.consume('queue-consume-details')`);
  await review.waitFor(`!document.querySelector('.pd-queue-details-dialog') && !document.querySelector('${row('queue-consume-details')}') && document.activeElement !== document.body && ${q}.visible(document.activeElement)`);
  await review.assert(`document.activeElement === document.querySelector('.pd-composer-queue-item .pd-composer-queue-text')`, 'Consuming the row shown in details closes its dialog and returns keyboard focus to an existing queue row');
  await openMenu('queue-consume-menu');
  await review.waitFor(`Boolean(document.querySelector('.pd-queue-menu'))`);
  await review.evaluate(`${q}.consume('queue-consume-menu')`);
  await review.waitFor(`!document.querySelector('.pd-queue-menu') && !document.querySelector('${row('queue-consume-menu')}') && document.activeElement !== document.body && ${q}.visible(document.activeElement)`);
  await review.assert(`document.activeElement === document.querySelector('.pd-composer-queue-item .pd-composer-queue-text') && ${q}.calls.filter(call=>call.name==='abort').length === 0`, 'Consuming a row with its menu open closes the menu and restores focus without interrupting the task');

  // The default is a submit preference, distinct from pausing the existing queue.
  await review.evaluate(`${q}.allowSubmit=true; ${q}.ready(${q}.scopeC);`);
  await review.waitFor(`document.querySelector('${row('queue-keyboard-001')}') !== null && document.querySelector('.pd-composer-shell > textarea')?.value === ''`);
  await openMenu('queue-keyboard-001');
  await clickVisibleButton(review, '关闭默认排队', '.pd-queue-menu');
  await review.assert(`localStorage.getItem('pi-desktop:busy-input-behavior') === 'steer' && ${q}.currentQueue().paused === false`, 'Turning off default queueing changes the next-send preference without pausing existing input');
  for (const [text, modifiers, behavior] of [
    ['快捷键：Enter 默认引导', {}, 'steer'],
    ['快捷键：Ctrl+Enter 反向排队', { ctrl: true }, 'followUp'],
  ]) {
    await review.fill('.pd-composer-shell > textarea', text);
    await review.key('Enter', modifiers);
    await review.waitFor(`${q}.calls.some(call=>call.name==='submit' && call.request.text===${JSON.stringify(text)})`);
    await review.assert(`${q}.calls.filter(call=>call.name==='submit').at(-1).request.behavior === ${JSON.stringify(behavior)}`, 'Busy submit follows the selected default or its alternate shortcut: ' + text);
  }
  await openMenu('queue-keyboard-001');
  await clickVisibleButton(review, '启用默认排队', '.pd-queue-menu');
  for (const [text, modifiers, behavior] of [
    ['快捷键：Enter 默认排队', {}, 'followUp'],
    ['快捷键：Ctrl+Enter 反向引导', { ctrl: true }, 'steer'],
  ]) {
    await review.fill('.pd-composer-shell > textarea', text);
    await review.key('Enter', modifiers);
    await review.waitFor(`${q}.calls.some(call=>call.name==='submit' && call.request.text===${JSON.stringify(text)})`);
    await review.assert(`${q}.calls.filter(call=>call.name==='submit').at(-1).request.behavior === ${JSON.stringify(behavior)}`, 'Queue-default submit and its alternate shortcut stay distinct: ' + text);
  }
  await review.fill('.pd-composer-shell > textarea', '快捷键：主发送按钮遵循默认排队');
  await review.click('.pd-send-button');
  await review.waitFor(`${q}.calls.some(call=>call.name==='submit' && call.request.text==='快捷键：主发送按钮遵循默认排队')`);
  await review.assert(`${q}.calls.filter(call=>call.name==='submit').at(-1).request.behavior === 'followUp'`, 'The main send button uses the same busy default as Enter');
  await review.evaluate(`${q}.setStatus('idle')`);
  await review.fill('.pd-composer-shell > textarea', '快捷键：空闲时直接发送');
  await review.key('Enter');
  await review.waitFor(`${q}.calls.some(call=>call.name==='submit' && call.request.text==='快捷键：空闲时直接发送')`);
  await review.assert(`${q}.calls.filter(call=>call.name==='submit').at(-1).request.behavior == null`, 'Idle submit starts a normal request without a stale busy-queue override');
  await review.evaluate(`${q}.allowSubmit=false`);

  // Large queues stay compact and scroll inside the viewport in both themes.
  await review.evaluate(`${q}.ready(${q}.scopeA); ${q}.resetQueue([...${q}.initialItems.filter(item=>item.state!=='recovered'), ...Array.from({length:9},(_,i)=>${q}.item('queue-layout-'+i,'较长的后续指令 '+i+'：检查完整路径、文件附件和操作按钮在窄窗口中的显示。'))]);`);
  await review.waitFor(`document.querySelectorAll('.pd-composer-queue-item').length === 14`);
  await review.assert(`(() => { const list=document.querySelector('.pd-composer-queue-list'); return list && list.scrollHeight > list.clientHeight && list.getBoundingClientRect().height <= innerHeight*.31; })()`, 'A long queue renders every row within a bounded scrolling list');
  await review.viewport(680, 900);
  await review.assert('document.documentElement.scrollWidth <= innerWidth', 'Narrow dark queue does not widen the application');
  await review.screenshot('queue-dark-680');
  await beginEdit('queue-edit-002');
  await review.assert(`(() => {const box=document.querySelector('.pd-queue-composer-edit').getBoundingClientRect();return box.left>=0 && box.right<=innerWidth && box.bottom<=innerHeight;})()`, 'The narrow main-composer edit surface stays inside the viewport');
  await review.screenshot('queue-edit-dark-680');
  await review.key('Escape');
  await review.viewport(1440, 1000);
  await review.click('.pd-settings-entry');
  await review.clickText('.pd-settings-nav button', '外观');
  await review.clickText('.pd-appearance-choice', '浅色');
  await review.key('Escape');
  await review.waitFor('!document.querySelector(".pd-settings-dialog") && document.documentElement.dataset.theme === "light"');
  await review.screenshot('queue-light-1440');
  await review.viewport(680, 900);
  await review.assert('document.documentElement.scrollWidth <= innerWidth', 'Narrow light queue does not widen the application');
  await review.screenshot('queue-light-680');
  await beginEdit('queue-edit-002');
  await review.screenshot('queue-edit-light-680');
  await clickVisibleButton(review, '^取消(?: |$)', '.pd-queue-composer-edit');
  await review.waitFor(`!document.querySelector('${editor}')`);
  await review.evaluate(`${q}.resetQueue([],false)`);
  await review.waitFor('!document.querySelector(".pd-composer-queue")');
  await review.assert(`${q}.calls.filter(call=>call.name==='mutate').every(call=>call.request.scope?.cwd && typeof call.request.scope?.sessionId==='string' && Object.hasOwn(call.request.scope,'sessionPath')) && !${q}.calls.some(call=>['prompt','legacyMutation'].includes(call.name)) && ${q}.calls.filter(call=>call.name==='submit').every(call=>call.request.text.startsWith('快捷键：'))`, 'Every queue mutation is scoped and queue management never submits the unrelated composer draft');
  await review.record('queue-protocol-summary', `({mutations:${q}.calls.filter(call=>call.name==='mutate').map(call=>({action:call.request.action,id:call.request.id,scope:call.request.scope})),staleScopeCalls:${q}.staleScopeCalls,pendingReads:${q}.pendingGets.length})`);
}

if (process.argv.includes('--check')) {
  let count = 0;
  const compile = expression => { new Function(expression); count++; };
  const noop = async () => {};
  await composerQueueScenarios({ evaluate: async value => compile(value), waitFor: async value => compile(value), assert: async value => compile(value), record: async (_name, value) => compile(value), reducedMotion: noop, viewport: noop, click: noop, clickText: noop, key: noop, fill: noop, settle: noop, screenshot: noop });
  console.log(`Prepared ${count} composer-queue expressions; no browser launched.`);
}
