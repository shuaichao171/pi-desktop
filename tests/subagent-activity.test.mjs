import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyToolActivity, countToolGroup, toolGroupSummaryParts } from '../packages/ui/src/toolGroupSummary.ts';

test('pi-subagents tool payloads project into structured subagent cards', async (t) => {
  const { subagentSnapshot } = await import('../packages/agent/src/index.ts');

  await t.test('start event extracts agent/task/async from args alone', () => {
    const snapshot = subagentSnapshot({ agent: 'researcher', task: '读取 package.json 并报告 name 字段的值', async: true });
    assert.equal(snapshot.agent, 'researcher');
    assert.equal(snapshot.async, true);
    assert.ok(snapshot.task?.startsWith('读取 package.json'));
    assert.equal(snapshot.turnCount, null);
  });

  await t.test('update payloads merge live progress over previous snapshot', () => {
    const previous = subagentSnapshot({ agent: 'researcher', task: 'research', async: false });
    const payload = {
      content: [{ type: 'text', text: '(running...)' }],
      details: {
        mode: 'single',
        progress: [{
          currentTool: 'read', currentToolArgs: 'package.json', activityState: 'model',
          model: 'zhipu/glm-5.3', turnCount: 3, toolCount: 5, tokens: 4200, durationMs: 8_400,
          recentTools: [
            { tool: 'read', args: 'a.json' }, { tool: 'grep', args: 'name' },
            { tool: 'read', args: 'b.json' }, { tool: 'read', args: 'c.json' },
            { tool: 'read', args: 'd.json' }, { tool: 'read', args: 'e.json' }, { tool: 'read', args: 'f.json' },
          ],
        }],
        results: [{ runId: 'run-123', outputReference: { message: '报告存于 research.md' } }],
      },
    };
    const merged = subagentSnapshot(undefined, payload, previous);
    assert.equal(merged.agent, 'researcher');
    assert.equal(merged.model, 'zhipu/glm-5.3');
    assert.equal(merged.turnCount, 3);
    assert.equal(merged.toolCount, 5);
    assert.equal(merged.tokens, 4200);
    assert.equal(merged.currentTool, 'read');
    assert.equal(merged.runId, 'run-123');
    assert.equal(merged.outputReference, '报告存于 research.md');
    assert.equal(merged.recentTools.length, 5, 'recent tools stay bounded to the last five');
    assert.equal(merged.recentTools.at(-1)?.args, 'f.json');
  });

  await t.test('malformed payloads degrade without throwing', () => {
    const fallback = subagentSnapshot({ agent: 'scout', task: 'x' }, 'not-an-object');
    assert.equal(fallback.agent, 'scout');
    const garbage = subagentSnapshot(null, { details: { progress: [{ tokens: 'lots', recentTools: 'no' }] }, results: 7 });
    assert.equal(garbage.agent, 'subagent');
    assert.equal(garbage.tokens, null);
    assert.equal(garbage.recentTools, null);
    assert.equal(subagentSnapshot('junk').agent, 'subagent');
  });

  await t.test('delegation defaults to background; only an explicit false is foreground', () => {
    assert.equal(subagentSnapshot({ agent: 'researcher', task: 'x' })?.async, true);
    assert.equal(subagentSnapshot({ agent: 'researcher', task: 'x', async: false })?.async, false);
    assert.equal(subagentSnapshot({ action: 'list' })?.async, undefined);
  });

  await t.test('detached ACK text yields the background run id', () => {
    const ack = { content: [{ type: 'text', text: 'Run fan-out: 1/64 used\nAsync: researcher [6e0c5f1c-6894-4d3f-b0aa-b91daef8c5c5]\n\nThe async run is detached and running in the background.' }] };
    const snapshot = subagentSnapshot({ agent: 'researcher', task: 'x' }, ack);
    assert.equal(snapshot.runId, '6e0c5f1c-6894-4d3f-b0aa-b91daef8c5c5');
    assert.equal(snapshot.async, true);
  });

  await t.test('string output references pass through directly', () => {
    const snapshot = subagentSnapshot(undefined, { details: { results: [{ outputReference: 'E:/out/research.md' }] } });
    assert.equal(snapshot.outputReference, 'E:/out/research.md');
  });
});

test('subagent calls count as their own group instead of other', () => {
  assert.equal(classifyToolActivity({ tool: 'subagent', command: null }), 'subagent');
  const counts = countToolGroup([
    { tool: 'subagent', command: null },
    { tool: 'read', command: null, files: ['a.ts'] },
    { tool: 'bash', command: 'npm test' },
  ]);
  assert.deepEqual(counts, { read: 1, search: 0, edit: 0, run: 1, subagent: 1, other: 0 });
  const zh = toolGroupSummaryParts(counts, 'zh-CN').join(' · ');
  assert.ok(zh.includes('子代理 1 次'), zh);
  const en = toolGroupSummaryParts(counts, 'en-US').join(' · ');
  assert.ok(en.includes('1 subagent call'), en);
});
