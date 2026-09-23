import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';

test('workbench file access stays within the workspace and Git diff includes deleted files', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-workbench-'));
  const workspace = join(tempRoot, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(tempRoot, 'outside.txt'), 'outside');
  writeFileSync(join(workspace, 'gone.txt'), 'before\n');
  writeFileSync(join(workspace, 'readme.txt'), 'hello\n');
  const { WorkbenchService } = await import('../packages/desktop/src/main/workbenchService.ts');
  const service = new WorkbenchService(() => workspace, () => {});
  try {
    const entries = await service.listEntries();
    assert.ok(entries.some((entry) => entry.path === 'readme.txt' && entry.kind === 'file'));
    assert.equal(await service.readFile('readme.txt'), 'hello\n');
    await assert.rejects(service.readFile('../outside.txt'), /不属于当前工作区/);
    await assert.rejects(service.listEntries('../'), /不属于当前工作区/);

    execFileSync('git', ['-C', workspace, 'init', '-q']);
    execFileSync('git', ['-C', workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'add', '--', 'gone.txt']);
    execFileSync('git', ['-C', workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base']);
    unlinkSync(join(workspace, 'gone.txt'));
    const status = await service.gitStatus();
    assert.equal(status.isRepository, true);
    assert.ok(status.entries.some((entry) => entry.path === 'gone.txt' && entry.status.includes('D')));
    assert.match(await service.gitDiff('gone.txt'), /-before/);
    assert.ok(status.entries.some((entry) => entry.path === 'readme.txt' && entry.status === '??'));
    assert.match(await service.gitDiff('readme.txt'), /\+hello/);
    await assert.rejects(service.gitDiff('../outside.txt'), /不属于当前工作区/);
  } finally {
    await service.dispose();
    const resolvedTemp = resolve(tempRoot);
    if (!resolvedTemp.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('Unsafe temporary path');
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
});

test('workbench runs an explicit command in the selected workspace and streams its output', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-command-'));
  const workspace = join(tempRoot, 'workspace');
  mkdirSync(workspace);
  const { WorkbenchService } = await import('../packages/desktop/src/main/workbenchService.ts');
  const events = [];
  let completed;
  const exit = new Promise((resolve) => { completed = resolve; });
  const service = new WorkbenchService(() => workspace, (event) => {
    events.push(event);
    if (event.type === 'exit' || event.type === 'error') completed();
  });
  let timeout;
  try {
    const id = await service.startCommand(process.platform === 'win32' ? 'Write-Output PI_DESKTOP_OK' : 'printf PI_DESKTOP_OK');
    await Promise.race([exit, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Command timed out')), 8000); })]);
    assert.ok(events.some((event) => event.id === id && event.type === 'stdout' && event.data?.includes('PI_DESKTOP_OK')));
    assert.ok(events.some((event) => event.id === id && event.type === 'exit' && event.code === 0));
  } finally {
    clearTimeout(timeout);
    await service.dispose();
    const resolvedTemp = resolve(tempRoot);
    if (!resolvedTemp.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('Unsafe temporary path');
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
});
