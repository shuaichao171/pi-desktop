import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceCommitService } from '../packages/desktop/src/main/workspaceCommit.ts';
import { WorktreeDeliveryService } from '../packages/desktop/src/main/worktreeDelivery.ts';
import { runFeatureProcess } from '../packages/desktop/src/main/gitFeatureProcess.ts';
async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-workbench-feature-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => runFeatureProcess('git', ['-C', root, ...args]);
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid');
  return { root, git };
}
test('stagedOnly preview and commit preserve partial worktree and outside staged content', async t => {
  const { root, git } = await repository(t); await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/a.txt'), 'base\n'); await writeFile(join(root, 'outside.txt'), 'outside base\n'); await git('add', '.'); await git('commit', '-qm', 'base');
  await writeFile(join(root, 'src/a.txt'), 'index version\n'); await writeFile(join(root, 'outside.txt'), 'outside staged\n'); await git('add', '.');
  await writeFile(join(root, 'src/a.txt'), 'working version only\n');
  const cwd = join(root, 'src'), service = new WorkspaceCommitService(() => cwd);
  t.after(() => service.dispose());
  const preview = await service.preview({ cwd, scope: 'stagedOnly' });
  assert.deepEqual(preview.files.map(file => file.path), ['a.txt']); assert.match(preview.context, /index version/); assert.doesNotMatch(preview.context, /working version only|outside staged/);
  await service.commit({ id: preview.id, message: 'scoped staged change' });
  assert.equal((await git('show', 'HEAD:src/a.txt')).stdout, 'index version\n');
  assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'working version only\n');
  assert.equal((await git('show', 'HEAD:outside.txt')).stdout, 'outside base\n');
  assert.equal((await git('show', ':outside.txt')).stdout, 'outside staged\n');
});
test('preview version rejects changed index and handles unborn all-scope commits', async t => {
  const { root, git } = await repository(t), service = new WorkspaceCommitService(() => root);
  t.after(() => service.dispose());
  await writeFile(join(root, 'new.txt'), 'first\n'); const first = await service.preview({ cwd: root, scope: 'all' });
  await writeFile(join(root, 'new.txt'), 'second\n'); await assert.rejects(service.commit({ id: first.id, message: 'stale' }), /已改变/);
  const fresh = await service.preview({ cwd: root, scope: 'all' }); await service.commit({ id: fresh.id, message: 'first commit' });
  assert.equal((await git('show', 'HEAD:new.txt')).stdout, 'second\n'); assert.equal((await git('status', '--porcelain')).stdout, '');
});
test('failed index publication rolls back HEAD and leaves the original staged tree', async t => {
  const { root, git } = await repository(t); await writeFile(join(root, 'a'), 'one'); await git('add', '.'); await git('commit', '-qm', 'base'); const head = (await git('rev-parse', 'HEAD')).stdout;
  await writeFile(join(root, 'a'), 'two'); await git('add', 'a'); const indexTree = (await git('write-tree')).stdout;
  let fail = false;
  const run = async (file, args, options) => { const result = await runFeatureProcess(file, args, options); if (fail && args.includes('update-ref') && args.includes('pi-desktop commit')) await rm(join(root, '.git/index.lock')); return result; };
  const service = new WorkspaceCommitService(() => root, run); const preview = await service.preview({ cwd: root, scope: 'stagedOnly' }); fail = true;
  t.after(() => service.dispose());
  await assert.rejects(service.commit({ id: preview.id, message: 'fail publication' }));
  assert.equal((await git('rev-parse', 'HEAD')).stdout, head); assert.equal((await git('write-tree')).stdout, indexTree);
});
test('managed worktrees isolate same paths, survive service restart, and reject duplicate branch mapping', async t => {
  const { root, git } = await repository(t); await writeFile(join(root, 'file.txt'), 'base'); await git('add', '.'); await git('commit', '-qm', 'base');
  const data = join(root, '.git', 'desktop-data'); let cwd = root; const service = new WorktreeDeliveryService(() => cwd, data);
  const a = await service.createWorktree({ cwd, ref: 'HEAD', branch: 'codex/a' }), b = await service.createWorktree({ cwd, ref: 'HEAD', branch: 'codex/b' });
  await writeFile(join(a.cwd, 'file.txt'), 'A'); await writeFile(join(b.cwd, 'file.txt'), 'B'); assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'base');
  cwd = a.cwd; await service.bindWorktree({ id: a.id, sessionPath: join(root, 'session-a.jsonl') });
  assert.equal((await new WorktreeDeliveryService(() => cwd, data).listWorktrees()).find(item => item.id === a.id).sessionPath, join(root, 'session-a.jsonl'));
  cwd = root; await assert.rejects(service.createWorktree({ cwd, ref: 'HEAD', branch: 'codex/a' })); assert.equal((await service.listWorktrees()).length, 2);
});
test('push uses normal refspec and draft PR reuses existing link without a remote write', async t => {
  const { root, git } = await repository(t); await writeFile(join(root, 'file.txt'), 'base'); await git('add', '.'); await git('commit', '-qm', 'base');
  const head = (await git('rev-parse', 'HEAD')).stdout.trim(); await git('remote', 'add', 'origin', 'https://github.com/example/review.git');
  const calls = []; const run = async (file, args, options) => { calls.push({ file, args }); if (file === 'gh') return { stdout: args[0] === '--version' ? 'gh version mock' : JSON.stringify([{ url: 'https://github.com/example/review/pull/17' }]), stderr: '' }; if (args.includes('push')) return { stdout: '', stderr: '' }; if (args.includes('ls-remote')) return { stdout: `${head}\trefs/heads/main\n`, stderr: '' }; return runFeatureProcess(file, args, options); };
  const service = new WorktreeDeliveryService(() => root, join(root, '.git', 'desktop-data'), run), preview = await service.deliveryPreview(root);
  await service.push({ id: preview.id, remote: 'origin' });
  const push = calls.find(call => call.args.includes('push')); assert(push.args.includes('--set-upstream')); assert(push.args.includes('HEAD:refs/heads/main')); assert(!push.args.some(arg => arg.includes('force')));
  const result = await service.draftPr({ id: preview.id, remote: 'origin', base: 'main', title: 'Review', body: 'Body' }); assert.equal(result.existing, true); assert.equal(result.url, 'https://github.com/example/review/pull/17'); assert(!calls.some(call => call.file === 'gh' && call.args.includes('create')));
  await git('checkout', '--detach'); await assert.rejects(service.deliveryPreview(root), /Detached HEAD/);
});

test('branch and workspace changes invalidate an otherwise identical commit preview', async t => {
  const { root, git } = await repository(t); await writeFile(join(root, 'a'), 'base'); await git('add', '.'); await git('commit', '-qm', 'base'); await writeFile(join(root, 'a'), 'next');
  let cwd = root; const service = new WorkspaceCommitService(() => cwd); t.after(() => service.dispose()); const preview = await service.preview({ cwd, scope: 'all' });
  await git('switch', '-c', 'codex/other'); await assert.rejects(service.commit({ id: preview.id, message: 'wrong branch' }), /已改变/);
  const fresh = await service.preview({ cwd, scope: 'all' }); cwd = join(root, 'other'); await assert.rejects(service.commit({ id: fresh.id, message: 'wrong workspace' }), /无效|已切换/); assert.equal((await git('log', '-1', '--format=%s')).stdout.trim(), 'base');
});

test('draft PR preserves exact multiline body, persists URL and rejects remote changes or failed pushes', async t => {
  const { root, git } = await repository(t); await writeFile(join(root, 'a'), 'base'); await git('add', '.'); await git('commit', '-qm', 'base'); await git('remote', 'add', 'origin', 'https://github.com/example/review.git'); const head = (await git('rev-parse', 'HEAD')).stdout.trim();
  let bodyPath, receivedBody, creates = 0, pushes = 0;
  const run = async (file, args, options) => {
    if (file === 'gh') {
      if (args[0] === '--version') return { stdout: 'gh mock', stderr: '' };
      if (args.includes('list')) return { stdout: '[]', stderr: '' };
      creates++; assert(args.includes('--draft')); bodyPath = args[args.indexOf('--body-file') + 1]; receivedBody = await readFile(bodyPath, 'utf8'); return { stdout: 'https://github.com/example/review/pull/18\n', stderr: '' };
    }
    if (args.includes('push')) { pushes++; throw new Error('mock permission denied'); }
    if (args.includes('ls-remote')) return { stdout: `${head}\trefs/heads/main\n`, stderr: '' };
    return runFeatureProcess(file, args, options);
  };
  const data = join(root, '.git', 'desktop-data'), service = new WorktreeDeliveryService(() => root, data, run), preview = await service.deliveryPreview(root), body = 'Exact first line\n\n`literal` and $(not a command)\n中文正文';
  await assert.rejects(service.push({ id: preview.id, remote: 'origin' }), /permission denied/); assert.equal(pushes, 1);
  const result = await service.draftPr({ id: preview.id, remote: 'origin', base: 'main', title: 'Approved title', body }); assert.equal(receivedBody, body); assert.equal(creates, 1); assert.equal(result.existing, false); await assert.rejects(readFile(bodyPath), { code: 'ENOENT' });
  const restarted = new WorktreeDeliveryService(() => root, data, run); assert.equal((await restarted.deliveryPreview(root)).savedPr, result.url);
  await git('remote', 'set-url', 'origin', 'https://github.com/other/review.git'); await assert.rejects(service.push({ id: preview.id, remote: 'origin' }), /远端已变化/); assert.equal(pushes, 1); assert.equal((await restarted.deliveryPreview(root)).savedPr, undefined);
});
