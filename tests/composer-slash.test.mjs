import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slashTriggerAt, completeSlashCommand, parseSlashCommand } from '../packages/ui/src/composerSlash.ts';

test('slash completion follows the initial command token without interpreting prose, paths or arguments', () => {
  assert.deepEqual(slashTriggerAt('/', 1), { start: 0, end: 1, query: '' });
  assert.deepEqual(slashTriggerAt('  /skill:review 后续正文', 8), { start: 2, end: 15, query: 'skill' });
  assert.equal(slashTriggerAt('解释 /new', 7), null);
  assert.equal(slashTriggerAt('/src/file.ts', 4), null);
  assert.equal(slashTriggerAt('/name 测试', 8), null);
  assert.equal(slashTriggerAt('`/name`', 6), null);
  assert.equal(slashTriggerAt('/name', 2, 4), null);
});

test('command completion preserves arguments and suffix and command parsing keeps multiline arguments', () => {
  const draft = '  /skill:review 后续正文';
  assert.deepEqual(completeSlashCommand(draft, slashTriggerAt(draft, 8), 'name'), { text: '  /name 后续正文', caret: 8 });
  assert.deepEqual(completeSlashCommand('/na', slashTriggerAt('/na', 3), 'name'), { text: '/name ', caret: 6 });
  assert.deepEqual(parseSlashCommand(' /skill:review src/a.ts\n关注错误处理 '), { name: 'skill:review', args: 'src/a.ts\n关注错误处理' });
  assert.deepEqual(parseSlashCommand('/unknown'), { name: 'unknown', args: '' });
  assert.deepEqual(parseSlashCommand('/'), { name: '', args: '' });
  assert.equal(parseSlashCommand('/src/file.ts'), null);
  assert.equal(parseSlashCommand('ordinary /name'), null);
});
