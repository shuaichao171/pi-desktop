function installPaiReview() {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const originalInfo = bridge.getAppInfo;
  bridge.getAppInfo = async () => ({ ...await originalInfo(), windowMode: 'pai' });
  bridge.getDefaultWorkspace = async () => 'C:/pai-review/home';
  const state = window.__paiReview = { submitted: [], created: 0, samples: 0, deferStats: false, releaseStats: null, conversationWorkspaces: [] };
  bridge.listConversationWorkspaces = async () => ['C:/pai-review/home', ...state.conversationWorkspaces];
  const now = Date.now();
  const run = { id: 'pai-run', startedAt: now - 55_000, finishedAt: now, status: 'completed' };
  Object.assign(fixture.snapshot, {
    cwd: 'C:/pai-review/project', sessionId: 'pai-session', sessionPath: 'C:/pai-review/pai-session.jsonl',
    runs: [run], historyTotal: 2, messages: [
      { id: 'pai-user', order: 0, role: 'user', status: 'done', runId: run.id, text: '检查这个文件夹中的项目。' },
      { id: 'pai-answer', order: 1, role: 'assistant', status: 'done', runId: run.id, text: '这是独立聊天窗口。可以在当前目录继续对话，也可以打开设置调整下方的统计项。' },
    ],
  });
  bridge.getSessionStats = async () => {
    state.samples++;
    const stats = {
      sessionId: fixture.snapshot.sessionId, userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2,
      tokens: fixture.snapshot.runs.length ? { input: 500, output: 1000, cacheRead: 200, cacheWrite: 50, total: 1750 } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
      timing: { sampledAt: Date.now(), durationMs: fixture.snapshot.runs.length ? 55_000 : 0, running: false,
        latestRun: fixture.snapshot.runs.length ? { id: 'pai-run', durationMs: 55_000, outputTokens: 1000, running: false } : null },
    };
    if (state.deferStats) {
      state.deferStats = false;
      return new Promise(resolve => { state.releaseStats = () => { state.releaseStats = null; resolve({ ...stats, tokens: { ...stats.tokens, input: 99000 } }); }; });
    }
    return stats;
  };
  bridge.submitInput = async request => { state.submitted.push(structuredClone(request)); return { id: request.id, state: 'accepted' }; };
  bridge.newSession = async options => {
    state.created++;
    const cwd = options?.cwd ?? 'C:/pai-review/home/conversation-' + state.created;
    if (!options?.cwd) state.conversationWorkspaces.push(cwd);
    Object.assign(fixture.snapshot, { cwd, status: 'idle', sessionId: 'pai-new-' + state.created, sessionPath: cwd + '/new-' + state.created + '.jsonl', messages: [], runs: [], historyTotal: 0 });
    fixture.emitAgent({ ...structuredClone(fixture.snapshot), type: 'ready' });
    fixture.emitAgent({ type: 'status', status: 'idle' });
  };
}

export default async function paiScenarios(review) {
  const metrics = '.pd-conversation-metrics';
  const keys = ['speed', 'tokens', 'cache', 'duration'];
  await review.reloadWithFixture(`(${installPaiReview.toString()})()`);
  await review.viewport(920, 720);
  await review.reducedMotion(true);
  await review.waitFor(`Boolean(document.querySelector('.pd-app-shell.is-pai')) && document.querySelector('${metrics}')?.textContent.includes('55s')`);
  await review.assert("!document.querySelector('.pd-sidebar') && !document.querySelector('.pd-sidebar-resize') && !document.querySelector('.pd-workbench-toggle') && !document.querySelector('.pd-header-sidebar-toggle') && !!document.querySelector('.pd-window-controls')", 'pai renders a standalone conversation without sidebar or workbench controls');
  await review.assert(`document.querySelector('${metrics}').textContent.includes('18.2 t/s') && document.querySelector('${metrics}').textContent.includes('↑500') && document.querySelector('${metrics}').textContent.includes('↓1K') && document.querySelector('.pd-metric-cache').textContent.includes('200') && document.querySelector('.pd-metric-cache').textContent.includes('50')`, 'The footer shows measured output rate, input/output tokens, both cache counts, and elapsed task time');
  await review.screenshot('pai-chat-with-metrics');
  await review.key('b', { ctrl: true });
  await review.key('k', { ctrl: true });
  await review.assert("!document.querySelector('.pd-sidebar') && !document.querySelector('.pd-search-dialog')", 'Main-window sidebar and command-palette shortcuts do not expose hidden panels in pai');
  await review.click('.pd-pai-settings');
  await review.waitFor("document.querySelectorAll('.pd-metrics-setting[role=\"switch\"]').length === 4");
  await review.key('f', { ctrl: true });
  await review.assert("!document.querySelector('.pd-transcript-find') && document.querySelector('.pd-settings-dialog').contains(document.activeElement)", 'Conversation shortcuts cannot open a background finder or take focus from settings');
  await review.evaluate("document.querySelector('.pd-metrics-settings').scrollIntoView({block: 'center'})");
  await review.screenshot('pai-metrics-settings');
  await review.click('[data-setting="metrics-speed"]');
  await review.key('Escape');
  await review.assert(`!document.querySelector('.pd-metric-speed') && document.querySelectorAll('${metrics} .pd-metric-group').length === 3`, 'The speed preference independently hides only speed');
  await review.reloadWithFixture(`(${installPaiReview.toString()})()`);
  await review.waitFor(`Boolean(document.querySelector('${metrics}'))`);
  await review.assert("!document.querySelector('.pd-metric-speed')", 'Metric preferences survive reloading the window');
  await review.click('.pd-pai-settings');
  for (const key of keys.slice(1)) await review.click(`[data-setting="metrics-${key}"]`);
  await review.key('Escape');
  await review.assert(`!document.querySelector('${metrics}')`, 'Turning off every metric removes the footer entirely');
  await review.click('.pd-pai-controls [aria-label="新会话"]');
  await review.waitFor("window.__paiReview.created === 1 && Boolean(document.querySelector('.pd-empty-state'))");
  await review.fill('.pd-composer-shell > textarea', '在这个文件夹继续聊天。');
  await review.click('.pd-send-button');
  await review.waitFor('window.__paiReview.submitted.length === 1');
  await review.assert("window.__paiReview.submitted[0].sessionId === 'pai-new-1' && window.__modelReview.snapshot.cwd === window.__paiReview.conversationWorkspaces[0] && window.__modelReview.snapshot.cwd !== 'C:/pai-review/project'", 'New chat and sending use the standalone window conversation and its newly created independent folder');
  // The agent echoes the sent message back, so the conversation is no longer empty and shows its stats line.
  await review.evaluate("(() => { const fixture = window.__modelReview; Object.assign(fixture.snapshot, { messages: [{ id: 'pai-sent-1', order: 0, role: 'user', text: '在这个文件夹继续聊天。', status: 'done' }], historyTotal: 1 }); fixture.emitAgent({ ...structuredClone(fixture.snapshot), type: 'ready' }); })()");
  await review.click('.pd-pai-settings');
  for (const key of keys) await review.click(`[data-setting="metrics-${key}"]`);
  await review.key('Escape');
  await review.viewport(680, 720);
  await review.waitFor(`Boolean(document.querySelector('${metrics}'))`);
  await review.assert("document.documentElement.scrollWidth <= innerWidth && document.querySelector('.pd-send-button').getBoundingClientRect().right <= innerWidth", 'The compact window retains usable controls without horizontal overflow');
  await review.screenshot('pai-compact-680');
  await review.evaluate("window.__paiReview.deferStats = true; window.__modelReview.snapshot.status = 'busy'; window.__modelReview.emitAgent({type: 'status', status: 'busy'});");
  await review.waitFor('Boolean(window.__paiReview.releaseStats)');
  await review.click('.pd-pai-controls [aria-label="新会话"]');
  // A fresh conversation hides the empty stats line; a late sample from the old session must not bring it back.
  await review.waitFor("window.__paiReview.created === 2 && !document.querySelector('.pd-metric-input')");
  await review.evaluate('window.__paiReview.releaseStats()');
  await review.settle();
  await review.assert("!document.querySelector('.pd-metric-input') && window.__modelReview.snapshot.sessionId === 'pai-new-2' && window.__paiReview.conversationWorkspaces[0] !== window.__paiReview.conversationWorkspaces[1]", 'Late metric replies from an older conversation cannot overwrite the new conversation in its distinct folder');
}
