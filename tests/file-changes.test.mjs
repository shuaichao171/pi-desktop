import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const exec = promisify(execFile);
const settle = () => new Promise(done => setImmediate(done));
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content, stopReason = 'stop') => ({ role: 'assistant', content, api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4', usage, stopReason, timestamp: Date.now() });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-file-changes-'));
  const workspace = join(root, 'project');
  await mkdir(workspace);
  const [{ SessionManager }, { SessionFileChanges }] = await Promise.all([import('@earendil-works/pi-coding-agent'), import('../packages/agent/src/fileChanges.ts')]);
  const manager = SessionManager.inMemory(workspace);
  const events = [];
  const tracker = new SessionFileChanges(workspace, manager, items => events.push(items));
  return { root, workspace, manager, tracker, events, async cleanup() {
    const path = resolve(root);
    assert.ok(path.startsWith(resolve(tmpdir()) + sep));
    await rm(path, { recursive: true, force: true });
  } };
}

test('file previews compare against actual tool preimages, accumulate and rebase external changes', async () => {
  const f = await fixture();
  try {
    const path = join(f.workspace, 'dirty.txt');
    await writeFile(path, 'existing user change\n');
    await f.tracker.beforeTool('one', 'edit', { path: 'dirty.txt' });
    await writeFile(path, 'existing user change\nmodel one\n');
    await f.tracker.afterTool('one');
    let change = f.tracker.snapshot()[0];
    assert.equal(change.kind, 'modified');
    assert.equal(change.additions, 1);
    assert.equal(change.deletions, 0);
    assert.match(change.diff, /\+model one/);
    assert.doesNotMatch(change.diff, /\+existing user change/);
    await f.tracker.beforeTool('two', 'edit', { path: 'dirty.txt' });
    await writeFile(path, 'existing user change\nmodel one\nmodel two\n');
    await f.tracker.afterTool('two');
    assert.equal(f.tracker.snapshot()[0].additions, 2);
    await writeFile(path, 'existing user change\nmodel one\nmodel two\nmanual extra\n');
    await f.tracker.beforeTool('three', 'edit', { path: 'dirty.txt' });
    await writeFile(path, 'existing user change\nmodel one\nmodel two\nmanual extra\nmodel three\n');
    await f.tracker.afterTool('three');
    change = f.tracker.snapshot()[0];
    assert.equal(change.additions, 1);
    assert.match(change.diff, /\+model three/);
    assert.doesNotMatch(change.diff, /\+manual extra/);
    const snapshot = f.tracker.snapshot();
    const restored = f.tracker.restore();
    assert.deepEqual(restored, snapshot);
    restored[0].path = 'corrupted';
    assert.equal(f.tracker.snapshot()[0].path, 'dirty.txt');
    await f.tracker.beforeTool('revert', 'write', { path: 'dirty.txt' });
    await writeFile(path, 'existing user change\nmodel one\nmodel two\nmanual extra\n');
    await f.tracker.afterTool('revert');
    assert.deepEqual(f.tracker.snapshot(), [], 'reverting the contiguous model edit removes the file summary');
  } finally { await f.cleanup(); }
});

test('shell snapshots include clean tracked, already dirty and untracked files without blaming untouched changes', async () => {
  const f = await fixture();
  const git = (...args) => exec('git', ['-C', f.workspace, ...args], { windowsHide: true });
  try {
    await git('init', '--quiet');
    await writeFile(join(f.workspace, 'tracked.txt'), 'committed\n');
    await writeFile(join(f.workspace, 'untouched.txt'), 'committed\n');
    await git('add', '.');
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture');
    await writeFile(join(f.workspace, 'untouched.txt'), 'preexisting dirty\n');
    await writeFile(join(f.workspace, 'untracked.txt'), 'preexisting untracked\n');
    await writeFile(join(f.workspace, 'removed.txt'), 'remove me\n');
    await f.tracker.beforeTool('shell', 'bash', { command: 'fixture writes' });
    await writeFile(join(f.workspace, 'tracked.txt'), 'updated\n');
    await writeFile(join(f.workspace, 'untracked.txt'), 'preexisting untracked\nchanged\n');
    await writeFile(join(f.workspace, 'added.txt'), 'new file\n');
    await rm(join(f.workspace, 'removed.txt'));
    await f.tracker.afterTool('shell');
    const changes = f.tracker.snapshot();
    assert.deepEqual(changes.map(({ path, kind }) => [path, kind]), [['added.txt', 'added'], ['removed.txt', 'deleted'], ['tracked.txt', 'modified'], ['untracked.txt', 'modified']]);
    assert.match(changes.find(({ path }) => path === 'added.txt').diff, /@@ -0,0 \+1,1 @@/);
    assert.match(changes.find(({ path }) => path === 'removed.txt').diff, /@@ -1,1 \+0,0 @@/);
    assert.equal(changes.find(({ path }) => path === 'untracked.txt').additions, 1);
  } finally { await f.cleanup(); }
});

test('binary, bounded large files, external symlinks and incomplete baselines stay safe and accurate', async (t) => {
  const f = await fixture();
  try {
    const large = join(f.workspace, 'large.txt');
    await writeFile(large, 'a'.repeat(100_000));
    await f.tracker.beforeTool('touch', 'write', { path: large });
    await utimes(large, new Date(), new Date(Date.now() + 5000));
    await f.tracker.afterTool('touch');
    assert.deepEqual(f.tracker.snapshot(), [], 'mtime-only changes are not edits');
    await f.tracker.beforeTool('large', 'write', { path: large });
    await writeFile(large, 'b'.repeat(100_000));
    await f.tracker.afterTool('large');
    assert.equal(f.tracker.snapshot()[0].preview, 'too-large');
    await f.tracker.beforeTool('binary', 'write', { path: 'data.bin' });
    await writeFile(join(f.workspace, 'data.bin'), Buffer.from([0, 1, 2]));
    await f.tracker.afterTool('binary');
    assert.equal(f.tracker.snapshot().find(({ path }) => path === 'data.bin').preview, 'binary');
    const outside = join(f.root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'DO NOT INCLUDE OUTSIDE TEXT');
    try {
      await symlink(outside, join(f.workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      await f.tracker.beforeTool('outside', 'edit', { path: 'linked/secret.txt' });
      await writeFile(join(outside, 'secret.txt'), 'STILL OUTSIDE');
      await f.tracker.afterTool('outside');
      assert.equal(JSON.stringify(f.tracker.snapshot()).includes('secret'), false);
      assert.equal(JSON.stringify(f.manager.getBranch()).includes('OUTSIDE'), false);
    } catch (error) { if (error.code !== 'EPERM') throw error; t.diagnostic('Symlink permission unavailable; lexical outside-path rejection still tested.'); }
    await f.tracker.beforeTool('outside-path', 'write', { path: '../outside/secret.txt' });
    await f.tracker.afterTool('outside-path');
    assert.equal(f.tracker.snapshot().length, 2);

    // Exercise an incomplete scan without creating thousands of files. Unknown
    // preexisting paths exposed only in the second listing cannot be called added.
    const originalList = f.tracker.listFiles.bind(f.tracker);
    let scan = 0;
    f.tracker.listFiles = async () => scan++ ? { paths: ['unknown.txt'], complete: false } : { paths: [], complete: false };
    await writeFile(join(f.workspace, 'unknown.txt'), 'preexisting');
    await f.tracker.beforeTool('incomplete', 'bash', {});
    await f.tracker.afterTool('incomplete');
    assert.equal(f.tracker.snapshot().some(({ path }) => path === 'unknown.txt'), false);
    f.tracker.listFiles = originalList;
    const originalRead = f.tracker.readFile.bind(f.tracker);
    let reads = 0;
    f.tracker.listFiles = async () => ({ paths: ['unknown.txt'], complete: true });
    f.tracker.readFile = async (...args) => reads++ ? originalRead(...args) : null;
    await f.tracker.beforeTool('unreadable', 'bash', {});
    await f.tracker.afterTool('unreadable');
    assert.equal(f.tracker.snapshot().some(({ path }) => path === 'unknown.txt'), false, 'an unreadable preimage cannot become a fabricated addition');
  } finally { await f.cleanup(); }
});

test('unified previews preserve final-newline markers and omit EOF markers outside the hunk', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.workspace, 'newline.txt'), 'old');
    await f.tracker.beforeTool('newline', 'edit', { path: 'newline.txt' });
    await writeFile(join(f.workspace, 'newline.txt'), 'new\n');
    await f.tracker.afterTool('newline');
    assert.match(f.tracker.snapshot()[0].diff, /-old\n\\ No newline at end of file\n\+new\n/);
    const tail = Array.from({ length: 12 }, (_, i) => `tail ${i}`).join('\n');
    await writeFile(join(f.workspace, 'head.txt'), `old\n${tail}`);
    await f.tracker.beforeTool('head', 'edit', { path: 'head.txt' });
    await writeFile(join(f.workspace, 'head.txt'), `new\n${tail}`);
    await f.tracker.afterTool('head');
    assert.doesNotMatch(f.tracker.snapshot().find(({ path }) => path === 'head.txt').diff, /No newline/);
  } finally { await f.cleanup(); }
});

test('real SDK tool execution captures preimages, survives extension reload, switches sessions and reopens persisted changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-sdk-file-changes-'));
  const workspace = join(root, 'workspace');
  const other = join(root, 'other');
  await mkdir(workspace); await mkdir(other);
  const env = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map(name => [name, process.env[name]]));
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent'); process.env.PI_OFFLINE = '1';
  let service;
  try {
    const { AgentService } = await import('../packages/agent/src/index.ts');
    service = new AgentService();
    await service.init({ cwd: workspace });
    const run = async (name, args) => {
      const session = service.active.runtime.session;
      const response = [assistant([{ type: 'toolCall', id: `fixture-${Date.now()}`, name, arguments: args }], 'toolUse'), assistant([{ type: 'text', text: 'Finished fixture' }])];
      session.agent.getApiKey = () => 'offline-fixture';
      session.agent.state.model ??= { id: 'claude-sonnet-4', name: 'Fixture', api: 'anthropic-messages', provider: 'anthropic', baseUrl: 'http://invalid.local', reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      session.agent.streamFunction = async () => {
        const message = response.shift();
        assert.ok(message, 'fixture must not request unexpected model turns');
        return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: message.stopReason, message }; }, async result() { return message; } };
      };
      await session.agent.prompt('Run only the local fixture tool');
      await settle();
      assert.equal(response.length, 0, service.getSnapshot().error ?? session.agent.state.errorMessage);
      const failure = service.getSnapshot().activities.findLast(activity => activity.status === 'error');
      assert.equal(failure, undefined, failure?.detail);
    };
    await writeFile(join(workspace, 'existing.txt'), 'user original\n');
    await run('edit', { path: 'existing.txt', oldText: 'user original', newText: 'model replacement' });
    assert.match(service.getSnapshot().fileChanges[0].diff, /-user original\n\+model replacement/);
    const path = service.getSnapshot().sessionPath;
    await service.active.runtime.session.reload();
    await run('write', { path: 'created.txt', content: 'created by model\n' });
    assert.deepEqual(service.getSnapshot().fileChanges.map(file => file.path), ['created.txt', 'existing.txt']);
    assert.equal(await readFile(join(workspace, 'created.txt'), 'utf8'), 'created by model\n');
    const changes = service.getSnapshot().fileChanges;
    await service.switchWorkspace(other);
    assert.deepEqual(service.getSnapshot().fileChanges, []);
    await service.switchWorkspace(workspace);
    assert.deepEqual(service.getSnapshot().fileChanges, changes);
    await service.dispose();
    service = new AgentService();
    await service.init({ cwd: workspace, sessionPath: path });
    assert.deepEqual(service.getSnapshot().fileChanges, changes);
  } finally {
    await service?.dispose();
    for (const [name, value] of env) value === undefined ? delete process.env[name] : process.env[name] = value;
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  }
});
