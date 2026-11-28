import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { subagentFleetHasActive } from '../packages/shared/src/subagentFeatures.ts';

// Mirrors pi-subagents' asyncJobOrder: running > queued > settled, then the most
// recent updatedAt first. That ordering is what made the fleet rows jump.
function pluginOrder(nodes) {
  const rank = (node) => (node.state === 'running' ? 0 : node.state === 'queued' ? 1 : 2);
  const time = (node) => node.updatedAt ?? node.startedAt ?? 0;
  return [...nodes].sort((left, right) => rank(left) - rank(right) || time(right) - time(left) || left.id.localeCompare(right.id));
}

function snapshot(runs, generatedAt) {
  return { generatedAt, omittedRuns: 0, omittedChildren: 0, runs: pluginOrder(runs) };
}

const ids = (nodes) => nodes.map((node) => node.id);

test('subagent fleet keeps rows in first-seen order across repeated updates', async (t) => {
  const { stabilizeSubagentFleetOrder } = await import('../packages/agent/src/index.ts');

  await t.test('progress ticks and state changes never reorder known runs', () => {
    const base = 1_000_000;
    const runs = [
      { id: 'a', kind: 'subagent', label: 'scout', state: 'running', startedAt: base + 100, updatedAt: base + 100 },
      { id: 'b', kind: 'subagent', label: 'reviewer', state: 'running', startedAt: base + 200, updatedAt: base + 200 },
      { id: 'c', kind: 'subagent', label: 'tester', state: 'queued', startedAt: base + 300, updatedAt: base + 300 },
    ];
    let fleet = stabilizeSubagentFleetOrder(snapshot(runs, base + 300), null);
    assert.deepEqual(ids(fleet.runs), ['a', 'b', 'c'], 'first snapshot is ordered oldest start first');
    const pluginOrders = new Set();
    for (let tick = 1; tick <= 40; tick++) {
      const now = base + 1000 * tick;
      // Alternate which run reports activity so the plugin's recency sort flips.
      const busy = runs[tick % runs.length];
      busy.updatedAt = now;
      if (tick === 10) runs[2].state = 'running';
      if (tick === 20) runs[0].state = 'complete';
      if (tick === 30) runs[1].state = 'failed';
      const incoming = snapshot(runs.map((run) => ({ ...run })), now);
      pluginOrders.add(ids(incoming.runs).join(','));
      fleet = stabilizeSubagentFleetOrder(incoming, fleet);
      assert.deepEqual(ids(fleet.runs), ['a', 'b', 'c'], `tick ${tick} keeps the original order`);
      assert.equal(fleet.runs.find((run) => run.id === busy.id)?.updatedAt, now, 'fresh data still flows through');
    }
    assert.ok(pluginOrders.size > 1, 'the raw plugin order really does reshuffle (the regression this guards)');
  });

  await t.test('new runs append after known ones and removed runs drop out', () => {
    const first = stabilizeSubagentFleetOrder(snapshot([
      { id: 'a', kind: 'subagent', label: 'a', state: 'complete', startedAt: 10, updatedAt: 50 },
      { id: 'b', kind: 'subagent', label: 'b', state: 'running', startedAt: 20, updatedAt: 60 },
    ], 60), null);
    assert.deepEqual(ids(first.runs), ['a', 'b']);
    const second = stabilizeSubagentFleetOrder(snapshot([
      { id: 'a', kind: 'subagent', label: 'a', state: 'complete', startedAt: 10, updatedAt: 50 },
      { id: 'b', kind: 'subagent', label: 'b', state: 'running', startedAt: 20, updatedAt: 90 },
      { id: 'd', kind: 'subagent', label: 'd', state: 'running', startedAt: 80, updatedAt: 95 },
      { id: 'c', kind: 'workflow', label: 'c', state: 'queued', startedAt: 70 },
    ], 95), first);
    assert.deepEqual(ids(second.runs), ['a', 'b', 'c', 'd'], 'new runs follow, oldest start first');
    const third = stabilizeSubagentFleetOrder(snapshot([
      { id: 'b', kind: 'subagent', label: 'b', state: 'complete', startedAt: 20, updatedAt: 120 },
      { id: 'c', kind: 'workflow', label: 'c', state: 'running', startedAt: 70, updatedAt: 130 },
      { id: 'd', kind: 'subagent', label: 'd', state: 'running', startedAt: 80, updatedAt: 125 },
    ], 130), second);
    assert.deepEqual(ids(third.runs), ['b', 'c', 'd']);
  });

  await t.test('children keep their first-seen order and the input is not mutated', () => {
    const child = (id, state, updatedAt) => ({ id, kind: 'subagent', label: id, state, startedAt: 5, updatedAt });
    const workflow = (children, updatedAt) => ({ id: 'w', kind: 'workflow', label: 'w', state: 'running', startedAt: 1, updatedAt, children });
    const first = stabilizeSubagentFleetOrder(snapshot([workflow([child('x', 'running', 10), child('y', 'running', 11), child('z', 'queued', 12)], 12)], 12), null);
    assert.deepEqual(ids(first.runs[0].children), ['x', 'y', 'z']);
    const incomingChildren = pluginOrder([child('x', 'complete', 30), child('y', 'running', 20), child('z', 'running', 40), child('n', 'queued', 41)]);
    const incoming = snapshot([workflow(incomingChildren, 41)], 41);
    const before = JSON.stringify(incoming);
    const next = stabilizeSubagentFleetOrder(incoming, first);
    assert.deepEqual(ids(next.runs[0].children), ['x', 'y', 'z', 'n']);
    assert.equal(JSON.stringify(incoming), before, 'the projected snapshot is left untouched');
  });

  await t.test('a cleared fleet starts ordering afresh', () => {
    const fleet = stabilizeSubagentFleetOrder(snapshot([
      { id: 'late', kind: 'subagent', label: 'late', state: 'running', startedAt: 200, updatedAt: 300 },
      { id: 'early', kind: 'subagent', label: 'early', state: 'running', startedAt: 100, updatedAt: 400 },
    ], 400), null);
    assert.deepEqual(ids(fleet.runs), ['early', 'late']);
  });
});

test('subagentFleetHasActive identifies whether any non-monitor subagent is still queued or running', () => {
  assert.equal(subagentFleetHasActive(null), false);
  assert.equal(subagentFleetHasActive(undefined), false);
  assert.equal(subagentFleetHasActive(snapshot([], 100)), false);

  for (const state of ['complete', 'failed', 'partial', 'paused', 'stopped', 'rejected']) {
    assert.equal(
      subagentFleetHasActive(snapshot([{ id: `run-${state}`, kind: 'subagent', label: 'rea-auditor', state, children: [{ id: 'step:0', kind: 'step', label: 'rea-auditor', state }] }], 100)),
      false,
      `terminal state ${state} is inactive`,
    );
  }

  assert.equal(
    subagentFleetHasActive(snapshot([{
      id: 'wf-done', kind: 'workflow', label: 'audit', state: 'complete',
      children: [
        { id: 'step:0', kind: 'step', label: 'rea-auditor', state: 'complete' },
        { id: 'host:0', kind: 'host-step', label: 'watchdog', state: 'queued' },
      ],
    }], 100)),
    false,
    'a finished workflow with only a host-step monitor left is inactive',
  );

  assert.equal(subagentFleetHasActive(snapshot([{ id: 'r', kind: 'subagent', label: 'scout', state: 'running' }], 100)), true);
  assert.equal(subagentFleetHasActive(snapshot([{ id: 'q', kind: 'subagent', label: 'scout', state: 'queued' }], 100)), true);
  assert.equal(
    subagentFleetHasActive(snapshot([{
      id: 'wf-between', kind: 'workflow', label: 'audit', state: 'running',
      children: [{ id: 'step:0', kind: 'step', label: 'scout', state: 'complete' }],
    }], 100)),
    true,
    'a running workflow between steps stays active',
  );
  assert.equal(
    subagentFleetHasActive(snapshot([{
      id: 'wf-partial', kind: 'workflow', label: 'audit', state: 'failed',
      children: [{ id: 'step:0', kind: 'step', label: 'rea-auditor', state: 'running' }],
    }], 100)),
    true,
    'a still-running child keeps the fleet active even if its parent settled',
  );
});

test('subagent widget clears the fleet automatically once all runs settle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-fleet-autohide-'));
  const saved = { dir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  process.env.PI_OFFLINE = '1';
  const { AgentService } = await import('../packages/agent/src/index.ts');
  const service = new AgentService();
  try {
    const context = service.newContext('active');
    const fleetEvents = [];
    context.onEvent(({ event }) => {
      if (event.type === 'subagent-fleet') fleetEvents.push(event);
    });
    const widget = (runs, generatedAt) => [`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify({
      kind: 'pi-subagents.async-status-snapshot', version: 1, generatedAt, omitted: { runs: 0, children: 0 }, runs,
    })}`];

    // An initial all-completed snapshot never surfaces or emits an event.
    context.consumeSubagentWidget('subagent-async', widget([
      { id: 'done-0', kind: 'subagent', label: 'rea-auditor', state: 'complete', children: [{ id: 'step:0', kind: 'step', label: 'rea-auditor', state: 'complete' }] },
    ], 100));
    assert.equal(context.getSnapshot().subagentFleet, null);
    assert.equal(fleetEvents.length, 0);

    // Active work surfaces normally and keeps completed siblings while another agent is still running.
    context.consumeSubagentWidget('subagent-async', widget([
      { id: 'run-a', kind: 'subagent', label: 'analyst', state: 'running', startedAt: 10 },
      { id: 'run-b', kind: 'subagent', label: 'auditor', state: 'running', startedAt: 20 },
    ], 200));
    assert.deepEqual(ids(context.getSnapshot().subagentFleet.runs), ['run-a', 'run-b']);

    context.consumeSubagentWidget('subagent-async', widget([
      { id: 'run-a', kind: 'subagent', label: 'analyst', state: 'complete', startedAt: 10, endedAt: 250 },
      { id: 'run-b', kind: 'subagent', label: 'auditor', state: 'running', startedAt: 20 },
    ], 300));
    assert.deepEqual(ids(context.getSnapshot().subagentFleet.runs), ['run-a', 'run-b']);

    // Once the last running subagent finishes, the fleet clears immediately even if the plugin keeps polling it.
    fleetEvents.length = 0;
    const allDone = widget([
      { id: 'run-a', kind: 'subagent', label: 'analyst', state: 'complete', startedAt: 10, endedAt: 250 },
      { id: 'run-b', kind: 'subagent', label: 'auditor', state: 'complete', startedAt: 20, endedAt: 350, children: [{ id: 'step:0', kind: 'step', label: 'auditor', state: 'complete' }] },
    ], 400);
    context.consumeSubagentWidget('subagent-async', allDone);
    assert.equal(context.getSnapshot().subagentFleet, null);
    assert.equal(fleetEvents.length, 1);
    assert.equal(fleetEvents[0].fleet, null);

    // Subsequent stale all-completed ticks stay silent.
    context.consumeSubagentWidget('subagent-async', allDone);
    assert.equal(fleetEvents.length, 1);

    // A brand-new active run surfaces again cleanly.
    context.consumeSubagentWidget('subagent-async', widget([
      { id: 'run-c', kind: 'subagent', label: 'reviewer', state: 'queued', startedAt: 500 },
    ], 500));
    assert.deepEqual(ids(context.getSnapshot().subagentFleet.runs), ['run-c']);
  } finally {
    await service.dispose();
    for (const [name, value] of [['PI_CODING_AGENT_DIR', saved.dir], ['PI_OFFLINE', saved.offline]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
