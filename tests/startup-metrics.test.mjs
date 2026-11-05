import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStartupMetrics, formatStartupSummary } from '../packages/desktop/src/main/startupMetrics.ts';

function fakeClock(startAt = 0) {
  let now = startAt;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

test('phase marks record once, in order, with deltas from the previous phase', () => {
  const clock = fakeClock(12);
  const metrics = createStartupMetrics({ now: clock.now });
  metrics.mark('main-start');
  clock.advance(30);
  metrics.mark('app-ready');
  metrics.mark('app-ready'); // duplicate phases are ignored
  clock.advance(48);
  metrics.mark('splash-created');
  assert.deepEqual(metrics.snapshot(), [
    { phase: 'main-start', atMs: 12, deltaMs: 0 },
    { phase: 'app-ready', atMs: 42, deltaMs: 30 },
    { phase: 'splash-created', atMs: 90, deltaMs: 48 },
  ]);
});

test('finish emits one summary line and one diagnostics record per phase', () => {
  const clock = fakeClock(0);
  const logs = [];
  const records = [];
  const metrics = createStartupMetrics({
    now: clock.now,
    enabled: true,
    logger: (...args) => logs.push(args.join(' ')),
    record: (record) => records.push({ ...record }),
  });
  metrics.mark('main-start');
  clock.advance(120);
  metrics.mark('app-ready');
  clock.advance(880);
  metrics.mark('first-frame');
  metrics.finish();
  metrics.finish(); // completion is one-shot
  metrics.mark('renderer-ready'); // late marks no longer count
  assert.equal(logs.length, 1);
  assert.equal(logs[0], '[pi-startup] cold start 1000ms main-start=0 app-ready=120 first-frame=1000');
  assert.deepEqual(records, [
    { phase: 'main-start', atMs: 0, deltaMs: 0, outcome: 'success' },
    { phase: 'app-ready', atMs: 120, deltaMs: 120, outcome: 'success' },
    { phase: 'first-frame', atMs: 1000, deltaMs: 880, outcome: 'success' },
  ]);
});

test('a disabled logger keeps the console quiet while diagnostics still records', () => {
  const logs = [];
  const records = [];
  const metrics = createStartupMetrics({
    now: () => 5,
    enabled: false,
    logger: (...args) => logs.push(args),
    record: (record) => records.push(record),
  });
  metrics.mark('main-start');
  metrics.finish();
  assert.equal(logs.length, 0);
  assert.equal(records.length, 1);
});

test('abort completes the timeline with a failure outcome', () => {
  const logs = [];
  const records = [];
  const metrics = createStartupMetrics({ now: () => 250, enabled: true, logger: (...args) => logs.push(args.join(' ')), record: (record) => records.push(record) });
  metrics.mark('main-start');
  metrics.mark('splash-shown');
  metrics.abort();
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\[pi-startup\] cold start failed after 250ms /);
  assert.ok(records.every((record) => record.outcome === 'failure'));
  metrics.finish();
  assert.equal(logs.length, 1, 'a failed timeline cannot be re-finished as success');
});

test('marks after completion are ignored entirely', () => {
  const clock = fakeClock(0);
  const records = [];
  const metrics = createStartupMetrics({ now: clock.now, record: (record) => records.push(record) });
  metrics.mark('app-ready');
  metrics.abort();
  clock.advance(500);
  metrics.mark('first-frame');
  assert.deepEqual(records.map((record) => record.phase), ['app-ready']);
});

test('formatStartupSummary rounds times and reports the last phase as the total', () => {
  const line = formatStartupSummary(
    [
      { phase: 'main-start', atMs: 0.4, deltaMs: 0 },
      { phase: 'first-frame', atMs: 1500.6, deltaMs: 1500.2 },
    ],
    'success',
  );
  assert.equal(line, '[pi-startup] cold start 1501ms main-start=0 first-frame=1501');
  assert.equal(formatStartupSummary([], 'failure'), '[pi-startup] cold start failed after 0ms ');
});
