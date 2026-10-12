// Build first, then run the isolated renderer against deferred in-memory IPC:
// node tests/fixtures/model-settings/run.mjs --run --scenario=../new-conversation/scenarios.mjs
export function installNewConversationFixture() {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const clone = value => structuredClone(value);
  const project = 'C:/new-conversation/project';
  const oldPath = project + '/old.jsonl';
  const state = window.__newConversationReview = {
    project, oldPath, creations: [], submissions: [], drafts: new Map(), pending: null,
    draftReads: [], draftWrites: [], backendReady: true, completed: 0,
    switches: [], afterPreparation: [], attachments: new Map(), attachmentWrites: [], delayedImageRead: null,
  };
  const scopeKey = scope => JSON.stringify([scope.cwd, scope.sessionPath]);
  state.drafts.set(JSON.stringify([project, oldPath]), { version: 1, text: '旧对话尚未发送的草稿', attachments: [], missing: [] });
  Object.assign(fixture.snapshot, {
    cwd: project, sessionId: 'old-conversation', sessionPath: oldPath, status: 'idle',
    messages: [{ id: 'old-message', order: 0, role: 'user', text: '旧对话的历史消息', status: 'done' }],
    activities: [], runs: [], historyTotal: 1, queuedCount: 0, queuedMessages: [], fileChanges: [], error: null,
  });
  const mock = (name, implementation) => {
    bridge[name] = async (...args) => {
      fixture.calls.push({ name, args: clone(args) });
      return implementation(...args);
    };
  };
  mock('getDefaultWorkspace', () => 'C:/new-conversation/home');
  mock('listWorkspaces', () => [project, ...state.creations.map(item => item.cwd)]);
  mock('listConversationWorkspaces', () => state.creations.filter(item => !item.options?.cwd).map(item => item.cwd));
  mock('listSessions', cwd => [
    ...(cwd === project ? [{ id: 'old-conversation', path: oldPath, name: '旧对话', firstMessage: '旧对话的历史消息', modified: '2026-09-28T00:00:00Z', messageCount: 1 }] : []),
    ...state.creations.filter(item => item.completed && item.cwd === cwd).map(item => ({ id: item.sessionId, path: item.sessionPath, name: item.sessionId, firstMessage: '', modified: '2026-09-28T00:01:00Z', messageCount: 0 })),
  ]);
  mock('getWorkspaceBranches', () => ({ isRepository: false, current: null, detached: false, branches: [] }));
  mock('getWorkspaceGitStatus', () => ({ isRepository: false, branch: null, entries: [], truncated: false }));
  mock('getInputDraft', scope => {
    state.draftReads.push(scopeKey(scope));
    return clone(state.drafts.get(scopeKey(scope)) ?? { version: 0, text: '', attachments: [], missing: [] });
  });
  mock('saveInputDraft', request => {
    const key = scopeKey(request), current = state.drafts.get(key);
    if (request.expectedVersion !== (current?.version ?? 0)) throw new Error('Fixture draft version changed');
    const next = { version: request.expectedVersion + 1, text: request.text, attachments: request.attachmentIds.map(id => clone(state.attachments.get(id).ref)), missing: [] };
    state.drafts.set(key, next); state.draftWrites.push(clone(request));
    return clone(next);
  });
  mock('putInputAttachment', (scope, attachment) => {
    const id = 'fixture-image-' + (state.attachments.size + 1);
    const ref = { id, version: 1, kind: attachment.kind, name: attachment.name, mimeType: attachment.mimeType, size: attachment.data?.length ?? attachment.text?.length ?? 0 };
    state.attachments.set(id, { scope: clone(scope), attachment: clone(attachment), ref });
    state.attachmentWrites.push({ scope: clone(scope), name: attachment.name });
    return clone(ref);
  });
  mock('readInputAttachment', (scope, id) => {
    const stored = state.attachments.get(id);
    if (!stored || scopeKey(scope) !== scopeKey(stored.scope)) throw new Error('Attachment belongs to another draft scope');
    return clone(stored.attachment);
  });
  mock('switchWorkspace', async cwd => {
    state.switches.push({ type: 'workspace', cwd });
    // The real main process serializes navigation behind the in-flight create.
    if (state.pending) await new Promise(resolve => state.afterPreparation.push(resolve));
  });
  mock('switchSession', path => {
    state.switches.push({ type: 'session', path });
    const target = path === oldPath ? { cwd: project, sessionId: 'old-conversation', sessionPath: oldPath } : state.creations.find(item => item.completed && item.sessionPath === path);
    if (!target) throw new Error('Unknown fixture conversation: ' + path);
    const messages = path === oldPath ? [{ id: 'old-message', order: 0, role: 'user', text: '旧对话的历史消息', status: 'done' }] : [];
    Object.assign(fixture.snapshot, { cwd: target.cwd, sessionId: target.sessionId, sessionPath: path, status: 'idle', messages,
      activities: [], runs: [], historyTotal: messages.length, queuedCount: 0, queuedMessages: [], fileChanges: [], error: null });
    fixture.emitAgent({ type: 'reset', cwd: target.cwd });
    fixture.emitAgent({ ...clone(fixture.snapshot), type: 'ready' });
    fixture.emitAgent({ type: 'status', status: 'idle' });
  });
  mock('newSession', options => {
    if (state.pending) throw new Error('Duplicate preparation RPC');
    const number = state.creations.length + 1;
    const item = { options: clone(options), sessionId: 'fresh-' + number, cwd: options?.cwd ?? 'C:/new-conversation/home/conversation-' + number };
    item.sessionPath = item.cwd + '/fresh-' + number + '.jsonl';
    state.creations.push(item);
    state.backendReady = false;
    return new Promise((resolve, reject) => { state.pending = { item, resolve, reject, ready: false }; });
  });
  state.emitReset = () => {
    fixture.emitAgent({ type: 'reset', cwd: state.pending.item.cwd });
    fixture.emitAgent({ type: 'status', status: 'starting' });
  };
  state.emitReady = () => {
    const item = state.pending.item;
    Object.assign(fixture.snapshot, { cwd: item.cwd, sessionId: item.sessionId, sessionPath: item.sessionPath,
      status: 'idle', messages: [], activities: [], runs: [], historyTotal: 0, queuedCount: 0, queuedMessages: [], fileChanges: [], error: null });
    state.pending.ready = true;
    fixture.emitAgent({ ...clone(fixture.snapshot), type: 'ready' });
    fixture.emitAgent({ type: 'status', status: 'idle' });
  };
  state.finish = () => {
    if (!state.pending?.ready) throw new Error('Fixture ready event must precede RPC completion');
    const pending = state.pending; state.pending = null; state.backendReady = true; state.completed++;
    pending.item.completed = true;
    pending.resolve({ cwd: pending.item.cwd, sessionPath: pending.item.sessionPath });
    for (const resolve of state.afterPreparation.splice(0)) queueMicrotask(resolve);
  };
  state.fail = () => {
    const pending = state.pending; state.pending = null; state.backendReady = true;
    pending.reject(new Error('模拟后台会话准备失败'));
  };
  mock('submitInput', request => {
    if (!state.backendReady || state.pending || request.sessionId !== fixture.snapshot.sessionId) throw new Error('Submission preceded final session activation');
    if (state.submissions.some(item => item.id === request.id)) throw new Error('Duplicate submission');
    state.submissions.push(clone(request));
    const message = { id: 'entry-' + request.id, order: fixture.snapshot.messages.length, role: 'user', text: request.text, attachments: clone(request.attachments ?? []), status: 'done' };
    fixture.snapshot.messages.push(message); fixture.snapshot.historyTotal = fixture.snapshot.messages.length;
    fixture.emitAgent({ type: 'user-message', ...clone(message) });
    return { id: request.id, state: 'accepted' };
  });
  mock('abort', () => {});
  mock('getAutomationSnapshot', () => ({ revision: 1, automations: [], runs: [] }));
  mock('getPluginCatalog', () => ({ cwd: fixture.snapshot.cwd, projectTrusted: true, warnings: [], packages: [], resources: [] }));
  mock('searchSessionsPage', () => ({ sessions: [], truncated: false }));
  mock('searchProjectFiles', () => ({ files: [], truncated: false }));
  mock('cancelDataSearch', () => {});
  state.pasteDelayedImage = () => {
    const original = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function(file) {
      if (file.name !== 'delayed.png') return original.call(this, file);
      const reader = this;
      state.delayedImageRead = () => {
        FileReader.prototype.readAsDataURL = original;
        state.delayedImageRead = null;
        original.call(reader, file);
      };
    };
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII='), char => char.charCodeAt(0));
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([png], 'delayed.png', { type: 'image/png' }));
    document.querySelector('.pd-composer-shell textarea').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  };
}

export default async function newConversationScenarios(review) {
  const state = 'window.__newConversationReview';
  const input = '.pd-composer-shell textarea';
  const editor = `document.querySelector(${JSON.stringify(input)})`;
  const chatVisible = `document.querySelector('.pd-chat-view-host')?.hidden === false`;
  const editable = `${chatVisible} && ${editor}?.disabled === false && !/正在连接|Connecting/.test(${editor}?.placeholder ?? '') && !document.querySelector('.pd-session-loading')`;
  const focused = `document.activeElement === ${editor}`;
  const pending = `Boolean(${state}.pending)`;
  const blank = `!document.querySelector('.pd-message-row') && ${editor}?.value === ''`;
  async function assertDraft(label) {
    await review.waitFor(`${pending} && ${editable} && ${focused}`);
    await review.assert(`${pending} && ${editable} && ${focused} && ${blank}`, label);
  }
  async function complete() {
    await review.evaluate(`${state}.emitReset()`);
    await review.settle();
    await review.assert(editable, 'A backend reset and starting event do not replace the visible editable draft');
    await review.evaluate(`${state}.emitReady()`);
    await review.settle();
    await review.evaluate(`${state}.finish()`);
    await review.waitFor(`!${pending} && ${editable} && !document.querySelector('.pd-composer-retry')`);
  }
  await review.waitFor('window.__modelReview?.ready === true');
  await review.viewport(1440, 1000);
  await review.reducedMotion(true);
  await review.reloadWithFixture(`(${installNewConversationFixture.toString()})()`);
  await review.waitFor(`${editor}?.value === '旧对话尚未发送的草稿' && document.querySelector('.pd-message-list')?.textContent.includes('旧对话的历史消息')`);

  await review.click('.pd-new-session');
  await assertDraft('Ordinary New conversation immediately opens and focuses an empty editable draft while its RPC remains pending');
  await review.assert(`${state}.creations.length === 1 && ${state}.submissions.length === 0 && !${state}.creations[0].options?.cwd`, 'The ordinary entry starts exactly one independent conversation preparation');
  await review.fill(input, '后台准备期间可以立即输入并发送');
  await review.click('.pd-send-button');
  await review.waitFor(`${editor}.value === '' && document.querySelector('.pd-message-list')?.textContent.includes('后台准备期间可以立即输入并发送')`);
  await review.assert(`${state}.submissions.length === 0 && ${pending} && ${editable}`, 'The first message appears locally while waiting for its one prepared session');
  await review.screenshot('new-conversation-preparing-first-message');
  await review.evaluate(`${state}.emitReset()`);
  await review.settle();
  await review.assert(`${state}.submissions.length === 0 && ${editable}`, 'Reset during preparation keeps the composer available and does not send early');
  await review.evaluate(`${state}.emitReady()`);
  await review.settle();
  await review.assert(`${state}.submissions.length === 0`, 'A ready event alone does not submit before the creation RPC finishes activation');
  await review.evaluate(`${state}.finish()`);
  await review.waitFor(`${state}.submissions.length === 1 && ${editor}.value === ''`);
  await review.assert(`${state}.submissions[0].sessionId === 'fresh-1' && ${state}.submissions[0].text === '后台准备期间可以立即输入并发送' && ${state}.creations.length === 1`, 'The first submission reuses the prepared session exactly once');
  await review.assert(`${state}.drafts.get(JSON.stringify([${state}.project, ${state}.oldPath])).text === '旧对话尚未发送的草稿'`, 'Creating and sending in a new draft preserves the previous conversation draft');

  await review.click('.pd-sidebar-automation');
  await review.waitFor(`!(${chatVisible})`);
  await review.click('.pd-new-session');
  await assertDraft('New conversation from Automations switches to chat before preparation completes');
  await review.fill(input, '失败以后仍然保留这段新草稿');
  await review.evaluate(`${state}.fail()`);
  await review.waitFor(`Boolean(document.querySelector('.pd-composer-retry'))`);
  await review.assert(`${editor}.value === '失败以后仍然保留这段新草稿' && ${editor}.disabled === false && ${chatVisible}`, 'A failed preparation leaves its new draft visible and editable');
  await review.fill(input, '失败以后编辑的新草稿');
  await review.click('.pd-composer-retry');
  await review.waitFor(`${pending} && ${editable}`);
  await review.assert(`${editor}.value === '失败以后编辑的新草稿' && ${state}.creations.length === 3`, 'Retry reuses the same edited local draft');
  await complete();
  await review.waitFor(`${editor}.value === '失败以后编辑的新草稿' && !document.querySelector('.pd-send-button').disabled`);
  await review.assert(`${state}.submissions.length === 1`, 'Retry preparation never sends an unsubmitted draft');

  await review.click('.pd-sidebar-plugins');
  await review.waitFor(`!(${chatVisible})`);
  await review.key('p', { ctrl: true, shift: true });
  await review.waitFor(`Boolean(document.querySelector('.pd-search-input'))`);
  await review.fill('.pd-search-input', '新建对话');
  await review.waitFor(`Boolean(document.querySelector('.pd-search-result[id$="result-command%3Anew-session"]'))`);
  await review.key('Enter');
  await assertDraft('The command palette closes and opens the new chat draft immediately from Plugins');
  await review.assert(`!document.querySelector('.pd-search-dialog') && ${state}.creations.length === 4`, 'The command palette does not retain its modal while waiting for newSession');
  await review.screenshot('new-conversation-from-command-palette');
  await complete();

  await review.click('.pd-sidebar-automation');
  await review.key('n', { ctrl: true });
  await assertDraft('Ctrl+N immediately returns from Automations and focuses the new draft');
  await complete();
  await review.click('.pd-sidebar-plugins');
  await review.evaluate(`window.__modelReview.emit('onAppCommand', { type: 'new-session' })`);
  await assertDraft('The native menu command immediately returns from Plugins and focuses the new draft');
  await complete();

  await review.click('[data-mode="project"]');
  await review.click('.pd-sidebar-automation');
  await review.click('.pd-sidebar-group[data-project-path="C:/new-conversation/project"] .pd-group-more:not([aria-haspopup])');
  await assertDraft('A project New conversation entry shows its draft before backend preparation');
  await review.assert(`${state}.creations.at(-1).options.cwd === ${state}.project`, 'Project creation retains its explicit workspace');
  await complete();
  await review.assert(`${state}.submissions.length === 1 && ${state}.creations.length === 7 && window.__modelReview.snapshot.cwd === ${state}.project`, 'All navigation entries preserve one preparation each and never duplicate first input');
  await review.screenshot('new-conversation-ready-project');

  const oldConversation = '.pd-session-item[data-session-path="C:/new-conversation/project/old.jsonl"] .pd-session-row';
  for (const queued of [false, true]) {
    const text = queued ? '排队首发取消后仍应属于刚创建的新会话' : '准备期间输入并切走也不会丢失的新草稿';
    await review.click('.pd-new-session');
    await assertDraft(queued ? 'The queued-input navigation regression starts with a fresh editable draft' : 'The typed-draft navigation regression starts with a fresh editable draft');
    await review.fill(input, text);
    if (queued) {
      await review.click('.pd-send-button');
      await review.waitFor(`${editor}.value === '' && document.querySelector('.pd-message-list')?.textContent.includes(${JSON.stringify(text)})`);
    }
    await review.evaluate(`${state}.switchCount = ${state}.switches.length`);
    await review.click(oldConversation);
    await review.waitFor(`${state}.switches.length > ${state}.switchCount`);
    await review.evaluate(`${state}.emitReset(); ${state}.emitReady(); ${state}.finish()`);
    await review.waitFor(`window.__modelReview.snapshot.sessionPath === ${state}.oldPath && ${editor}.value === '旧对话尚未发送的草稿'`);
    await review.assert(`${state}.submissions.length === 1 && ${editor}.value === '旧对话尚未发送的草稿'`, queued
      ? 'Leaving a pending first submission cancels its send and preserves the selected old conversation draft'
      : 'Late preparation completion does not replace the selected old conversation or its draft');
    await review.evaluate(`(() => { const item = ${state}.creations.at(-1); window.__modelReview.emit('onAppCommand', { type: 'open-session', cwd: item.cwd, path: item.sessionPath }); })()`);
    try {
      await review.waitFor(`${editor}.value === ${JSON.stringify(text)} && window.__modelReview.snapshot.sessionPath === ${state}.creations.at(-1).sessionPath && ${editable} && !document.querySelector('.pd-send-button').disabled`);
    } catch (error) {
      await review.record('background-draft-diagnostics', `({ inputDisabled: ${editor}.disabled, placeholder: ${editor}.placeholder, value: ${editor}.value, button: document.querySelector('.pd-send-button').outerHTML, composer: document.querySelector('.pd-composer-wrap').textContent, snapshot: window.__modelReview.snapshot, calls: window.__modelReview.calls.slice(-20), draftReads: ${state}.draftReads })`);
      await review.screenshot('new-conversation-background-draft-failure');
      throw error;
    }
    await review.assert(`${editor}.value === ${JSON.stringify(text)} && ${state}.submissions.length === 1 && !document.querySelector('.pd-send-button').disabled`, queued
      ? 'The cancelled pending first message is recoverable in the actual created session scope'
      : 'The typed draft transfers from its temporary key to the actual created session scope');
  }
  await review.screenshot('new-conversation-background-draft-recovered');

  await review.click('.pd-new-session');
  await assertDraft('The attachment handoff regression starts before session preparation finishes');
  await review.fill(input, '图片读取完成后仍属于这个新会话');
  await review.evaluate(`${state}.pasteDelayedImage()`);
  await review.waitFor(`typeof ${state}.delayedImageRead === 'function'`);
  await review.assert(`document.querySelector('.pd-send-button').disabled && !document.querySelector('.pd-composer-attachment')`, 'An in-flight pasted image blocks submission until FileReader completes');
  await complete();
  await review.assert(`typeof ${state}.delayedImageRead === 'function' && ${editor}.value === '图片读取完成后仍属于这个新会话'`, 'The real session becomes ready while the image read is still pending');
  await review.evaluate(`${state}.delayedImageRead()`);
  await review.waitFor(`document.querySelector('.pd-composer-attachment')?.textContent.includes('delayed.png') && !document.querySelector('.pd-send-button').disabled`);
  await review.waitFor(`${state}.attachmentWrites.some(item => item.name === 'delayed.png' && item.scope.sessionPath === ${state}.creations.at(-1).sessionPath)`);
  await review.assert(`${state}.attachmentWrites.every(item => item.scope.sessionPath === ${state}.creations.at(-1).sessionPath) && ${editor}.value === '图片读取完成后仍属于这个新会话'`, 'A delayed paste resolves into the actual session draft and persists under that scope');
  await review.screenshot('new-conversation-delayed-image-handoff');
  await review.click('.pd-send-button');
  await review.waitFor(`${state}.submissions.length === 2`);
  await review.assert(`${state}.submissions.at(-1).sessionId === ${state}.creations.at(-1).sessionId && ${state}.submissions.at(-1).attachments.length === 1 && ${state}.submissions.at(-1).attachments[0].name === 'delayed.png'`, 'The delayed image and text are sent together once to their prepared session');
}
