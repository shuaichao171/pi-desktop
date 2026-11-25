// Isolated renderer: project folding, paging and live/read transitions.
// node tests/fixtures/model-settings/run.mjs --run --scenario=../sidebar-runtime/project-collapse.mjs
function installProjectCollapseFixture({ restore = false } = {}) {
  const fixture = window.__modelReview, bridge = window.piDesktop;
  const clone = value => structuredClone(value);
  const home = fixture.snapshot.cwd;
  const paths = { Alpha: 'C:\\sidebar-collapse\\Alpha', Beta: 'C:\\sidebar-collapse\\Beta' };
  const row = (workspace, id, extra = {}) => ({ id, path: workspace + '\\' + id + '.jsonl', name: id, firstMessage: id, modified: '2026-11-15T08:00:00Z', messageCount: 2, ...extra });
  const ordinary = Array.from({ length: 7 }, (_, index) => row(paths.Alpha, `ordinary-${index}`));
  const rows = {
    [home]: [],
    [paths.Alpha]: [
      ...ordinary,
      row(paths.Alpha, 'running', { runtime: { phase: 'running' } }),
      row(paths.Alpha, 'waiting', { runtime: { phase: 'waiting-input' } }),
      row(paths.Alpha, 'approval', { runtime: { phase: 'waiting-approval' } }),
      row(paths.Alpha, 'children', { runtime: { phase: 'idle', subagentRunning: true } }),
      row(paths.Alpha, 'old-unread', { unread: true, unreadAt: 10, modified: '2020-01-01T00:00:00Z' }),
      row(paths.Alpha, 'pinned-unread', { pinned: true, unread: true, unreadAt: 11 }),
    ],
    [paths.Beta]: [row(paths.Beta, 'beta-idle'), row(paths.Beta, 'beta-pinned', { pinned: true })],
  };
  const state = window.__projectCollapseReview = { paths, rows, updates: [], revision: 1 };
  const find = path => Object.values(rows).flat().find(item => item.path === path);
  bridge.getDefaultWorkspace = async () => home;
  bridge.listConversationWorkspaces = async () => [home];
  bridge.listWorkspaces = async () => Object.values(paths);
  bridge.listSessions = async cwd => clone(rows[cwd] ?? []);
  bridge.listSessionsPage = async (cwd, offset, limit) => {
    const entries = rows[cwd] ?? [];
    return { sessions: clone(entries.slice(offset, offset + limit)), total: entries.length, hasMore: offset + limit < entries.length, revision: state.revision };
  };
  bridge.listSessionGroups = async () => [];
  bridge.listPinnedWorkspaces = async () => [];
  bridge.focusHostedSession = async () => false;
  bridge.switchWorkspace = async cwd => { fixture.snapshot.cwd = cwd; };
  bridge.switchSession = async path => {
    const item = find(path);
    Object.assign(fixture.snapshot, { cwd: Object.keys(rows).find(cwd => rows[cwd].includes(item)), sessionId: item.id, sessionPath: path,
      messages: [{ id: item.id + '-user', order: 0, role: 'user', text: item.firstMessage, status: 'done' }], activities: [], runs: [], historyTotal: 1, status: 'idle' });
    fixture.emitAgent({ ...clone(fixture.snapshot), type: 'ready' });
  };
  bridge.updateSessionMeta = async (path, patch) => {
    state.updates.push({ path, patch });
    const item = find(path);
    if (patch.unread === false && patch.expectedUnreadAt !== undefined && patch.expectedUnreadAt !== item.unreadAt) return;
    Object.assign(item, patch);
    if (patch.unread === false) delete item.unreadAt;
    state.revision++;
  };
  state.runtime = (id, runtime, unread, cwd = paths.Alpha) => {
    const item = rows[cwd].find(row => row.id === id);
    item.runtime = runtime;
    if (unread !== undefined) { item.unread = unread; item.unreadAt = 20; state.revision++; }
    fixture.emitAgent({ type: 'session-runtime', cwd, path: item.path, runtime });
    if (unread !== undefined) fixture.emitAgent({ type: 'sessions-changed', cwd });
  };
  const preferences = 'pi-desktop.sidebar-organization.v1';
  if (!restore) localStorage.setItem(preferences, JSON.stringify({ mode: 'project', projectView: 'project', sort: 'newest', filter: 'all', collapsed: ['project:' + paths.Beta], projectOrder: Object.values(paths) }));
  localStorage.setItem('pi-desktop.project-groups.v1', JSON.stringify([{ id: 'work', name: '工作项目', projects: [paths.Alpha] }]));
}

export default async function projectCollapseScenarios(review) {
  const q = JSON.stringify;
  await review.reducedMotion(true);
  await review.viewport(1440, 1100);
  await review.reloadWithFixture(`(${installProjectCollapseFixture.toString()})()`);
  const paths = await review.evaluate('window.__projectCollapseReview.paths');
  const project = name => `.pd-sidebar-group[data-section-key=${q('project:' + paths[name])}]`;
  const alpha = project('Alpha'), beta = project('Beta');
  const toggle = `${alpha} > .pd-sidebar-group-heading .pd-sidebar-group-toggle`;
  const row = id => `${alpha} .pd-session-item[data-session-path=${q(paths.Alpha + '\\' + id + '.jsonl')}]`;
  const ids = `[...document.querySelectorAll(${q(alpha + ' .pd-session-item[data-session-path]')})].map(item => item.querySelector('.pd-session-title-text').textContent)`;
  const attention = ['running', 'waiting', 'approval', 'children', 'old-unread', 'pinned-unread'];
  const allAttention = `${q(attention)}.every(id => ${ids}.includes(id))`;
  await review.waitFor(`document.querySelectorAll(${q(alpha + ' .pd-session-item')}).length === 11`);
  await review.assert(`${allAttention} && document.querySelector(${q(alpha + ' .pd-session-more')}).textContent.includes('2')`, 'Expanded projects show all attention rows and paginate only the seven ordinary rows');
  await review.click(`${alpha} .pd-session-more`);
  await review.assert(`document.querySelectorAll(${q(alpha + ' .pd-session-item')}).length === 13 && !document.querySelector(${q(alpha + ' .pd-session-more')})`, 'Show more reveals the two remaining ordinary rows without duplicate attention rows');
  await review.click(toggle);
  await review.assert(`document.querySelector(${q(toggle)}).getAttribute('aria-expanded') === 'false' && ${allAttention} && ${ids}.length === 6 && !document.querySelector(${q(alpha + ' .pd-session-more')})`, 'Folding a grouped project retains exactly its running, waiting and unread conversations');
  await review.assert(`!document.querySelector(${q(beta + ' .pd-session-item')}) && !document.querySelector(${q(beta + ' .pd-sidebar-group-content')})`, 'An ordinary collapsed project, including a read pinned conversation, stays fully folded');
  await review.screenshot('project-collapse-attention-dark');

  await review.evaluate(`window.__projectCollapseReview.runtime('beta-idle', { phase: 'running' }, undefined, ${q(paths.Beta)})`);
  await review.waitFor(`document.querySelectorAll(${q(beta + ' .pd-session-item')}).length === 1`);
  await review.assert(`document.querySelector(${q(beta + ' .pd-sidebar-group-toggle')}).getAttribute('aria-expanded') === 'false'`, 'New background work appears immediately inside an already folded project');
  await review.evaluate(`window.__projectCollapseReview.runtime('beta-idle', { phase: 'idle' }, undefined, ${q(paths.Beta)})`);
  await review.waitFor(`!document.querySelector(${q(beta + ' .pd-session-item')})`);

  await review.evaluate(`window.__projectCollapseReview.runtime('running', { phase: 'idle' }, true)`);
  await review.waitFor(`Boolean(document.querySelector(${q(row('running') + ' .is-unread')}))`);
  await review.assert(`${ids}.includes('running') && document.querySelector(${q(toggle)}).getAttribute('aria-expanded') === 'false'`, 'A background run remains in its folded project after completing with an unread result');
  await review.click(`${row('old-unread')} .pd-session-row`);
  await review.waitFor(`document.querySelector(${q(row('old-unread') + ' .pd-session-row')})?.getAttribute('aria-current') === 'page' && !document.querySelector(${q(row('old-unread') + ' .is-unread')})`);
  await review.assert(`window.__projectCollapseReview.updates.some(update => update.path === ${q(paths.Alpha + '\\old-unread.jsonl')} && update.patch.unread === false && update.patch.expectedUnreadAt === 10) && ${ids}.includes('running') && ${ids}.includes('old-unread') && document.querySelector(${q(toggle)}).getAttribute('aria-expanded') === 'false'`, 'Opening a result clears its unread watermark while the conversation being viewed stays in the folded project');
  await review.screenshot('project-collapse-viewing-dark');
  // Leaving a conversation keeps its row for a 5-second grace period, then it folds away.
  await review.click(`${row('running')} .pd-session-row`);
  await review.waitFor(`document.querySelector(${q(row('running') + ' .pd-session-row')})?.getAttribute('aria-current') === 'page'`);
  await review.evaluate('window.__leftAt = Date.now()');
  await review.assert(`${ids}.includes('old-unread') && ${ids}.includes('running')`, 'The conversation just left is still listed right after switching away');
  await review.screenshot('project-collapse-recent-dark');
  await review.waitFor(`!document.querySelector(${q(row('old-unread'))})`, 8000);
  await review.record('recently-viewed-linger-ms', 'Date.now() - window.__leftAt');
  await review.assert('(() => { const elapsed = Date.now() - window.__leftAt; return elapsed >= 4000 && elapsed <= 6500; })()', 'The left conversation folds away about five seconds later');
  await review.evaluate(`window.__projectCollapseReview.runtime('waiting', { phase: 'idle' }); window.__projectCollapseReview.runtime('approval', { phase: 'idle' }); window.__projectCollapseReview.runtime('children', { phase: 'idle', subagentRunning: false });`);
  await review.waitFor(`${ids}.length === 2`);
  await review.assert(`${ids}.includes('running') && ${ids}.includes('pinned-unread')`, 'Settled work folds away while the viewed conversation and the remaining unread result stay visible');
  await review.click(toggle);
  await review.assert(`document.querySelector(${q(alpha + ' .pd-session-more')}) !== null && ${ids}.filter(id => id.startsWith('ordinary-')).length === 5`, 'Expanding restores the first five ordinary conversations alongside the unread results');
  await review.click(toggle);
  await review.assert(`${ids}.length === 2`, 'Repeated folding preserves only the viewed and unread conversations and the original collapsed preference');

  await review.reloadWithFixture(`localStorage.setItem('pi-desktop.theme', 'light'); (${installProjectCollapseFixture.toString()})({ restore: true })`);
  await review.waitFor(`${ids}.length === 6`);
  await review.assert(`document.querySelector(${q(toggle)}).getAttribute('aria-expanded') === 'false' && ${allAttention}`, 'Reload restores the collapsed project while keeping attention rows visible');
  await review.screenshot('project-collapse-attention-light');
}
