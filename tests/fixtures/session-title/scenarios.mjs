// Run against the built renderer in the owned headless-shell fixture.
// node tests/fixtures/model-settings/run.mjs --run --scenario=../session-title/scenarios.mjs
export default async function sessionTitleScenarios(review) {
  await review.waitFor('window.__modelReview?.ready === true');
  await review.reducedMotion(true);
  await review.evaluate(`(() => {
    const fixture = window.__modelReview;
    const state = window.__titleReview = { reads: 0, pending: [], first: '发送后立即显示聊天标题' };
    state.entry = { path: fixture.snapshot.sessionPath, id: fixture.snapshot.sessionId, firstMessage: '', modified: new Date().toISOString(), messageCount: 0, runtime: { phase: 'running' } };
    window.piDesktop.listSessions = () => { state.reads++; return new Promise(resolve => state.pending.push(resolve)); };
    window.piDesktop.updateSessionMeta = async (path, patch) => { if (path !== state.entry.path) throw new Error('Wrong rename target'); Object.assign(state.entry, patch); };
    fixture.emitAgent({ type: 'status', status: 'busy' });
    fixture.emitAgent({ type: 'session-runtime', cwd: fixture.snapshot.cwd, path: state.entry.path, runtime: { phase: 'running' } });
    fixture.emitAgent({ type: 'user-message', id: 'title-first', order: 1, text: state.first + '\\n继续检查实时状态' });
  })()`);
  await review.waitFor('document.querySelector(".pd-conversation-header-title")?.textContent === window.__titleReview.first');
  await review.assert('document.querySelector(".pd-session-item.is-active strong")?.textContent === window.__titleReview.first', 'Sidebar title changes as soon as the first accepted message arrives');
  await review.assert('window.__titleReview.pending.length > 0 && document.querySelector(".pd-conversation-header-title").textContent === window.__titleReview.first', 'Header title does not wait for the asynchronous session list or assistant response');
  await review.screenshot('title-live-before-list-refresh');
  await review.evaluate(`(() => {
    const state = window.__titleReview;
    state.entry.firstMessage = state.first + '\\n继续检查实时状态'; state.entry.messageCount = 1;
    const pending = state.pending.splice(0);
    pending.forEach((resolve, index) => resolve(index === pending.length - 1 ? [structuredClone(state.entry)] : []));
    window.piDesktop.listSessions = async () => [structuredClone(state.entry)];
  })()`);
  await review.settle();
  await review.assert('document.querySelector(".pd-session-item.is-active strong")?.textContent === window.__titleReview.first', 'Old empty list responses cannot restore the unnamed title');
  // The conversation header only displays the title; renaming lives in the sidebar session menu.
  await review.evaluate('document.querySelector(".pd-session-item.is-active .pd-session-row").focus()');
  await review.key('F10', { shift: true });
  await review.clickText('.pd-sidebar-popover[role="menu"] .pd-menu-item', '重命名');
  await review.fill('.pd-session-rename', '保留我的手动标题');
  await review.key('Enter');
  await review.waitFor('document.querySelector(".pd-conversation-header-title")?.textContent === "保留我的手动标题"');
  await review.evaluate('window.__modelReview.emitAgent({ type: "user-message", id: "title-followup", order: 2, text: "继续处理后续内容" })');
  await review.settle();
  await review.assert('document.querySelector(".pd-conversation-header-title")?.textContent === "保留我的手动标题" && document.querySelector(".pd-session-item.is-active strong")?.textContent === "保留我的手动标题"', 'Follow-up prompts preserve the explicitly renamed title while the conversation runs');
  await review.screenshot('title-live-manual-name-preserved');
}
