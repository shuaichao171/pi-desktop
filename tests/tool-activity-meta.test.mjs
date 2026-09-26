import assert from 'node:assert/strict';
import { test } from 'node:test';

test('tool activity metadata extraction powers structured tool cards', async (t) => {
  const { toolCallMeta, toolExitCode, isEditDiffText, toolResultMeta } = await import('../packages/agent/src/index.ts');

  await t.test('toolCallMeta collects touched paths and the command line', () => {
    assert.deepEqual(toolCallMeta({ file: 'src/a.ts', path: ' src/a.ts ', command: ' npm test ' }), { files: ['src/a.ts'], command: 'npm test' });
    assert.deepEqual(toolCallMeta({ paths: ['x', 'y', 3, 'x'] }), { files: ['x', 'y'], command: null });
    assert.deepEqual(toolCallMeta(null), { files: null, command: null });
    assert.deepEqual(toolCallMeta('edit'), { files: null, command: null });
    assert.equal(toolCallMeta({ files: Array.from({ length: 20 }, (_, index) => `f${index}`) }).files.length, 12);
  });

  await t.test('bash exit codes come from success and trailing error text', () => {
    assert.equal(toolExitCode('bash', false, ''), 0);
    assert.equal(toolExitCode('bash', true, 'output\n\nCommand exited with code 127'), 127);
    assert.equal(toolExitCode('bash', true, 'no code here'), null);
    assert.equal(toolExitCode('edit', true, 'Command exited with code 1'), null);
  });

  await t.test('Pi edit diffs are recognized while other results stay plain', () => {
    const diff = ' 1 keep\n-2 old line\n+2 new line\n  ...';
    assert.equal(isEditDiffText('edit', false, diff), true);
    assert.equal(isEditDiffText('edit', false, diff + '\n'), true);
    assert.equal(isEditDiffText('edit', true, diff), false);
    assert.equal(isEditDiffText('bash', false, diff), false);
    assert.equal(isEditDiffText('edit', false, 'Successfully wrote to src/a.ts'), false);
    assert.equal(isEditDiffText('edit', false, ''), false);
    // Context-only text without any changed row is not a diff.
    assert.equal(isEditDiffText('edit', false, ' 1 only context'), false);
  });

  await t.test('toolResultMeta pairs exit status with a capped diff', () => {
    assert.deepEqual(toolResultMeta('bash', true, 'log\n\nCommand exited with code 2'), { exitCode: 2, diff: null });
    assert.deepEqual(toolResultMeta('edit', false, '+1 new'), { exitCode: null, diff: '+1 new' });
    const capped = toolResultMeta('edit', false, `+1 ${'x'.repeat(60000)}`);
    assert.equal(capped.diff.length, 48000);
  });
});
