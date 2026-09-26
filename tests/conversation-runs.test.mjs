import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConversationRunTracker, readConversationRuns } from '../packages/agent/src/conversationRuns.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function assistant(content, stopReason = 'stop') { return { role: 'assistant', content, stopReason, api: 'anthropic-messages', provider: 'anthropic', model: 'fixture', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }; }
async function fixture(t, extension) {
  const root = await mkdtemp(join(tmpdir(), 'pi-conversation-runs-')), cwd = join(root, 'project'); await mkdir(cwd);
  if (extension) { await mkdir(join(cwd, '.pi', 'extensions'), { recursive: true }); await writeFile(join(cwd, '.pi', 'extensions', 'run-timing.ts'), extension); }
  const saved = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map(key => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent'); process.env.PI_OFFLINE = '1';
  const { AgentService } = await import('../packages/agent/src/index.ts');
  const f = { root, cwd, AgentService, service: new AgentService(async () => ({ trusted: true, remember: false })) };
  t.after(async () => { await f.service.dispose(); for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value; await rm(root, { recursive: true, force: true }); });
  await f.service.init({ cwd }); await f.service.setProviderApiKey('anthropic', 'local-fixture-no-network');
  const model = f.service.listModels().find(item => item.provider === 'anthropic'); assert.ok(model); await f.service.setModel(model.provider, model.id);
  f.session = f.service.active.runtime.session; f.session.settingsManager.setRetryEnabled(false); return f;
}

test('real SDK preserves whole runs across token waits, tool turns, follow-up consumption, background switches and restart', async t => {
  const f = await fixture(t), first = deferred(), firstStarted = deferred(), third = deferred(), thirdStarted = deferred(), events = [];
  f.service.onEvent(({ event }) => events.push(event)); await writeFile(join(f.cwd, 'read.txt'), 'local content');
  const responses = [assistant([{ type: 'text', text: 'Inspecting file' }, { type: 'toolCall', id: 'read-one', name: 'read', arguments: { path: 'read.txt' } }], 'toolUse'), assistant([{ type: 'text', text: 'First result' }]), assistant([{ type: 'text', text: 'Follow-up result' }])];
  let calls = 0;
  f.session.agent.streamFunction = async () => {
    const index = calls++, message = responses[index]; assert.ok(message);
    if (index === 0) { firstStarted.resolve(); await first.promise; } if (index === 2) { thirdStarted.resolve(); await third.promise; }
    return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: message.stopReason, message }; }, async result() { return message; } };
  };
  const before = Date.now(); await f.service.prompt('Inspect local file'); await firstStarted.promise;
  const initial = f.service.getSnapshot(), runId = initial.runs[0].id, path = initial.sessionPath;
  assert.equal(initial.runs[0].status, 'running'); assert(initial.runs[0].startedAt >= before); assert.equal(initial.runs[0].finishedAt, null);
  assert.equal(initial.messages.some(message => message.role === 'assistant'), false, 'timer starts before the provider emits its first token');
  const firstContext = f.service.active;
  await f.service.prompt('Follow up afterwards', 'followUp'); assert.equal(f.service.getSnapshot().runs.length, 1, 'waiting in the queue does not start a second timer');
  await f.service.newSession(); assert.deepEqual(f.service.getSnapshot().runs, []);
  first.resolve(); await thirdStarted.promise;
  const background = firstContext.getSnapshot(); assert.equal(background.runs[0].status, 'completed'); assert.equal(background.runs[1].status, 'running');
  assert.notEqual(background.runs[1].id, runId); assert.equal(background.activities[0].runId, runId);
  await f.service.switchSession(path); assert.deepEqual(f.service.getSnapshot().runs, background.runs);
  third.resolve(); await f.session.waitForIdle(); await tick();
  const finished = f.service.getSnapshot(); assert.equal(finished.runs.length, 2); assert(finished.runs.every(run => run.status === 'completed' && run.finishedAt >= run.startedAt));
  assert.deepEqual(finished.messages.filter(message => message.role === 'user').map(message => message.runId), finished.runs.map(run => run.id));
  assert.equal(finished.messages.find(message => message.text === 'First result').runId, runId);
  assert.equal(finished.messages.find(message => message.text === 'Follow-up result').runId, finished.runs[1].id);
  assert.equal(events.find(event => event.type === 'assistant-start').runId, finished.runs[1].id, 'background assistant events do not leak into the foreground');
  assert.equal(events.find(event => event.type === 'user-message').runId, runId);
  assert.deepEqual(f.service.getHistoryPage(0, 1).runs, [finished.runs[0]]);
  assert.doesNotMatch(JSON.stringify(f.service.getSessionTree()), /pi-desktop:conversation-run/);
  assert.equal((await readFile(path, 'utf8')).split('\n').filter(line => line.includes('pi-desktop:conversation-run-v1')).length, 4);
  await f.service.dispose(); f.service = new f.AgentService(); await f.service.init({ cwd: f.cwd, sessionPath: path });
  assert.deepEqual(f.service.getSnapshot().runs, finished.runs); assert.deepEqual(f.service.getSnapshot().messages.map(message => message.runId), finished.messages.map(message => message.runId));
});

test('SDK cancellation and failed requests finish accurately; handled commands never leave a running timer', async t => {
  const f = await fixture(t, `export default pi => {
    pi.registerCommand('handled', { handler: async () => {} });
    pi.registerCommand('fail-command', { handler: async () => { throw new Error('fixture command failed'); } });
  }`), entered = deferred();
  f.session.agent.streamFunction = async (_model, _context, options) => {
    entered.resolve(); await new Promise(resolve => options.signal.aborted ? resolve() : options.signal.addEventListener('abort', resolve, { once: true }));
    const message = assistant([], 'aborted');
    return { async *[Symbol.asyncIterator]() { yield { type: 'error', reason: 'aborted', error: message }; }, async result() { return message; } };
  };
  await f.service.prompt('Cancel this request'); await entered.promise; const cancelledId = f.service.getSnapshot().runs[0].id;
  await f.service.abort(); await f.session.waitForIdle(); await tick();
  assert.equal(f.service.getSnapshot().runs.find(run => run.id === cancelledId).status, 'cancelled');
  f.session.agent.streamFunction = async () => { const message = { ...assistant([], 'error'), errorMessage: 'fixture hard failure' }; return { async *[Symbol.asyncIterator]() { yield { type: 'error', reason: 'error', error: message }; }, async result() { return message; } }; };
  await f.service.prompt('Fail this request'); await f.session.waitForIdle(); await tick();
  const failed = f.service.getSnapshot().runs.at(-1); assert.equal(failed.status, 'failed'); assert(failed.finishedAt >= failed.startedAt);
  await f.service.prompt('/handled'); await tick(); assert.equal(f.service.getSnapshot().runs.at(-1).status, 'completed');
  await f.service.prompt('/fail-command'); await tick(); assert.equal(f.service.getSnapshot().runs.at(-1).status, 'failed');
  await f.session._handleAgentEvent({ type: 'agent_start' });
  await f.session._handleAgentEvent({ type: 'message_start', message: assistant([]) });
  await f.session._emitAgentSettled();
  assert.equal(f.service.getSnapshot().runs.at(-1).status, 'interrupted', 'a settled stream with no final assistant event must not claim successful completion');
});

test('persisted start without end is interrupted with unknown duration and legacy history gains no fabricated timer', async t => {
  const f = await fixture(t), manager = f.session.sessionManager, errors = [];
  const tracker = new ConversationRunTracker(manager, () => {}, error => errors.push(error));
  const run = tracker.begin(); const userId = manager.appendMessage({ role: 'user', content: 'crashed request', timestamp: Date.now() });
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const reopened = SessionManager.open(manager.getSessionFile(), undefined, f.cwd), history = readConversationRuns(reopened.getBranch());
  assert.deepEqual(history.runs, [{ ...run, status: 'interrupted', finishedAt: null }]); assert.deepEqual(errors, []);
  const legacy = SessionManager.inMemory(f.cwd); legacy.appendMessage({ role: 'user', content: 'old', timestamp: 1 }); legacy.appendMessage(assistant([{ type: 'text', text: 'old answer' }]));
  assert.deepEqual(readConversationRuns(legacy.getBranch()).runs, []);
  manager.appendMessage(assistant([{ type: 'text', text: 'original branch result' }])); tracker.finish();
  manager.branch(userId); const fork = new ConversationRunTracker(manager, () => {}, error => errors.push(error));
  const next = fork.begin(); manager.appendMessage({ role: 'user', content: 'different branch', timestamp: Date.now() }); fork.finish();
  const branched = readConversationRuns(manager.getBranch());
  assert.equal(branched.runs.find(item => item.id === run.id).finishedAt, null, 'a truncated branch never borrows the completed original branch duration');
  assert.equal(branched.runs.find(item => item.id === next.id).status, 'completed');
});

test('steering stays in the original run until the SDK actually settles', async t => {
  const f = await fixture(t), first = deferred(), entered = deferred(); let calls = 0;
  f.session.settingsManager.getRetrySettings = () => ({ enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 5 });
  f.session.agent.streamFunction = async () => {
    const index = calls++;
    if (index === 0) { entered.resolve(); await first.promise; }
    const message = index === 0 ? { ...assistant([], 'error'), errorMessage: '429 Too Many Requests' } : assistant([{ type: 'text', text: `Recovered result ${index}` }]);
    assert(index < 4, 'retry or steering must not replay indefinitely');
    return { async *[Symbol.asyncIterator]() { yield message.stopReason === 'error' ? { type: 'error', reason: 'error', error: message } : { type: 'done', reason: message.stopReason, message }; }, async result() { return message; } };
  };
  const events = []; f.service.onEvent(({ event }) => events.push(event));
  await f.service.prompt('Initial instruction'); await entered.promise;
  const runId = f.service.getSnapshot().runs[0].id;
  await f.service.prompt('Steer the current work', 'steer'); first.resolve();
  await f.session.waitForIdle(); await tick();
  const snapshot = f.service.getSnapshot(); assert.equal(snapshot.runs.length, 1); assert.equal(snapshot.runs[0].id, runId); assert.equal(snapshot.runs[0].status, 'completed');
  const users = snapshot.messages.filter(message => message.role === 'user'); assert.equal(users.length, 2); assert(users.every(message => message.runId === runId));
  assert.equal(events.filter(event => event.type === 'run' && event.run.status === 'running').length, 1);
  assert.equal(events.filter(event => event.type === 'run' && event.run.status === 'completed').length, 1);
});

test('an SDK automatic retry keeps its start time and completes only after the successful retry', async t => {
  const f = await fixture(t), events = []; let calls = 0;
  f.session.settingsManager.getRetrySettings = () => ({ enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 5 });
  f.service.onEvent(({ event }) => events.push(event));
  f.session.agent.streamFunction = async () => {
    const message = calls++ === 0 ? { ...assistant([], 'error'), errorMessage: '429 Too Many Requests' } : assistant([{ type: 'text', text: 'Recovered' }]);
    return { async *[Symbol.asyncIterator]() { yield message.stopReason === 'error' ? { type: 'error', reason: 'error', error: message } : { type: 'done', reason: message.stopReason, message }; }, async result() { return message; } };
  };
  await f.service.prompt('Retry this local fixture'); await f.session.waitForIdle(); await tick();
  assert.equal(calls, 2); assert(events.some(event => event.type === 'status' && event.attempt === 1));
  const runs = events.filter(event => event.type === 'run').map(event => event.run);
  assert.equal(runs.length, 2); assert.equal(runs[0].status, 'running'); assert.equal(runs[1].status, 'completed');
  assert.equal(runs[0].id, runs[1].id); assert.equal(runs[0].startedAt, runs[1].startedAt);
});

test('a failure before any user or assistant event survives restart only as the latest unanchored summary', async t => {
  const f = await fixture(t), manager = f.session.sessionManager;
  manager.appendMessage({ role: 'user', content: 'older history one', timestamp: 1 });
  manager.appendMessage({ role: 'user', content: 'older history two', timestamp: 2 });
  f.session.agent.state.model = undefined;
  await assert.rejects(f.service.prompt('Rejected during model preflight'), /model/i); await tick();
  const failed = f.service.getSnapshot().runs.at(-1), path = f.service.getSnapshot().sessionPath;
  assert.equal(failed.status, 'failed'); assert(failed.finishedAt >= failed.startedAt);
  await f.service.dispose(); f.service = new f.AgentService(); await f.service.init({ cwd: f.cwd, sessionPath: path });
  const snapshot = f.service.getSnapshot(); assert.deepEqual(snapshot.runs, [failed]); assert(snapshot.messages.every(message => !message.runId));
  assert.deepEqual(f.service.getHistoryPage(0, 1).runs, [], 'an older page cannot invent an insertion point for the later preflight result');
  assert.deepEqual(f.service.getHistoryPage(1, 1).runs, [failed]);
});

test('cancelling an authentication preflight prevents later dispatch and preserves the terminal run without messages', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(); let calls = 0;
  f.session.modelRuntime.hasConfiguredAuth = () => false;
  f.session.modelRuntime.checkAuth = async () => { entered.resolve(); await release.promise; return 'local-fixture'; };
  f.session.agent.streamFunction = () => { calls++; throw new Error('Cancelled preflight must not reach a provider'); };
  const pending = f.service.prompt('Cancel before authentication completes').catch(error => error);
  await entered.promise; const runId = f.service.getSnapshot().runs[0].id;
  await f.service.abort(); release.resolve(); assert.match((await pending).message, /取消/); await tick();
  const snapshot = f.service.getSnapshot(); assert.equal(calls, 0); assert.equal(snapshot.messages.length, 0);
  assert.equal(snapshot.runs.length, 1); assert.equal(snapshot.runs[0].id, runId); assert.equal(snapshot.runs[0].status, 'cancelled');
  const path = snapshot.sessionPath;
  await f.service.dispose(); f.service = new f.AgentService(); await f.service.init({ cwd: f.cwd, sessionPath: path });
  assert.deepEqual(f.service.getSnapshot().runs, snapshot.runs);
});
