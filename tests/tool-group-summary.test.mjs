import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyShellCommand, classifyToolActivity, countToolGroup, isExplorationGroup, toolGroupSummaryParts } from '../packages/ui/src/toolGroupSummary.ts';

test('read-only shell commands count as exploration, anything that writes or executes counts as a run', () => {
  for (const command of ['cat src/a.ts', 'head -n 20 README.md | wc -l', 'Get-Content .\\a.txt', "sed -n '1,40p' x.ts", 'cd src && cat a.ts']) {
    assert.equal(classifyShellCommand(command), 'read', command);
  }
  for (const command of ['rg "a|b" src', 'grep -rn foo . | head', 'ls -la', 'Get-ChildItem -Recurse', 'git status --short', 'git log --oneline -5', "bash -lc 'rg TODO'", 'find . -name "*.ts"']) {
    assert.equal(classifyShellCommand(command), 'search', command);
  }
  for (const command of ['npm test', 'cat a > b', 'echo hi >> log.txt', 'rg x $(rm -rf /)', 'cat `whoami`', 'find . -delete', 'sed -i s/a/b/ f', 'git commit -m x', 'ls && npm run build', 'grep "$(id)" a', 'Remove-Item x']) {
    assert.equal(classifyShellCommand(command), null, command);
  }
  assert.equal(classifyShellCommand('ls 2>/dev/null'), 'search', 'stderr redirection is not a write of results');
});

test('tool kinds and counts use distinct files for reads and edits', () => {
  assert.equal(classifyToolActivity({ tool: 'read' }), 'read');
  assert.equal(classifyToolActivity({ tool: 'grep' }), 'search');
  assert.equal(classifyToolActivity({ tool: 'edit' }), 'edit');
  assert.equal(classifyToolActivity({ tool: 'bash', command: 'pnpm build' }), 'run');
  assert.equal(classifyToolActivity({ tool: 'bash', command: 'cat a' }), 'read');
  assert.equal(classifyToolActivity({ tool: 'mcp_fetch' }), 'other');
  const counts = countToolGroup([
    { tool: 'read', files: ['a.ts'] }, { tool: 'read', files: ['a.ts'] }, { tool: 'read', files: ['b.ts'] },
    { tool: 'grep' }, { tool: 'bash', command: 'rg foo' },
    { tool: 'edit', files: ['a.ts'] }, { tool: 'write', files: ['a.ts'] },
    { tool: 'bash', command: 'pnpm test' },
  ]);
  assert.deepEqual(counts, { read: 2, search: 2, edit: 1, run: 1, subagent: 0, other: 0 });
  assert.equal(isExplorationGroup(counts), false);
  assert.deepEqual(toolGroupSummaryParts(counts, 'zh-CN'), ['读取 2 个文件', '搜索 2 次', '编辑 1 个文件', '运行 1 条命令']);
  assert.deepEqual(toolGroupSummaryParts(counts, 'en-US'), ['Read 2 files', '2 searches', 'Edited 1 file', 'Ran 1 command']);
  const explore = countToolGroup([{ tool: 'read', files: ['x.md'] }, { tool: 'ls' }]);
  assert.equal(isExplorationGroup(explore), true);
  assert.deepEqual(toolGroupSummaryParts(explore, 'en-US'), ['Read 1 file', '1 search']);
});
