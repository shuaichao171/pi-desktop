import assert from 'node:assert/strict';
import { test } from 'node:test';

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
