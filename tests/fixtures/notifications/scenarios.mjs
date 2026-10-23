// Real built renderer with isolated, deferred bridge responses; no external actions.
// node tests/fixtures/model-settings/run.mjs --run --scenario=../notifications/scenarios.mjs
function installNotificationFixture(pai = false) {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const state = window.__notificationsReview = { holdDrafts: true, drafts: [], created: 0, dismissed: [] };
  const emptyDraft = () => ({ version: 0, text: '', attachments: [], missing: [] });
  const originalInfo = bridge.getAppInfo;
  bridge.getAppInfo = async () => ({ ...await originalInfo(), windowMode: pai ? 'pai' : 'full' });
  bridge.getInputDraft = async () => state.holdDrafts ? new Promise(resolve => { state.drafts.push(resolve); }) : emptyDraft();
  state.resolveDrafts = () => { state.holdDrafts = false; state.drafts.splice(0).forEach(resolve => resolve(emptyDraft())); };
  bridge.newSession = async () => {
    state.created++;
    await new Promise(resolve => { state.finishNew = resolve; });
    state.holdDrafts = true;
    Object.assign(fixture.snapshot, { sessionId: 'new-review-' + state.created, sessionPath: fixture.snapshot.cwd + '/new-' + state.created + '.jsonl', messages: [], activities: [], runs: [], historyTotal: 0, status: 'idle', error: null });
    fixture.emitAgent({ ...structuredClone(fixture.snapshot), type: 'ready' });
    fixture.emitAgent({ type: 'status', status: 'idle' });
  };
  bridge.openWorkspaceInVsCode = async () => { throw new Error('未找到可用的编辑器，请配置后重试。'); };
  bridge.respondExtensionDialog = async id => { state.dismissed.push(id); fixture.emit('onExtensionDialogClosed', id); };
  bridge.listWorkspaceEntries = async () => [];
  bridge.getWorkspaceGitLog = async () => [];
  // The agent still records a notice in the transcript: it must no longer become a conversation row.
  state.recordNotice = () => {
    const recorded = { id: 'notice-transcript', order: 1, role: 'system', systemKind: 'extension-notice', notificationType: 'info', text: '历史插件通知仍然写入会话记录。', status: 'done' };
    fixture.snapshot.messages = [...fixture.snapshot.messages, recorded];
    fixture.snapshot.historyTotal = fixture.snapshot.messages.length;
    fixture.emitAgent({ ...structuredClone(fixture.snapshot), type: 'ready' });
    fixture.emitAgent({ type: 'status', status: 'idle' });
  };
  state.showNotices = () => {
    if (!pai) fixture.emit('onUpdateStateChanged', { phase: 'ready', currentVersion: '0.1.7', availableVersion: '0.1.8' });
    fixture.emit('onExtensionDialog', { id: 'notice-review', kind: 'notify', title: '插件通知', message: '通知在输入框上方弹出，不再内嵌在对话里。', notificationType: 'info', timeout: 60000 });
  };
  state.showBriefNotice = () => fixture.emit('onExtensionDialog', { id: 'notice-brief', kind: 'notify', title: '短暂提示', message: '这条通知会自己消失。', notificationType: 'warning', timeout: 900 });
}

export default async function notificationScenarios(review) {
  const state = 'window.__notificationsReview';
  const noHints = '!document.querySelector(".pd-composer-attachment-hint[role=status]") && !document.querySelector(".pd-operation-notice")';
  // Operation and update notices share the plugin stack above the composer, so
  // every notice in the conversation appears in one place.
  const centered = `(() => {
    const stack = document.querySelector('.pd-composer-notice-stack');
    if (!stack?.querySelector('.pd-operation-notice') || !stack.querySelector('.pd-update-notice')) return false;
    const shell = document.querySelector('.pd-composer-shell').getBoundingClientRect();
    const wrap = document.querySelector('.pd-composer-wrap').getBoundingClientRect();
    const rows = [...stack.children].filter(e => e.getBoundingClientRect().height > 0).map(e => e.getBoundingClientRect());
    return rows.every(rect => rect.bottom <= shell.top && rect.left >= wrap.left - 1 && rect.right <= wrap.right + 1)
      && !document.querySelector('.pd-notification-center :is(.pd-operation-notice, .pd-update-notice)')
      && document.documentElement.scrollWidth <= innerWidth;
  })()`;
  // Plugin notices float above the composer: inside the composer wrap, clear of the
  // input box, as wide as the composer, and never a transcript row.
  const aboveComposer = `(() => {
    const stack = document.querySelector('.pd-composer-notice-stack');
    const notice = stack?.querySelector('.pd-extension-notice');
    if (!stack || !notice) return false;
    const wrap = document.querySelector('.pd-composer-wrap').getBoundingClientRect();
    const shell = document.querySelector('.pd-composer-shell').getBoundingClientRect();
    const rect = notice.getBoundingClientRect();
    return stack.parentElement === document.querySelector('.pd-composer-wrap')
      && rect.bottom <= wrap.top && rect.bottom <= shell.top
      && Math.abs(rect.left - wrap.left) < 1 && Math.abs(rect.width - wrap.width) < 1
      && !document.querySelector('.pd-conversation-body [data-message-id=notice-transcript]')
      && !document.querySelector('.pd-extension-notice-card')
      && document.documentElement.scrollWidth <= innerWidth;
  })()`;
  async function openEditorNotice() {
    await review.click('.pd-chat-header-more');
    await review.clickText('.pd-sidebar-popover [role=menuitem]', '在 VS Code 中打开');
    await review.waitFor('Boolean(document.querySelector(".pd-operation-notice.is-error"))');
  }
  await review.reloadWithFixture(`(${installNotificationFixture.toString()})()`);
  await review.reducedMotion(true);
  await review.waitFor(`${state}.drafts.length > 0`);
  await review.fill('.pd-composer-shell > textarea', '恢复完成之前保留草稿');
  await review.assert(`${noHints} && document.querySelector('.pd-send-button').disabled && document.querySelector('.pd-composer-add-attachment').disabled`, 'Restoring a draft is quiet and retains send/attachment safeguards');
  await review.evaluate(`${state}.resolveDrafts()`);
  await review.waitFor('!document.querySelector(".pd-send-button").disabled');
  await review.click('.pd-new-session');
  await review.waitFor(`${state}.created === 1`);
  await review.assert(noHints, 'Creating a conversation does not show a pending New session notification');
  await review.evaluate(`${state}.finishNew()`);
  await review.waitFor(`${state}.drafts.length > 0`);
  await review.assert(noHints, 'The new conversation restores its empty draft without an adding-context hint');
  await review.screenshot('new-conversation-without-hints');
  await review.evaluate(`${state}.resolveDrafts()`);
  await review.waitFor('!document.querySelector(".pd-composer-add-attachment").disabled');
  await openEditorNotice();
  await review.evaluate(`${state}.recordNotice()`);
  await review.settle();
  await review.evaluate(`${state}.shellTopBefore = document.querySelector('.pd-composer-shell').getBoundingClientRect().top`);
  await review.evaluate(`${state}.showNotices()`);
  await review.waitFor('Boolean(document.querySelector(".pd-extension-notice")) && Boolean(document.querySelector(".pd-update-notice"))');
  await review.mouseMove(1000, 700);
  await review.assert(centered, 'Operation and update notifications join the notice stack above the composer');
  await review.assert(aboveComposer, 'Plugin notices pop above the composer instead of joining the transcript');
  await review.assert(`(() => {
    const groups = [...document.querySelectorAll('.pd-composer-notice-stack > :is(.pd-operation-feedback, .pd-update-notice)')].filter(e => e.getBoundingClientRect().height > 0).map(e => e.getBoundingClientRect());
    return groups.length === 2 && groups.every((rect, index) => !index || rect.top >= groups[index - 1].bottom);
  })()`, 'Operation and update notices occupy separate rows without overlap');
  await review.assert(`Math.abs(document.querySelector('.pd-composer-shell').getBoundingClientRect().top - ${state}.shellTopBefore) < 1`, 'A floating notice does not move the input box');
  await review.screenshot('notifications-above-composer');
  await review.evaluate(`${state}.showBriefNotice()`);
  await review.waitFor('Boolean(document.querySelector("[data-notification-id=notice-brief]"))');
  await review.screenshot('notifications-above-composer-stacked');
  await review.waitFor('!document.querySelector("[data-notification-id=notice-brief]") && Boolean(document.querySelector("[data-notification-id=notice-review]"))');
  await review.assert(`window.__notificationsReview.dismissed.includes('notice-brief')`, 'A notice disappears on its own while a longer one stays');
  await review.click('.pd-workbench-toggle');
  await review.waitFor('document.querySelector(".pd-workbench")?.classList.contains("is-open")');
  await review.assert(centered, 'Update notifications follow the composer when the workbench opens');
  await review.assert(aboveComposer, 'Floating notices follow the composer when the workbench opens');
  await review.screenshot('notifications-with-workbench');
  await review.click('.pd-workbench-toggle');
  await review.click('.pd-sidebar-collapse');
  await review.assert(centered, 'Update notifications stay above the composer when the sidebar collapses');
  await review.assert(aboveComposer, 'Floating notices stay above the composer when the sidebar collapses');
  await review.viewport(680, 800);
  await review.assert(centered, 'Narrow windows keep update notifications within the conversation');
  await review.assert(aboveComposer, 'Narrow windows keep floating notices within the composer');
  await review.screenshot('notifications-narrow');
  await review.click('.pd-operation-notice-heading button');
  await review.click('.pd-update-notice-secondary');
  await review.assert('!document.querySelector(".pd-operation-notice") && !document.querySelector(".pd-update-notice")', 'Operation and update notices dismiss from the composer stack');
  await review.click('.pd-extension-notice button');
  await review.assert('!document.querySelector(".pd-extension-notice") && window.__notificationsReview.dismissed.includes("notice-review")', 'The floating notice stays dismissable right above the composer');

  await review.reloadWithFixture(`(${installNotificationFixture.toString()})(true)`);
  await review.waitFor('Boolean(document.querySelector(".pd-app-shell.is-pai"))');
  await review.evaluate(`${state}.resolveDrafts()`);
  await openEditorNotice();
  await review.evaluate(`${state}.showNotices()`);
  await review.waitFor('Boolean(document.querySelector(".pd-extension-notice"))');
  await review.assert(aboveComposer, 'The standalone pai window keeps notices above its own composer');
  await review.screenshot('notifications-pai');
}
