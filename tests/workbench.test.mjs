import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { test } from 'node:test';

function removeSafeTemp(tempRoot) {
  const base = realpathSync(tmpdir());
  const target = realpathSync(tempRoot);
  const rel = relative(base, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
    || !rel.startsWith('pi-desktop-')) throw new Error('Unsafe temporary path');
  rmSync(target, { recursive: true, force: true });
}

test('opening the workspace validates the directory, propagates native failures and rejects stale selections', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-open-folder-'));
  const workspace = join(tempRoot, 'workspace');
  const other = join(tempRoot, 'other');
  mkdirSync(workspace); mkdirSync(other);
  const file = join(tempRoot, 'file.txt');
  writeFileSync(file, 'not a directory');
  const { WorkbenchService } = await import('../packages/desktop/src/main/workbenchService.ts');
  let cwd = workspace;
  const service = new WorkbenchService(() => cwd, () => {});
  const opened = [];
  const openPath = async path => { opened.push(path); return ''; };
  try {
    await service.openWorkspaceFolder(workspace, openPath);
    assert.deepEqual(opened, [await realpath(workspace)]);
    await assert.rejects(service.openWorkspaceFolder(other, openPath), /工作区已切换/);
    for (const invalid of [null, '', '.', 'https://example.invalid', 'file:\/\/\/tmp', workspace + '\0']) {
      await assert.rejects(service.openWorkspaceFolder(invalid, openPath), /工作区路径无效/);
    }
    cwd = file;
    await assert.rejects(service.openWorkspaceFolder(file, openPath), /不是文件夹/);
    cwd = join(tempRoot, 'missing');
    await assert.rejects(service.openWorkspaceFolder(cwd, openPath), /ENOENT/);
    cwd = workspace;
    await assert.rejects(service.openWorkspaceFolder(cwd, async () => 'Native file manager unavailable'), /Native file manager unavailable/);
    await assert.rejects(service.openWorkspaceFolder(cwd, async () => { throw new Error('Native dispatch rejected'); }), /Native dispatch rejected/);

    const changed = service.openWorkspaceFolder(cwd, openPath);
    cwd = other;
    await assert.rejects(changed, /工作区已切换/);
    cwd = workspace;
    const reset = service.openWorkspaceFolder(cwd, openPath);
    await service.reset();
    await assert.rejects(reset, /工作区已切换/);
    assert.equal(opened.length, 1, 'failed validation and asynchronous switches never invoke the native opener');
  } finally {
    await service.dispose();
    removeSafeTemp(tempRoot);
  }
});

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
    removeSafeTemp(tempRoot);
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
    removeSafeTemp(tempRoot);
  }
});

test('Git changes in a nested workspace use workspace-relative file paths', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-nested-git-'));
  const workspace = join(tempRoot, 'project');
  mkdirSync(join(workspace, 'new-directory'), { recursive: true });
  const { WorkbenchService } = await import('../packages/desktop/src/main/workbenchService.ts');
  const service = new WorkbenchService(() => workspace, () => {});
  try {
    execFileSync('git', ['-C', tempRoot, 'init', '-q']);
    writeFileSync(join(tempRoot, 'outside.txt'), 'outside\n');
    writeFileSync(join(workspace, 'new-directory', 'new.txt'), 'nested contents\n');
    const status = await service.gitStatus();
    assert.deepEqual(status.entries, [{ path: 'new-directory/new.txt', status: '??' }]);
    assert.match(await service.gitDiff(status.entries[0].path), /\+nested contents/);
  } finally {
    await service.dispose();
    removeSafeTemp(tempRoot);
  }
});

test('an untracked diff stays bound to its original workspace during a workspace switch', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-diff-workspace-'));
  const first = join(tempRoot, 'first');
  const second = join(tempRoot, 'second');
  mkdirSync(first);
  mkdirSync(second);
  execFileSync('git', ['-C', first, 'init', '-q']);
  writeFileSync(join(first, 'same.txt'), 'original workspace\n');
  writeFileSync(join(second, 'same.txt'), 'different workspace\n');
  const { WorkbenchService } = await import('../packages/desktop/src/main/workbenchService.ts');
  let reads = 0;
  const service = new WorkbenchService(() => ++reads === 1 ? first : second, () => {});
  try {
    const preview = await service.gitDiff('same.txt');
    assert.match(preview, /\+original workspace/);
    assert.doesNotMatch(preview, /different workspace/);
  } finally {
    await service.dispose();
    removeSafeTemp(tempRoot);
  }
});

test('untracked diff rejects invalid UTF-8 and truncates valid multibyte text without replacement characters', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-diff-utf8-'));
  execFileSync('git', ['-C', tempRoot, 'init', '-q']);
  const { WorkbenchService } = await import('../packages/desktop/src/main/workbenchService.ts');
  const service = new WorkbenchService(() => tempRoot, () => {});
  try {
    for (const tail of [Buffer.from([0xff]), Buffer.from([0xe4, 0xb8])]) {
      writeFileSync(join(tempRoot, 'invalid.txt'), Buffer.concat([Buffer.from('valid prefix'), tail]));
      await assert.rejects(service.gitDiff('invalid.txt'), /UTF-8/);
    }
    writeFileSync(join(tempRoot, 'large.txt'), '你'.repeat(400_000));
    const preview = await service.gitDiff('large.txt');
    assert.match(preview, /Diff preview limited/);
    assert.doesNotMatch(preview, /\uFFFD/);
    assert.ok(Buffer.byteLength(preview) <= 1024 * 1024 + 200);
  } finally {
    await service.dispose();
    removeSafeTemp(tempRoot);
  }
});

test('Git diff previews staged and working changes before the first commit', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-unborn-git-'));
  const { WorkbenchService } = await import('../packages/desktop/src/main/workbenchService.ts');
  const service = new WorkbenchService(() => tempRoot, () => {});
  try {
    execFileSync('git', ['-C', tempRoot, 'init', '-q']);
    execFileSync('git', ['-C', tempRoot, 'config', 'core.autocrlf', 'false']);
    writeFileSync(join(tempRoot, 'first.txt'), 'staged contents\n');
    execFileSync('git', ['-C', tempRoot, 'add', '--', 'first.txt']);
    assert.match(await service.gitDiff('first.txt'), /\+staged contents/);
    writeFileSync(join(tempRoot, 'first.txt'), 'working contents\n');
    assert.match(await service.gitDiff('first.txt'), /\+working contents/);
  } finally {
    await service.dispose();
    removeSafeTemp(tempRoot);
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
    removeSafeTemp(tempRoot);
  }
});

test('Git preview preserves staged changes even when worktree edits undo them', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-staged-diff-'));
  const { WorkbenchService } = await import('../packages/desktop/src/main/workbenchService.ts');
  const service = new WorkbenchService(() => tempRoot, () => {});
  const git = (...args) => execFileSync('git', ['-C', tempRoot, ...args]);
  try {
    git('init', '-q');
    git('config', 'core.autocrlf', 'false');
    writeFileSync(join(tempRoot, 'sample.txt'), 'original\n');
    git('add', '--', 'sample.txt');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base');
    writeFileSync(join(tempRoot, 'sample.txt'), 'staged change\n');
    git('add', '--', 'sample.txt');
    writeFileSync(join(tempRoot, 'sample.txt'), 'original\n');
    assert.equal((await service.gitStatus()).entries[0]?.status, 'MM');
    const preview = await service.gitDiff('sample.txt');
    assert.match(preview, /\+staged change/);
    assert.match(preview, /-staged change/);
    assert.match(preview, /Staged/);
    assert.match(preview, /Unstaged/);
    writeFileSync(join(tempRoot, 'sample.txt'), 'staged line\n'.repeat(150_000));
    git('add', '--', 'sample.txt');
    writeFileSync(join(tempRoot, 'sample.txt'), 'working line\n'.repeat(150_000));
    const largePreview = await service.gitDiff('sample.txt');
    assert.match(largePreview, /\+staged line/);
    assert.match(largePreview, /Unstaged/);
    assert.ok(Buffer.byteLength(largePreview) <= 1024 * 1024 + 400);
  } finally {
    await service.dispose();
    removeSafeTemp(tempRoot);
  }
});

test('Windows commands preserve Unicode stdout, stderr and native command pipelines', { skip: process.platform !== 'win32' }, async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-command-unicode-'));
  const { WorkbenchService } = await import('../packages/desktop/src/main/workbenchService.ts');
  const events = [];
  let completed;
  const completion = new Promise((done) => { completed = done; });
  const service = new WorkbenchService(() => tempRoot, (event) => {
    events.push(event);
    if (event.type === 'exit') completed();
  });
  let timeout;
  try {
    const executable = "'" + process.execPath.replaceAll("'", "''") + "'";
    await service.startCommand(`Write-Output '中文输出🙂'; [Console]::Error.WriteLine('中文错误🙂'); '中文管道🙂' | & ${executable} -e "process.stdin.pipe(process.stdout)"`);
    await Promise.race([completion, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Command timed out')), 8000); })]);
    const stdout = events.filter((event) => event.type === 'stdout').map((event) => event.data).join('');
    const stderr = events.filter((event) => event.type === 'stderr').map((event) => event.data).join('');
    assert.match(stdout, /中文输出🙂/);
    assert.match(stdout, /中文管道🙂/);
    assert.match(stderr, /中文错误🙂/);
    assert.equal(events.at(-1).code, 0);
  } finally {
    clearTimeout(timeout);
    await service.dispose();
    removeSafeTemp(tempRoot);
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
    removeSafeTemp(tempRoot);
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
    removeSafeTemp(tempRoot);
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
    removeSafeTemp(tempRoot);
  }
});

test('command output overflow reports one error and no output after completion', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-command-output-'));
  const { WorkbenchService } = await import('../packages/desktop/src/main/workbenchService.ts');
  const events = [];
  let finished;
  const completion = new Promise((resolve) => { finished = resolve; });
  const service = new WorkbenchService(() => tempRoot, (event) => {
    events.push(event);
    if (event.type === 'exit') finished();
  });
  let timeout;
  try {
    await service.startCommand(process.platform === 'win32'
      ? "[Console]::Out.Write(('x' * 2000000))"
      : "head -c 2000000 /dev/zero | tr '\\0' 'x'");
    await Promise.race([completion, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Command timed out')), 8000); })]);
    assert.equal(events.filter((event) => event.type === 'error').length, 1);
    assert.match(events.find((event) => event.type === 'error').data, /1 MB/);
    assert.equal(events.at(-1).type, 'exit');
  } finally {
    clearTimeout(timeout);
    await service.dispose();
    removeSafeTemp(tempRoot);
  }
});
