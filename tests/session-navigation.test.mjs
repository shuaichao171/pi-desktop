import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionNavigationHistory, recordSessionVisit, planSessionNavigation, commitSessionNavigation } from '../packages/ui/src/sessionNavigationHistory.ts';
import { SessionNavigationController } from '../packages/ui/src/sessionNavigation.ts';

const target = (id, cwd = 'C:/project', path = `C:/sessions/${id}.jsonl`) => ({ cwd, sessionId: id, sessionPath: path });
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
function deferred() { let resolve; let reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }

test('navigation history records startup once, updates persisted paths and truncates only a new branch', () => {
  let history = createSessionNavigationHistory();
  history = recordSessionVisit(history, target('a', 'C:/project', null));
  assert.equal(recordSessionVisit(history, target('a', 'C:/project', null)), history);
  history = recordSessionVisit(history, target('a'));
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].sessionPath, target('a').sessionPath);
  for (const id of ['b', 'c']) history = recordSessionVisit(history, target(id));
  const backward = planSessionNavigation(history, -1);
  assert.equal(history.cursor, 2, 'planning must not advance until navigation succeeds');
  history = commitSessionNavigation(history, backward.cursor, backward.target);
  assert.equal(history.cursor, 1);
  assert.equal(recordSessionVisit(history, target('b')), history, 'ready refresh must preserve forward history');
  history = recordSessionVisit(history, target('d'));
  assert.deepEqual(history.entries.map((entry) => entry.sessionId), ['a', 'b', 'd']);
  assert.equal(planSessionNavigation(history, 1), null);
  history = recordSessionVisit(history, target('d', 'D:/other'));
  assert.equal(history.entries.length, 4, 'identical ids from other projects are separate targets');
});

test('navigation history remains bounded to the latest 100 visits', () => {
  let history = createSessionNavigationHistory();
  for (let index = 0; index < 125; index += 1) history = recordSessionVisit(history, target(String(index)));
  assert.equal(history.entries.length, 100);
  assert.equal(history.entries[0].sessionId, '25');
  assert.equal(history.cursor, 99);
});

function fixture(initial, targets) {
  const state = { owner: {}, intent: 0, ready: true, target: initial };
  const calls = [];
  const handlers = {};
  const byPath = new Map(targets.map((entry) => [entry.sessionPath, entry]));
  let controller;
  const emit = () => controller.observe();
  const begin = () => { state.intent += 1; state.ready = false; emit(); };
  const end = () => { state.ready = true; emit(); };
  const adapter = {
    read: () => state,
    message: (kind) => kind,
    async switchWorkspace(cwd) {
      if (state.target?.cwd === cwd) return;
      calls.push(['workspace', cwd]); begin();
      try { state.target = handlers.workspace ? await handlers.workspace(cwd) : targets.find((entry) => entry.cwd === cwd); }
      finally { end(); }
    },
    async switchSession(path) {
      calls.push(['session', path]); begin();
      try {
        if (handlers.session) await handlers.session(path);
        const destination = byPath.get(path);
        if (!destination || destination.cwd !== state.target?.cwd) throw new Error('missing session');
        state.target = destination;
      } finally { end(); }
    },
  };
  controller = new SessionNavigationController(adapter);
  controller.observe();
  return { controller, state, calls, handlers, adapter, async userVisit(entry) { state.intent += 1; state.target = entry; state.ready = true; emit(); await settle(); } };
}

test('async back/forward skips intermediate workspace restores and commits once at the actual target', async () => {
  const a = target('a'); const b = target('b', 'D:/other'); const intermediate = target('remembered');
  const f = fixture(a, [intermediate, a, b]);
  await settle(); await f.userVisit(b);
  const gate = deferred();
  f.handlers.session = () => gate.promise;
  const back = f.controller.goBack();
  await settle();
  assert.equal(f.controller.getSnapshot().navigating, true);
  assert.equal(f.controller.getSnapshot().history.cursor, 1);
  assert.deepEqual(f.controller.getSnapshot().history.entries, [a, b]);
  assert.equal(f.state.target.sessionId, 'remembered');
  await f.controller.goBack();
  assert.equal(f.calls.length, 2, 'repeated clicks while pending do not enqueue extra navigation');
  gate.resolve(); await back;
  assert.equal(f.state.target.sessionId, 'a');
  assert.equal(f.controller.getSnapshot().history.cursor, 0);
  assert.equal(f.controller.getSnapshot().navigating, false);
  delete f.handlers.session;
  await f.controller.goForward();
  assert.equal(f.controller.getSnapshot().history.cursor, 1);
  assert.deepEqual(f.controller.getSnapshot().history.entries, [a, b]);
});

test('failed navigation rolls back its partial workspace change without advancing history', async () => {
  const a = target('a'); const b = target('b', 'D:/other'); const intermediate = target('remembered');
  const f = fixture(a, [intermediate, a, b]);
  await settle(); await f.userVisit(b);
  f.handlers.session = async () => { throw new Error('target removed'); };
  await f.controller.goBack();
  assert.equal(f.state.target.sessionId, 'b');
  assert.equal(f.controller.getSnapshot().history.cursor, 1);
  assert.deepEqual(f.controller.getSnapshot().history.entries, [a, b]);
  assert.equal(f.controller.getSnapshot().error, 'target removed');
  assert.equal(f.controller.getSnapshot().navigating, false);
  f.controller.clearError();
  assert.equal(f.controller.getSnapshot().error, null);
});

test('a failed rollback reconciles the real view without moving the history cursor', async () => {
  const a = target('a'); const b = target('b', 'D:/other'); const intermediate = target('remembered');
  const f = fixture(a, [intermediate, a, b]);
  await settle(); await f.userVisit(b);
  f.handlers.workspace = async (cwd) => { if (cwd === b.cwd) throw new Error('workspace unavailable'); return intermediate; };
  f.handlers.session = async () => { throw new Error('target removed'); };
  await f.controller.goBack();
  assert.equal(f.state.target.sessionId, 'remembered');
  assert.equal(f.controller.getSnapshot().history.cursor, 1);
  assert.deepEqual(f.controller.getSnapshot().history.entries[1], intermediate);
  assert.equal(f.controller.getSnapshot().error, 'target removed');
});

test('a newer user visit supersedes pending work, suppresses stale errors and never triggers rollback', async () => {
  const a = target('a'); const b = target('b', 'D:/other'); const c = target('c', 'E:/latest');
  const f = fixture(a, [a, b, c]);
  await settle(); await f.userVisit(b);
  const gate = deferred();
  f.handlers.workspace = () => gate.promise;
  const back = f.controller.goBack();
  await f.userVisit(c);
  gate.reject(new Error('old request failed'));
  await back; await settle();
  assert.equal(f.state.target.sessionId, 'c');
  assert.deepEqual(f.controller.getSnapshot().history.entries, [a, b, c]);
  assert.equal(f.controller.getSnapshot().error, null);
  assert.equal(f.calls.length, 1, 'no second-stage switch or rollback may steal the newer visit');
});

test('replacing the bridge resets history and invalidates an older in-flight request', async () => {
  const a = target('a'); const b = target('b'); const c = target('c', 'E:/new-host');
  const f = fixture(a, [a, b, c]);
  await settle(); await f.userVisit(b);
  const gate = deferred(); f.handlers.session = () => gate.promise;
  const back = f.controller.goBack();
  f.state.owner = {}; f.state.intent = 0; f.state.target = c; f.state.ready = true; f.controller.observe();
  gate.reject(new Error('old host failed'));
  await back; await settle();
  assert.deepEqual(f.controller.getSnapshot().history.entries, [c]);
  assert.equal(f.controller.getSnapshot().error, null);
  assert.equal(f.controller.getSnapshot().navigating, false);
});

test('manual chained project/session selection records only its final conversation', async () => {
  const a = target('a'); const intermediate = target('remembered', 'D:/other'); const b = target('b', 'D:/other');
  const f = fixture(a, [a, intermediate, b]);
  await settle();
  await f.adapter.switchWorkspace(b.cwd);
  await f.adapter.switchSession(b.sessionPath);
  await settle();
  assert.deepEqual(f.controller.getSnapshot().history.entries, [a, b]);
});

test('a new manual navigation clears a previous failure even when reopening the same conversation', async () => {
  const a = target('a'); const b = target('b');
  const f = fixture(a, [a, b]);
  await settle(); await f.userVisit(b);
  f.handlers.session = async () => { throw new Error('target removed'); };
  await f.controller.goBack();
  assert.equal(f.controller.getSnapshot().error, 'target removed');
  delete f.handlers.session;
  const gate = deferred(); f.handlers.session = () => gate.promise;
  const pending = f.adapter.switchSession(b.sessionPath);
  assert.equal(f.controller.getSnapshot().error, null, 'new intent clears the error before ready returns');
  gate.resolve(); await pending; await settle();
  assert.deepEqual(f.controller.getSnapshot().history.entries, [a, b]);
  assert.equal(f.controller.getSnapshot().history.cursor, 1);
});

test('an immediate back shortcut flushes the current visit before planning its destination', async () => {
  const a = target('a'); const b = target('b'); const c = target('c');
  const f = fixture(a, [a, b, c]);
  await settle(); await f.userVisit(b);
  f.state.intent += 1; f.state.target = c; f.controller.observe();
  await f.controller.goBack();
  assert.equal(f.state.target.sessionId, 'b');
  assert.deepEqual(f.controller.getSnapshot().history.entries, [a, b, c]);
  assert.equal(f.controller.getSnapshot().history.cursor, 1);
});
