import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionTiming } from '../packages/agent/src/sessionMetrics.ts';
import { conversationMetricsAt, formatMetricDuration, formatMetricTokens } from '../packages/ui/src/conversationMetrics.ts';

const run = (id, startedAt, finishedAt = null, status = finishedAt === null ? 'running' : 'completed') => ({ id, startedAt, finishedAt, status });
const boundary = value => ({ type: 'custom', customType: 'pi-desktop:conversation-run-v1', id: `${value.id}-${value.status}`, data: { version: 1, run: value } });
const message = (id, output = 10, role = 'assistant') => ({ type: 'message', id, message: { role, usage: { output } } });

test('full branch timing sums observed tasks and excludes idle gaps; speed uses only the latest task output', () => {
  const entries = [boundary(run('first', 1000)), message('one', 70), boundary(run('first', 1000, 3000)), boundary(run('second', 9000)), message('two', 20), message('tool', 999, 'toolResult'), message('three', 40), boundary(run('second', 9000, 12000))];
  const timing = sessionTiming(entries, null, 20000);
  assert.equal(timing.durationMs, 5000);
  assert.equal(timing.latestRun.outputTokens, 60);
  assert.equal(timing.running, false);
  assert.deepEqual(conversationMetricsAt({ timing }, 99000), { durationMs: 5000, tokensPerSecond: 20 });
});

test('active task elapsed time starts before tokens, advances between samples and stops on idle', () => {
  const active = run('active', 1000);
  const entries = [boundary(active)];
  const waiting = sessionTiming(entries, active, 6000);
  assert.deepEqual(conversationMetricsAt({ timing: waiting }, 7000), { durationMs: 6000, tokensPerSecond: null });
  const producing = sessionTiming([...entries, message('output', 120)], active, 6000);
  assert.deepEqual(conversationMetricsAt({ timing: producing }, 7000), { durationMs: 6000, tokensPerSecond: 20 });
  assert.deepEqual(conversationMetricsAt({ timing: producing }, 7000, false), { durationMs: 5000, tokensPerSecond: 24 });
  assert.deepEqual(conversationMetricsAt({ timing: producing }, 100, true), { durationMs: 5000, tokensPerSecond: 24 }, 'clock moving backwards never subtracts observed time');
});

test('legacy and interrupted history never fabricate a duration or divide by zero', () => {
  const old = sessionTiming([message('old')], null, 5000);
  assert.deepEqual(conversationMetricsAt({ timing: old }, 9000), { durationMs: null, tokensPerSecond: null });
  const crashed = sessionTiming([boundary(run('crashed', 1000)), message('output')], null, 5000);
  assert.equal(crashed.durationMs, null);
  assert.equal(crashed.latestRun.durationMs, null);
  assert.equal(conversationMetricsAt({ timing: crashed }, 9000).tokensPerSecond, null);
  const instant = sessionTiming([boundary(run('instant', 1000)), message('output'), boundary(run('instant', 1000, 1000))], null, 5000);
  assert.equal(conversationMetricsAt({ timing: instant }, 9000).tokensPerSecond, null);
  assert.deepEqual(conversationMetricsAt(null, 9000), { durationMs: null, tokensPerSecond: null });
  assert.equal(sessionTiming([], null, 5000).durationMs, 0);
});

test('older untracked messages keep aggregate timing unknown while a new measured task has a valid speed', () => {
  const entries = [message('legacy'), boundary(run('new', 1000)), message('new-output', 30), boundary(run('new', 1000, 4000))];
  assert.deepEqual(conversationMetricsAt({ timing: sessionTiming(entries, null, 5000) }, 5000), { durationMs: null, tokensPerSecond: 10 });
});

test('branch timing does not include siblings or live tasks from other session data', () => {
  const firstBranch = [boundary(run('one', 1000)), message('output', 50), boundary(run('one', 1000, 2000))];
  const secondBranch = [boundary(run('two', 3000)), message('another-output', 100), boundary(run('two', 3000, 5000))];
  assert.equal(sessionTiming(firstBranch, null, 9000).durationMs, 1000);
  assert.equal(sessionTiming(secondBranch, null, 9000).durationMs, 2000);
});

test('compact metric labels preserve zero and unavailable values and format long sessions', () => {
  assert.equal(formatMetricTokens(0, 'en-US'), '0');
  assert.equal(formatMetricTokens(undefined, 'en-US'), '—');
  assert.equal(formatMetricTokens(NaN, 'en-US'), '—');
  assert.equal(formatMetricTokens(1250, 'en-US'), '1.3K');
  assert.equal(formatMetricTokens(1234000, 'en-US'), '1.2M');
  assert.equal(formatMetricDuration(null), '—');
  assert.equal(formatMetricDuration(55999), '55s');
  assert.equal(formatMetricDuration(125000), '2m 5s');
  assert.equal(formatMetricDuration(7380000), '2h 3m');
});

const key = 'pi-desktop:conversation-metrics';
let imports = 0;
async function withPreferences(storage, runTest) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const target = new EventTarget(); target.localStorage = storage;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target });
  try { await runTest(await import(`../packages/ui/src/conversationMetricsPreferences.ts?test=${++imports}`), target); }
  finally { if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; }
}
const memoryStorage = initial => { const values = new Map(initial ? [[key, initial]] : []); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; };

test('metric preferences default on, independently persist, and sync between windows', async () => {
  const storage = memoryStorage();
  await withPreferences(storage, (preferences, target) => {
    assert.deepEqual(preferences.getConversationMetricsPreferences(), { speed: true, tokens: true, duration: true, balance: true });
    const updates = []; const unsubscribe = preferences.subscribeConversationMetricsPreferences(() => updates.push(preferences.getConversationMetricsPreferences()));
    assert.equal(preferences.setConversationMetricsPreferences({ tokens: false }), true);
    assert.deepEqual(preferences.getConversationMetricsPreferences(), { speed: true, tokens: false, duration: true, balance: true });
    target.dispatchEvent(Object.assign(new Event('storage'), { key, newValue: JSON.stringify({ duration: false }), storageArea: storage }));
    assert.deepEqual(preferences.getConversationMetricsPreferences(), { speed: true, tokens: true, duration: false, balance: true });
    target.dispatchEvent(Object.assign(new Event('storage'), { key: 'unrelated', newValue: '{}', storageArea: storage }));
    assert.equal(updates.length, 2);
    unsubscribe();
  });
  await withPreferences(storage, preferences => assert.equal(preferences.getConversationMetricsPreferences().tokens, false));
  // Blobs saved before the cache metric was removed keep working; the retired key is ignored.
  await withPreferences(memoryStorage('{"speed":true,"tokens":true,"cache":false,"duration":true}'), preferences => assert.deepEqual(preferences.getConversationMetricsPreferences(), { speed: true, tokens: true, duration: true, balance: true }));
});

test('invalid saved metric preferences recover and blocked persistence keeps the local choice', async () => {
  for (const value of ['not json', 'null', '{"speed":"no"}', '[]']) await withPreferences(memoryStorage(value), preferences => assert.equal(preferences.getConversationMetricsPreferences().speed, true));
  await withPreferences({ getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } }, preferences => {
    assert.equal(preferences.setConversationMetricsPreferences({ speed: false, tokens: false, duration: false }), false);
    assert.deepEqual(preferences.getConversationMetricsPreferences(), { speed: false, tokens: false, duration: false, balance: true });
  });
});
