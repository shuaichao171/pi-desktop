// Prepare without launching: node tests/fixtures/session-loading/scenarios.mjs --check
// Run built renderer: node tests/fixtures/model-settings/run.mjs --run --scenario=../session-loading/scenarios.mjs
// Every navigation stage is released explicitly so a transient reset must paint.
function installSessionLoadingFixture() {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const clone = value => structuredClone(value);
  const cwd = 'C:/session-loading/project';
  const sessions = ['first', 'second'].map((id, index) => ({
    id, path: cwd + '/' + id + '.jsonl', name: index ? '第二段历史对话' : '第一段历史对话',
    firstMessage: '历史内容：' + id, messageCount: 8, modified: '2026-09-27T00:00:00Z',
  }));
  const state = window.__sessionLoadingReview = { cwd, sessions, phase: 'idle', gates: {}, samples: [], sampling: false };
  const messages = id => Array.from({ length: 4 }, (_, index) => [
    { id: id + '-user-' + index, order: index * 2, role: 'user', text: id + ' 的第 ' + (index + 1) + ' 个问题', status: 'done' },
    { id: id + '-assistant-' + index, order: index * 2 + 1, role: 'assistant', text: '这是 ' + id + ' 对话的历史回复。切换时输入框应保持在底部。', status: 'done' },
  ]).flat();
  const setSnapshot = (session, fresh = false) => Object.assign(fixture.snapshot, {
    cwd, sessionId: session.id, sessionPath: session.path, messages: fresh ? [] : messages(session.id),
    activities: [], runs: [], fileChanges: [], historyTotal: fresh ? 0 : 8,
    queuedCount: 0, queuedMessages: [], status: 'idle', error: null,
  });
  const gate = name => {
    if (!state.gates[name]) {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      state.gates[name] = { promise, resolve };
    }
    return state.gates[name].promise;
  };
  state.release = name => {
    if (!state.gates[name]) throw new Error('Navigation has not reached gate: ' + name);
    state.gates[name].resolve();
  };
  state.beginSamples = () => {
    state.samples = [];
    state.sampling = true;
    const sample = () => {
      if (!state.sampling) return;
      const rect = document.querySelector('.pd-composer-shell')?.getBoundingClientRect();
      if (rect) state.samples.push({ phase: state.phase, top: rect.top, bottom: rect.bottom, width: rect.width,
        centered: Boolean(document.querySelector('.pd-main.is-empty')), context: Boolean(document.querySelector('.pd-composer-context')) });
      requestAnimationFrame(sample);
    };
    sample();
  };
  const navigate = async (session, fresh = false) => {
    state.gates = {};
    state.phase = 'before-reset';
    await gate('reset');
    state.phase = 'reset';
    fixture.emitAgent({ type: 'reset', cwd });
    fixture.emitAgent({ type: 'status', status: 'starting' });
    await gate('ready');
    state.phase = 'ready';
    setSnapshot(session, fresh);
    state.holdRefresh = true;
    fixture.emitAgent({ ...clone(fixture.snapshot), type: 'ready' });
    fixture.emitAgent({ type: 'status', status: 'idle' });
  };
  bridge.getDefaultWorkspace = async () => 'C:/session-loading/home';
  bridge.listWorkspaces = async () => [cwd];
  bridge.listConversationWorkspaces = async () => [];
  bridge.listPinnedWorkspaces = async () => [];
  bridge.listSessionGroups = async () => [];
  bridge.listSessions = async () => {
    if (state.holdRefresh) {
      state.phase = 'refresh';
      await gate('refresh');
      state.holdRefresh = false;
      state.phase = 'complete';
    }
    return clone(sessions);
  };
  bridge.switchSession = async path => {
    const session = sessions.find(item => item.path === path);
    if (!session) throw new Error('Unknown fixture session: ' + path);
    await navigate(session);
  };
  bridge.getWorkspaceBranches = async () => ({ isRepository: false, current: null, detached: false, branches: [] });
  bridge.getWorkspaceGitStatus = async () => ({ isRepository: false, branch: null, entries: [], truncated: false });
  setSnapshot(sessions[0]);
}

export default async function sessionLoadingScenarios(review) {
  const state = 'window.__sessionLoadingReview';
  const q = JSON.stringify;
  const row = id => `.pd-session-item[data-session-path="C:/session-loading/project/${id}.jsonl"] .pd-session-row`;
  const ready = id => `window.__modelReview.snapshot.sessionId === ${q(id)} && !document.querySelector('.pd-session-loading') && document.querySelector(${q(row('first'))})?.disabled === false`;
  const bottomLayout = `!document.querySelector('.pd-main.is-empty') && !document.querySelector('.pd-composer-context')`;
  async function advance(name, nextPhase) {
    await review.evaluate(`${state}.release(${q(name)})`);
    await review.waitFor(`${state}.phase === ${q(nextPhase)}`);
    await review.settle();
  }
  async function assertBottom(stage) {
    await review.assert(`${bottomLayout} && (() => { const samples=${state}.samples; return samples.length > 0 && samples.every(sample => !sample.centered && !sample.context) && Math.max(...samples.map(sample => sample.top)) - Math.min(...samples.map(sample => sample.top)) <= 1; })()`, stage);
  }
  await review.waitFor('window.__modelReview?.ready === true');
  await review.viewport(1440, 1000);
  await review.reducedMotion(true);
  await review.reloadWithFixture(`(${installSessionLoadingFixture.toString()})()`);
  await review.waitFor(`document.querySelector('[data-message-id="first-assistant-3"]') && ${ready('first')}`);
  await review.click('[data-mode="grouped"]');
  await review.waitFor(`Boolean(document.querySelector(${q(row('second'))}))`);
  await review.screenshot('session-loading-history-before');

  for (const [width, target] of [[1440, 'second'], [900, 'first']]) {
    await review.viewport(width, 1000);
    await review.evaluate(`${state}.beginSamples()`);
    await review.click(row(target));
    await review.waitFor(`${state}.phase === 'before-reset'`);
    await assertBottom(`History composer remains at the bottom before reset at ${width}px`);
    await advance('reset', 'reset');
    await review.assert(`!document.querySelector('.pd-session-loading') && Boolean(document.querySelector('.pd-message-row')) && Boolean(document.querySelector('.pd-session-switching'))`, 'zcode no-blank-out: a delayed reset keeps the previous history painted with the slim switching bar instead of a full placeholder');
    await assertBottom(`Reset never centers the composer or adds the new-conversation project header at ${width}px`);
    await review.screenshot(`session-loading-reset-${width}`);
    await advance('ready', 'refresh');
    await assertBottom(`Ready history keeps the same composer position while sidebar refresh is pending at ${width}px`);
    await advance('refresh', 'complete');
    await review.waitFor(ready(target));
    await review.settle();
    await review.evaluate(`${state}.sampling = false`);
    await assertBottom(`Every painted frame remains at the same bottom composer position across history navigation at ${width}px`);
    await review.record(`session-loading-history-frames-${width}`, `${state}.samples`);
    await review.screenshot(`session-loading-ready-${width}`);
  }
}

if (process.argv.includes('--check')) {
  let count = 0;
  const compile = expression => { new Function(expression); count++; };
  await sessionLoadingScenarios({
    evaluate: async expression => compile(expression), waitFor: async expression => compile(expression),
    assert: async expression => compile(expression), record: async (_name, expression) => compile(expression),
    reloadWithFixture: async expression => compile(expression), click: async () => {},
    settle: async () => {}, screenshot: async () => {}, viewport: async () => {}, reducedMotion: async () => {},
  });
  console.log(`Prepared ${count} session-loading expressions; no browser launched.`);
}
