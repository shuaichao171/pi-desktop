import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
  writeFileSync(join(workspace, 'staged.txt'), 'base\n');
  writeFileSync(join(workspace, 'worktree.txt'), 'base\n');
  const { WorkbenchService } = await import('../packages/desktop/src/main/workbenchService.ts');
  const service = new WorkbenchService(() => workspace, () => {});
  try {
    const entries = await service.listEntries();
    assert.ok(entries.some((entry) => entry.path === 'readme.txt' && entry.kind === 'file'));
    assert.equal(await service.readFile('readme.txt'), 'hello\n');
    await assert.rejects(service.readFile('../outside.txt'), /不属于当前工作区/);
    await assert.rejects(service.listEntries('../'), /不属于当前工作区/);

    execFileSync('git', ['-C', workspace, 'init', '-q']);
    execFileSync('git', ['-C', workspace, 'config', 'core.autocrlf', 'false']);
    execFileSync('git', ['-C', workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'add', '--', 'gone.txt', 'staged.txt', 'worktree.txt']);
    execFileSync('git', ['-C', workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base']);
    unlinkSync(join(workspace, 'gone.txt'));
    writeFileSync(join(workspace, 'staged.txt'), 'staged\n');
    execFileSync('git', ['-C', workspace, 'add', '--', 'staged.txt']);
    writeFileSync(join(workspace, 'worktree.txt'), 'unstaged\n');
    const status = await service.gitStatus();
    assert.equal(status.isRepository, true);
    assert.ok(status.entries.some((entry) => entry.path === 'gone.txt' && entry.status.includes('D')));
    assert.match(await service.gitDiff('gone.txt'), /-before/);
    assert.ok(status.entries.some((entry) => entry.path === 'readme.txt' && entry.status === '??'));
    assert.equal(status.entries.find((entry) => entry.path === 'staged.txt')?.status, 'M ');
    assert.equal(status.entries.find((entry) => entry.path === 'worktree.txt')?.status, ' M');
    assert.match(await service.gitDiff('readme.txt'), /\+hello/);
    await assert.rejects(service.gitDiff('../outside.txt'), /不属于当前工作区/);
  } finally {
    await service.dispose();
    const resolvedTemp = resolve(tempRoot);
    if (!resolvedTemp.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('Unsafe temporary path');
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
});

test('large Git diffs return a bounded preview with a truncation notice', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-large-diff-'));
  const workspace = join(tempRoot, 'workspace');
  mkdirSync(workspace);
  const { WorkbenchService } = await import('../packages/desktop/src/main/workbenchService.ts');
  const service = new WorkbenchService(() => workspace, () => {});
  try {
    writeFileSync(join(workspace, 'large.txt'), 'base\n');
    execFileSync('git', ['-C', workspace, 'init', '-q']);
    execFileSync('git', ['-C', workspace, 'config', 'core.autocrlf', 'false']);
    execFileSync('git', ['-C', workspace, 'add', '--', 'large.txt']);
    execFileSync('git', ['-C', workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base']);
    writeFileSync(join(workspace, 'large.txt'), Array.from({ length: 50_000 }, (_, index) => `line-${index} ${'x'.repeat(28)}\n`).join(''));
    const preview = await service.gitDiff('large.txt');
    assert.match(preview, /Diff preview limited to the first 1 MB/);
    assert.ok(Buffer.byteLength(preview) <= 1024 * 1024 + 200);
    writeFileSync(join(workspace, 'untracked.txt'), 'new line\n'.repeat(140_000));
    const untrackedPreview = await service.gitDiff('untracked.txt');
    assert.match(untrackedPreview, /Diff preview limited to the first 1 MB/);
    assert.ok(Buffer.byteLength(untrackedPreview) <= 1024 * 1024 + 200);
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

test('workspace reset cancels a command awaiting path resolution and permits later commands', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-command-race-'));
  const workspace = join(tempRoot, 'workspace');
  mkdirSync(workspace);
  const { WorkbenchService } = await import('../packages/desktop/src/main/workbenchService.ts');
  const service = new WorkbenchService(() => workspace, () => {});
  try {
    const pending = service.startCommand(process.platform === 'win32' ? 'Write-Output stale' : 'printf stale', workspace);
    const rejected = assert.rejects(pending, /工作区已切换/);
    await service.reset();
    await rejected;
    assert.equal(service.commands.size, 0);
    const fresh = await service.startCommand(process.platform === 'win32' ? 'Start-Sleep -Seconds 1' : 'sleep 1');
    await service.stopCommand(fresh);
  } finally {
    await service.dispose();
    const resolvedTemp = resolve(tempRoot);
    if (!resolvedTemp.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('Unsafe temporary path');
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
});

test('Unix command stop terminates descendants in the shell process group', { skip: process.platform === 'win32' }, async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-command-tree-'));
  const workspace = join(tempRoot, 'workspace');
  mkdirSync(workspace);
  const { WorkbenchService } = await import('../packages/desktop/src/main/workbenchService.ts');
  const service = new WorkbenchService(() => workspace, () => {});
  const ready = join(workspace, 'ready.txt');
  const survived = join(workspace, 'survived.txt');
  try {
    const nodeBinary = "'" + process.execPath.replaceAll("'", "'\\''") + "'";
    const command = `${nodeBinary} -e "require('fs').writeFileSync('ready.txt','1'); setTimeout(() => require('fs').writeFileSync('survived.txt','1'), 1200)" & wait`;
    const id = await service.startCommand(command);
    const deadline = Date.now() + 5000;
    while (!existsSync(ready) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(existsSync(ready), true, 'child process did not start');
    await service.stopCommand(id);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(existsSync(survived), false, 'a descendant survived after stopping the command');
  } finally {
    await service.dispose();
    const resolvedTemp = resolve(tempRoot);
    if (!resolvedTemp.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('Unsafe temporary path');
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
});

test('simultaneous command starts respect the four-process limit', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-command-limit-'));
  const workspace = join(tempRoot, 'workspace');
  mkdirSync(workspace);
  const { WorkbenchService } = await import('../packages/desktop/src/main/workbenchService.ts');
  const service = new WorkbenchService(() => workspace, () => {});
  try {
    const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 10' : 'sleep 10';
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => service.startCommand(command, workspace)));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 4);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(service.commands.size, 4);
  } finally {
    await service.dispose();
    const resolvedTemp = resolve(tempRoot);
    if (!resolvedTemp.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('Unsafe temporary path');
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
});
