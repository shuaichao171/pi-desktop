import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { useChatStore } from '../packages/ui/src/store.ts';
import { automationRuns, mergeRuntimeStates, pluginResourceGroups, sessionRuntimeKey, summarizeSessionStates } from '../packages/ui/src/managementState.ts';

const session = (path, extra = {}) => ({ path, id: path, firstMessage: path, modified: '2026-09-26T00:00:00Z', messageCount: 1, ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
beforeEach(() => useChatStore.setState(useChatStore.getInitialState(), true));

test('workspace failures end loading, retain old rows on refresh, and can retry independently', async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const old = session('old');
  useChatStore.setState({ cwd: 'B', sessionsByWorkspace: { B: [old] }, sessions: [old], bridge: { listSessions: () => (++calls === 1 ? first.promise : second.promise) } });
  const a = useChatStore.getState().refreshWorkspaceSessions('A');
  const b = useChatStore.getState().refreshWorkspaceSessions('B');
  assert.equal(useChatStore.getState().workspaceSessionRequests.A.phase, 'loading');
  assert.equal(useChatStore.getState().workspaceSessionRequests.B.phase, 'refreshing');
  assert.deepEqual(useChatStore.getState().sessions, [old]);
  first.reject(new Error('A is unavailable'));
  second.resolve([session('new')]);
  await Promise.all([a, b]);
  assert.equal(useChatStore.getState().workspaceSessionRequests.A.phase, 'error');
  assert.match(useChatStore.getState().workspaceSessionRequests.A.error, /unavailable/);
  assert.equal(useChatStore.getState().sessions[0].path, 'new');
  const bridge = useChatStore.getState().bridge;
  bridge.listSessions = async () => [];
  await useChatStore.getState().refreshWorkspaceSessions('A');
  assert.equal(useChatStore.getState().workspaceSessionRequests.A.phase, 'idle');
  assert.deepEqual(useChatStore.getState().sessionsByWorkspace.A, []);
});

test('out-of-order list responses cannot replace a newer success with stale rows or errors', async () => {
  const stale = deferred();
  const recent = deferred();
  let calls = 0;
  useChatStore.setState({ cwd: 'A', bridge: { listSessions: () => (++calls === 1 ? stale.promise : recent.promise) } });
  const a = useChatStore.getState().refreshWorkspaceSessions('A');
  const b = useChatStore.getState().refreshWorkspaceSessions('A');
  recent.resolve([session('recent')]); await b;
  stale.reject(new Error('stale failure')); await a;
  assert.equal(useChatStore.getState().workspaceSessionRequests.A.phase, 'idle');
  assert.equal(useChatStore.getState().sessions[0].path, 'recent');
  assert.equal(useChatStore.getState().error, null);
});

test('background runtime events do not alter the active conversation and win over delayed list snapshots', async () => {
  const pending = deferred();
  const old = session('one');
  useChatStore.setState({ cwd: 'B', status: 'idle', sessionPath: 'two', sessionsByWorkspace: { A: [old] }, bridge: { listSessions: () => pending.promise } });
  const refresh = useChatStore.getState().refreshWorkspaceSessions('A');
  useChatStore.getState().handleEvent({ type: 'session-runtime', cwd: 'A', path: 'one', runtime: { phase: 'waiting-input', message: 'Choose a branch' } });
  pending.resolve([session('one', { runtime: { phase: 'running' } })]); await refresh;
  assert.equal(useChatStore.getState().sessionsByWorkspace.A[0].runtime.phase, 'waiting-input');
  assert.equal(useChatStore.getState().status, 'idle');
  assert.equal(useChatStore.getState().sessionPath, 'two');
  useChatStore.getState().handleEvent({ type: 'session-runtime', cwd: 'A', path: 'one', runtime: { phase: 'idle' } });
  assert.equal(useChatStore.getState().sessionsByWorkspace.A[0].runtime.phase, 'idle');
});

test('runtime identity and project aggregation keep unread independent of execution state', () => {
  const live = { [sessionRuntimeKey('A', 'same')]: { phase: 'failed' } };
  const untouched = session('same');
  const withoutRuntime = mergeRuntimeStates('B', [untouched], live)[0];
  assert.equal(withoutRuntime, untouched, 'an unrelated runtime leaves the original summary object intact');
  assert.equal(Object.hasOwn(withoutRuntime, 'runtime'), false, 'optional runtime stays absent, not explicitly undefined');
  const fromHost = session('same', { runtime: { phase: 'running' } });
  assert.equal(mergeRuntimeStates('B', [fromHost], live)[0], fromHost, 'missing live state preserves the host-provided runtime');
  assert.equal(mergeRuntimeStates('A', [fromHost], { [sessionRuntimeKey('A', 'same')]: { phase: 'idle' } })[0].runtime.phase, 'idle', 'idle explicitly clears a previous running marker');
  assert.deepEqual(summarizeSessionStates([
    session('1', { runtime: { phase: 'running' }, unread: true }),
    session('2', { runtime: { phase: 'waiting-input' } }),
    session('3', { runtime: { phase: 'waiting-approval' } }),
    session('4', { runtime: { phase: 'failed' }, unread: true }),
    session('5', { runtime: { phase: 'idle' } }),
  ]), { running: 1, waiting: 2, failed: 1, unread: 2 });
});

test('latest automation result and history filtering use time rather than snapshot ordering', () => {
  const runs = [
    { id: 'old', automationId: 'A', status: 'succeeded', startedAt: '2026-09-24' },
    { id: 'other', automationId: 'B', status: 'failed', startedAt: '2026-09-27' },
    { id: 'new', automationId: 'A', status: 'failed', startedAt: '2026-09-26' },
    { id: 'running', automationId: 'A', status: 'running', startedAt: '2026-09-28' },
  ];
  assert.equal(automationRuns(runs, 'A').find(run => run.status !== 'running').id, 'new');
  assert.deepEqual(automationRuns(runs, 'A', 'failed').map(run => run.id), ['new']);
  assert.deepEqual(automationRuns(runs, 'all', 'failed').map(run => run.id), ['other', 'new']);
  assert.equal(runs[0].id, 'old', 'sorting must not mutate the live snapshot');
});

test('mixed plugin capabilities group every resource once and expose error-bearing groups', () => {
  const resources = Array.from({ length: 30 }, (_, i) => ({ kind: ['themes', 'skills', 'extensions', 'prompts'][i % 4], path: `/p/${i}`, error: i === 3 ? 'parse failed' : undefined }));
  const groups = pluginResourceGroups(resources);
  assert.deepEqual(groups.map(group => group.kind), ['extensions', 'skills', 'prompts', 'themes']);
  assert.equal(new Set(groups.flatMap(group => group.resources.map(resource => resource.path))).size, 30);
  assert.deepEqual(groups.filter(group => group.hasError).map(group => group.kind), ['prompts']);
});
