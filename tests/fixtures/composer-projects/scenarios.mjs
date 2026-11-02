// Prepare only: node tests/fixtures/composer-projects/scenarios.mjs --check
// Run after building: node tests/fixtures/model-settings/run.mjs --run --scenario=../composer-projects/scenarios.mjs
// The real renderer receives trusted clicks/text; workspace and session operations stay in memory.
// Local file selection is synthetic, using real browser File/DataTransfer objects.

function installComposerProjectsFixture() {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const clone = value => structuredClone(value);
  const paths = Object.fromEntries(['home', 'project-a', 'project-b'].map(name => [name, 'C:/composer-projects/' + name]));
  const history = Object.fromEntries(Object.entries(paths).map(([name, cwd]) => [cwd, {
    id: 'history-' + name, path: cwd + '/history.jsonl', name: name + ' 已有对话',
    firstMessage: '已有历史：' + name, modified: '2026-09-27T00:00:00Z', messageCount: 2,
  }]));
  const state = window.__composerProjectsReview = {
    paths, history, navigation: [], completed: 0, newSessions: 0, picks: [], nextPick: null, conversationWorkspaces: [],
    drafts: new Map(), draftReads: [], draftWrites: [], stored: new Map(), scopeErrors: [], inputEvents: [], submitted: [],
    deferNextNavigation: false, pendingNavigation: null, deferNextReady: false, pendingReady: null, backendReady: true,
  };
  const mock = (name, implementation) => {
    bridge[name] = async (...args) => {
      fixture.calls.push({ name, args: clone(args) });
      return implementation(...args);
    };
  };
  state.publish = async (cwd, fresh, initial = false) => {
    if (!fresh && !history[cwd]) throw new Error('Unknown fixture workspace: ' + cwd);
    const row = history[cwd], id = fresh ? 'new-' + (++state.newSessions) : row.id;
    const messages = fresh ? [] : [
      { id: row.id + '-user', order: 0, role: 'user', text: row.firstMessage, status: 'done' },
      { id: row.id + '-assistant', order: 1, role: 'assistant', text: '这是已存在的对话，不能替代新建对话。', status: 'done' },
    ];
    Object.assign(fixture.snapshot, {
      cwd, sessionId: id, sessionPath: fresh ? cwd + '/' + id + '.jsonl' : row.path,
      messages, activities: [], runs: [], historyTotal: messages.length, status: 'idle', error: null,
      fileChanges: [], queuedCount: 0, queuedMessages: [],
    });
    state.backendReady = false;
    fixture.emitAgent({ type: 'reset', cwd });
    // A real reset and ready arrive in separate IPC deliveries. Rendering between
    // them catches attempts to restore a draft with the transient null session.
    if (!initial) {
      await new Promise(resolve => setTimeout(resolve, 35));
      if (state.deferNextReady) {
        state.deferNextReady = false;
        try { await new Promise((resolve, reject) => { state.pendingReady = { resolve, reject }; }); }
        finally { state.pendingReady = null; }
      }
    }
    fixture.emitAgent({ ...clone(fixture.snapshot), type: 'ready' });
    fixture.emitAgent({ type: 'status', status: 'idle' });
    state.backendReady = true;
  };
  const navigate = async (kind, cwd, fresh, options) => {
    const call = { kind, cwd, fresh: Boolean(fresh), options: clone(options) };
    state.navigation.push(call);
    if (state.deferNextNavigation) {
      state.deferNextNavigation = false;
      try {
        await new Promise((resolve, reject) => { state.pendingNavigation = { resolve, reject }; });
      } catch (error) {
        call.error = error.message;
        throw error;
      } finally { state.pendingNavigation = null; }
    }
    // Omitting fresh really restores nonempty history, reproducing the reported regression.
    await state.publish(cwd, Boolean(fresh));
    await Promise.resolve();
    call.sessionId = fixture.snapshot.sessionId;
    state.completed++;
  };
  mock('getDefaultWorkspace', () => paths.home);
  mock('listWorkspaces', () => [...Object.values(paths), ...state.conversationWorkspaces]);
  mock('listConversationWorkspaces', () => [paths.home, ...state.conversationWorkspaces]);
  mock('listSessions', cwd => history[cwd] ? [clone(history[cwd])] : []);
  mock('listSessionGroups', () => []);
  mock('listPinnedWorkspaces', () => []);
  mock('switchWorkspace', (cwd, options) => navigate('workspace', cwd, options?.fresh));
  mock('newSession', options => {
    const cwd = options?.cwd ?? paths.home + '/conversation-' + (state.conversationWorkspaces.length + 1);
    if (!options?.cwd) state.conversationWorkspaces.push(cwd);
    return navigate('new-session', cwd, true, options);
  });
  mock('submitInput', async request => {
    if (!state.backendReady || request.sessionId !== fixture.snapshot.sessionId) throw new Error('Input submitted before the final session was ready');
    if (state.submitted.some(item => item.id === request.id)) throw new Error('Input submitted twice');
    state.submitted.push({ ...clone(request), cwd: fixture.snapshot.cwd });
    const message = { id: 'entry-' + request.id, order: fixture.snapshot.messages.length, role: 'user', text: request.text, attachments: clone(request.attachments ?? []), status: 'done' };
    fixture.snapshot.messages.push(message);
    fixture.snapshot.historyTotal = fixture.snapshot.messages.length;
    fixture.snapshot.status = 'busy';
    fixture.emitAgent({ type: 'user-message', ...clone(message) });
    fixture.emitAgent({ type: 'status', status: 'busy' });
    await new Promise(resolve => setTimeout(resolve, 35));
    fixture.emitAgent({ ...clone(fixture.snapshot), type: 'ready' });
    fixture.snapshot.status = 'idle';
    fixture.emitAgent({ type: 'status', status: 'idle' });
    return { id: request.id, state: 'accepted' };
  });
  mock('pickWorkspace', () => {
    const picked = state.nextPick;
    state.nextPick = null;
    state.picks.push(picked);
    return picked;
  });
  mock('getWorkspaceBranches', () => ({ isRepository: false, current: null, detached: false, branches: [] }));
  mock('getWorkspaceGitStatus', () => ({ isRepository: false, branch: null, entries: [], truncated: false }));
  const key = scope => JSON.stringify([scope.cwd, scope.sessionPath]);
  const checkScope = (operation, scope) => {
    if (!scope.sessionPath || key(scope) !== key(fixture.snapshot)) {
      state.scopeErrors.push({ operation, scope: clone(scope), active: key(fixture.snapshot) });
      throw new Error('草稿所属工作区或会话已变化');
    }
  };
  const ref = (id, attachment) => ({ id, version: 1, kind: attachment.kind, name: attachment.name, mimeType: attachment.mimeType, size: attachment.text?.length ?? 0 });
  mock('getInputDraft', scope => {
    state.draftReads.push(key(scope));
    checkScope('read', scope);
    return clone(state.drafts.get(key(scope)) ?? { version: 0, text: '', attachments: [], missing: [] });
  });
  mock('saveInputDraft', request => {
    checkScope('save', request);
    const current = state.drafts.get(key(request));
    if (request.expectedVersion !== (current?.version ?? 0)) throw new Error('Draft version changed');
    const draft = { version: request.expectedVersion + 1, text: request.text, attachments: request.attachmentIds.map(id => ref(id, state.stored.get(id))), missing: [] };
    state.drafts.set(key(request), draft);
    state.draftWrites.push({ scope: key(request), draft: clone(draft) });
    return clone(draft);
  });
  mock('putInputAttachment', (scope, attachment) => {
    checkScope('put-attachment', scope);
    const id = 'attachment-' + (state.stored.size + 1);
    state.stored.set(id, clone(attachment));
    return ref(id, attachment);
  });
  mock('readInputAttachment', (scope, id) => {
    checkScope('read-attachment', scope);
    if (!state.stored.has(id)) throw new Error('Missing fixture attachment');
    return clone(state.stored.get(id));
  });
  state.attachFile = (name, text) => {
    const input = document.querySelector('.pd-composer-file-input'), transfer = new DataTransfer();
    if (!input) throw new Error('Composer file input missing');
    transfer.items.add(new File([text], name, { type: 'text/plain' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  document.addEventListener('input', event => {
    if (event.target instanceof HTMLTextAreaElement && event.target.closest('.pd-composer-shell')) {
      state.inputEvents.push({ trusted: event.isTrusted, text: event.target.value, sessionId: fixture.snapshot.sessionId });
    }
  }, true);
  void state.publish(paths['project-a'], false, true);
}

export default async function composerProjectsScenarios(review) {
  const state = 'window.__composerProjectsReview', snapshot = 'window.__modelReview.snapshot';
  const input = '.pd-composer-shell > textarea', chip = '.pd-context-chip[aria-label="切换项目"]';
  const clear = '.pd-context-project-clear[aria-label="不使用项目"]';
  const menu = '.pd-sidebar-popover[role="menu"]';
  const q = JSON.stringify;
  const blank = `Boolean(document.querySelector('.pd-main.is-empty .pd-empty-state')) && !document.querySelector('.pd-message-row') && !document.querySelector('.pd-session-loading')`;
  const calmComposer = `document.querySelector(${q(input)})?.disabled === false && !/正在连接|正在重连|Connecting|Reconnecting/.test(document.querySelector(${q(input)})?.placeholder ?? '') && !document.querySelector('.pd-session-loading') && !/停止|Stop/.test(document.querySelector('.pd-send-button')?.getAttribute('aria-label') ?? '')`;
  const noDraftFailure = `${state}.scopeErrors.length === 0 && !document.querySelector('.pd-composer-error') && !document.querySelector('.pd-composer-shell')?.textContent.includes('重试恢复草稿')`;
  const messageCount = text => `[...document.querySelectorAll('.pd-message-row [data-message-body]')].filter(element => element.textContent === ${q(text)}).length`;
  async function readyBlank(name, completed, message) {
    const target = name === 'standalone' ? `${state}.conversationWorkspaces.at(-1)` : `${state}.paths[${q(name)}]`;
    await review.waitFor(`${state}.completed === ${completed} && ${snapshot}.cwd === ${target} && ${blank} && document.querySelector(${q(chip)})?.textContent.trim() === ${q(name === 'standalone' ? '选择项目' : name)} && document.querySelector(${q(input)})?.disabled === false && ${state}.draftReads.includes(JSON.stringify([${snapshot}.cwd, ${snapshot}.sessionPath]))`);
    await review.settle();
    await review.assert(`${blank} && ${snapshot}.messages.length === 0 && ${snapshot}.sessionId.startsWith('new-') && document.querySelector(${q(input)}).value === ''`, message);
  }
  async function typeDraft(text, message) {
    await review.fill(input, text);
    await review.waitFor(`document.querySelector('.pd-send-button')?.disabled === false`);
    await review.assert(`${blank} && document.querySelector(${q(input)}).value === ${q(text)} && document.activeElement === document.querySelector(${q(input)})`, message);
  }
  async function openMenu() {
    await review.click(chip);
    await review.waitFor(`Boolean(document.querySelector(${q(menu)})) && [...document.querySelectorAll(${q(menu + ' [role="menuitem"]')})].some(button => button.textContent.trim() === '打开项目…' && !button.disabled)`);
  }
  await review.waitFor('window.__modelReview?.ready === true && Boolean(document.querySelector(".pd-activity-new-session"))');
  await review.viewport(1440, 1000);
  await review.reducedMotion(true);
  await review.reloadWithFixture(`(${installComposerProjectsFixture.toString()})()`);
  await review.waitFor(`document.querySelector('.pd-message-list')?.textContent.includes('已有历史：project-a') && !document.querySelector('.pd-activity-new-session').disabled`);

  await review.click('.pd-sidebar-group[data-project-path="C:/composer-projects/project-a"] .pd-group-more:not([aria-haspopup])');
  await readyBlank('project-a', 1, 'Project New conversation clears the previously visible project history');
  await review.assert(`${state}.navigation[0].options.cwd === ${state}.paths['project-a']`, 'Project-level creation passes its explicit directory to newSession');
  await review.waitFor(`Boolean(document.querySelector(${q(clear)}))`);
  await review.assert(`(() => { const clear = document.querySelector(${q(clear)}), chip = document.querySelector(${q(chip)}); return !clear.disabled && clear.getBoundingClientRect().right <= chip.getBoundingClientRect().left && Boolean(clear.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING); })()`, 'The direct no-project button is visible to the left of the project selector');
  await review.screenshot('composer-projects-integrated-control');
  await openMenu();
  await review.assert(`[...document.querySelectorAll(${q(menu + ' [role="menuitem"]')})].some(item => item.textContent.trim() === '不使用项目')`, 'The project menu retains its no-project action alongside the direct removal button');
  await review.key('Escape');
  const retryDraft = '退出项目失败时，保留这段尚未发送的内容。';
  await typeDraft(retryDraft, 'The project conversation holds an editable draft before removing its project');
  await review.evaluate(`${state}.beforeFailure = { cwd: ${snapshot}.cwd, sessionId: ${snapshot}.sessionId, sessionPath: ${snapshot}.sessionPath }; ${state}.deferNextNavigation = true`);
  await review.click(clear);
  await review.waitFor(`Boolean(${state}.pendingNavigation) && document.querySelector(${q(chip)})?.textContent.trim() === '选择项目' && ${calmComposer}`);
  await review.assert(`${state}.navigation.length === 2 && ${state}.completed === 1 && ${state}.submitted.length === 0 && ${snapshot}.sessionId === ${state}.beforeFailure.sessionId && document.querySelector(${q(input)}).value === ${q(retryDraft)} && ${noDraftFailure}`, 'Removing a project immediately clears its display and keeps the retained draft editable while backend preparation is pending');
  const editedRetryDraft = retryDraft + ' 准备过程中仍可继续编辑。';
  await typeDraft(editedRetryDraft, 'Editing remains available while the independent session is being prepared');
  await review.screenshot('composer-projects-detach-preparing');
  await review.evaluate(`${state}.pendingNavigation.reject(new Error('模拟项目切换失败'))`);
  await review.waitFor(`document.body.textContent.includes('模拟项目切换失败') && document.querySelector(${q(clear)})?.disabled === false && document.querySelector(${q(input)})?.disabled === false`);
  await review.assert(`${snapshot}.cwd === ${state}.beforeFailure.cwd && ${snapshot}.sessionId === ${state}.beforeFailure.sessionId && ${snapshot}.sessionPath === ${state}.beforeFailure.sessionPath && !document.querySelector('.pd-message-row') && document.querySelector(${q(input)}).value === ${q(editedRetryDraft)} && !document.querySelector('.pd-send-button').disabled && ${state}.scopeErrors.length === 0`, 'A failed preparation restores the original project and session, retains edits made during preparation, and permits retry');
  await review.screenshot('composer-projects-detach-failed-retry');
  await review.evaluate(`${state}.deferNextNavigation = true; ${state}.deferNextReady = true`);
  await review.click(clear);
  await review.waitFor(`Boolean(${state}.pendingNavigation) && document.querySelector(${q(chip)})?.textContent.trim() === '选择项目' && ${calmComposer}`);
  const sentDraft = '不使用项目后，后台准备完成前先发送这条新对话。';
  await typeDraft(sentDraft, 'The detached conversation accepts a message before backend preparation finishes');
  await review.evaluate(`${state}.attachFile('first-message.txt', '第一条消息的附件内容')`);
  await review.waitFor(`document.querySelector('.pd-composer-attachments')?.textContent.includes('first-message.txt') && !document.querySelector('.pd-send-button').disabled`);
  await review.click('.pd-send-button');
  await review.waitFor(`${messageCount(sentDraft)} === 1 && document.querySelector(${q(input)})?.value === '' && !document.querySelector('.pd-composer-attachment')`);
  await review.assert(`${state}.submitted.length === 0 && ${state}.completed === 1 && ${snapshot}.sessionId === ${state}.beforeFailure.sessionId && ${noDraftFailure}`, 'Sending displays one optimistic user message and clears its text and attachment before any input is submitted to the backend');
  await review.screenshot('composer-projects-detach-message-waiting');
  const nextDraft = '等待后台期间，为下一条消息继续编辑。';
  await review.fill(input, nextDraft);
  await review.evaluate(`${state}.attachFile('next-message.txt', '下一条消息应当继续保留的附件内容')`);
  await review.waitFor(`document.querySelector('.pd-composer-attachments')?.textContent.includes('next-message.txt') && document.querySelector(${q(input)})?.value === ${q(nextDraft)}`);
  await review.evaluate(`${state}.pendingNavigation.resolve()`);
  await review.waitFor(`Boolean(${state}.pendingReady)`);
  await review.settle();
  await review.assert(`${state}.submitted.length === 0 && ${messageCount(sentDraft)} === 1 && document.querySelector(${q(input)})?.value === ${q(nextDraft)} && document.querySelector('.pd-composer-attachments')?.textContent.includes('next-message.txt') && ${calmComposer} && ${noDraftFailure}`, 'An asynchronous reset before ready neither loses the visible message or next draft nor triggers a stale-scope draft read');
  await review.screenshot('composer-projects-detach-reset-waiting');
  await review.evaluate(`${state}.pendingReady.resolve()`);
  await review.waitFor(`${state}.completed === 2 && ${state}.submitted.length === 1 && ${snapshot}.status === 'idle' && document.querySelector(${q(input)})?.value === ${q(nextDraft)} && !document.querySelector('.pd-send-button').disabled`);
  await review.settle();
  await review.assert(`${state}.navigation.at(-1).kind === 'new-session' && !${state}.navigation.at(-1).options?.cwd && ${snapshot}.cwd === ${state}.conversationWorkspaces.at(-1) && ${snapshot}.cwd !== ${state}.paths.home && ${snapshot}.sessionId !== ${state}.history[${state}.paths.home].id && !document.querySelector(${q(clear)})`, 'The direct removal prepares a fresh independent conversation');
  await review.assert(`${state}.submitted[0].cwd === ${state}.conversationWorkspaces.at(-1) && ${state}.submitted[0].sessionId === ${snapshot}.sessionId && ${state}.submitted[0].text === ${q(sentDraft)} && ${state}.submitted[0].attachments.length === 1 && ${state}.submitted[0].attachments[0].name === 'first-message.txt' && ${messageCount(sentDraft)} === 1`, 'Backend readiness submits once to the final independent session, including the original attachment, without duplicating the optimistic message');
  await review.assert(`document.querySelector(${q(input)})?.value === ${q(nextDraft)} && document.querySelectorAll('.pd-composer-attachment').length === 1 && document.querySelector('.pd-composer-attachments')?.textContent.includes('next-message.txt') && ${noDraftFailure}`, 'The next draft and its attachment survive the final session transition and acknowledgment');
  await review.waitFor(`${state}.drafts.get(JSON.stringify([${snapshot}.cwd, ${snapshot}.sessionPath]))?.text === ${q(nextDraft)} && ${state}.drafts.get(JSON.stringify([${snapshot}.cwd, ${snapshot}.sessionPath]))?.attachments.some(item => item.name === 'next-message.txt')`);
  await review.screenshot('composer-projects-detach-ready-preserves-next-draft');

  // The project picker belongs to an empty conversation. Once the optimistic
  // message is accepted, use the real sidebar action to create the next draft.
  await review.click('.pd-activity-new-session');
  await readyBlank('standalone', 3, 'The sidebar opens a new blank independent conversation after the accepted message');
  await review.assert(`!document.querySelector(${q(clear)}) && document.querySelectorAll('.pd-composer-context .pd-context-chip').length === 1`, 'A fresh independent draft displays only the project selector');
  await openMenu();
  await review.assert(`[...document.querySelectorAll(${q(menu + ' [role="menuitemradio"]')})].length === 2 && ![...document.querySelectorAll(${q(menu + ' .pd-context-menu-main')})].some(item => item.textContent.trim() === 'home' || item.textContent.includes('conversation-'))`, 'The refreshed menu lists only explicit projects without exposing the storage root or automatic conversation directories');
  await review.clickText(menu + ' .pd-context-menu-main', 'project-b');
  await readyBlank('project-b', 4, 'Selecting another existing project keeps the new-conversation page');
  await typeDraft('切换项目后仍可正常新建对话。', 'An existing project with history still provides an editable fresh conversation');

  await review.evaluate(`${state}.nextPick = ${state}.paths['project-a']`);
  await openMenu();
  await review.clickText(menu + ' [role="menuitem"]', '打开项目…');
  await readyBlank('project-a', 5, 'Opening a folder through the new-conversation picker creates a fresh session there');
  await review.assert(`${state}.picks.length === 1 && ${state}.picks[0] === ${state}.paths['project-a'] && ${state}.navigation.slice(1).every(call => call.fresh)`, 'Every composer project action forwards the fresh-session option');
  const retainedDraft = '取消文件夹选择后，保留当前新对话和输入内容。';
  await typeDraft(retainedDraft, 'The opened folder starts an editable new conversation');

  await review.evaluate(`${state}.beforeCancel = { cwd: ${snapshot}.cwd, sessionId: ${snapshot}.sessionId, sessionPath: ${snapshot}.sessionPath, navigation: ${state}.navigation.length }; ${state}.nextPick = null`);
  await openMenu();
  await review.clickText(menu + ' [role="menuitem"]', '打开项目…');
  await review.waitFor(`${state}.picks.length === 2 && !document.querySelector(${q(menu)})`);
  await review.settle();
  await review.assert(`${state}.picks[1] === null && ${state}.navigation.length === ${state}.beforeCancel.navigation && ${snapshot}.cwd === ${state}.beforeCancel.cwd && ${snapshot}.sessionId === ${state}.beforeCancel.sessionId && ${snapshot}.sessionPath === ${state}.beforeCancel.sessionPath && ${blank} && document.querySelector(${q(input)}).value === ${q(retainedDraft)} && !document.querySelector('.pd-send-button').disabled`, 'Cancelling the folder dialog preserves the current blank session, project, draft, and enabled Send button');
  await openMenu();
  await review.assert(`[...document.querySelectorAll(${q(menu + ' [role="menuitem"]')})].every(button => !button.disabled)`, 'Cancelling releases navigation state so another project action remains available');
  await review.key('Escape');
  await typeDraft(retainedDraft + ' 继续编辑。', 'Typing continues normally after the folder dialog is cancelled');
  await review.assert(`${state}.inputEvents.length >= 4 && ${state}.inputEvents.every(event => event.trusted)`, 'All composer edits were produced by trusted keyboard input');
  await review.record('composer-project-navigation', `${state}.navigation`);
  await review.record('composer-project-folder-results', `${state}.picks`);
  await review.record('composer-project-submitted-inputs', `${state}.submitted`);
  await review.record('composer-project-draft-scope-errors', `${state}.scopeErrors`);
  await review.assert(`${state}.scopeErrors.length === 0`, 'All project actions avoid draft reads, writes, and attachments against a transient or stale session scope');
  await review.screenshot('composer-projects-folder-cancel-preserves-draft');
}

if (process.argv.includes('--check')) {
  let count = 0;
  const compile = expression => { new Function(expression); count++; };
  await composerProjectsScenarios({
    evaluate: async expression => compile(expression), waitFor: async expression => compile(expression),
    assert: async expression => compile(expression), record: async (_name, expression) => compile(expression),
    reloadWithFixture: async expression => compile(expression),
    click: async () => {}, clickText: async () => {}, fill: async () => {}, key: async () => {},
    settle: async () => {}, screenshot: async () => {}, viewport: async () => {}, reducedMotion: async () => {},
  });
  console.log(`Prepared ${count} composer-project expressions; no browser launched.`);
}
