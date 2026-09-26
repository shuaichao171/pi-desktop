import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile, unlink } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('./') && context.parentURL && new URL(context.parentURL).pathname.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

test('deleting a conversation moves it to trash and clears group membership', async (t) => {
  const temp = realpathSyncSafe(mkdtempSync(join(tmpdir(), 'pi-session-delete-')));
  t.after(async () => { rmSync(temp, { recursive: true, force: true }); });
  const { createSessionTrash } = await import('../packages/desktop/src/main/sessionTrash.ts');
  const { SessionGroupService } = await import('../packages/desktop/src/main/sessionGroups.ts');

  await t.test('the trash bin moves .jsonl files and keeps them restorable', async () => {
    const trashRoot = join(temp, 'trash');
    const trash = createSessionTrash(() => trashRoot);
	const sessionDir = join(temp, 'sessions');
	mkdirSync(sessionDir, { recursive: true });
    const sessionPath = join(sessionDir, 'conversation.jsonl');
    writeFileSync(sessionPath, '{"type":"session"}\n', 'utf8');
    const trashed = await trash.trashSession(sessionPath);
    assert.equal(dirname(trashed), trashRoot);
    assert.ok(basename(trashed).endsWith('conversation.jsonl'));
    assert.ok(!existsSync(sessionPath), 'the original file is gone');
    assert.ok(existsSync(trashed), 'the trashed copy survives');
    assert.equal(readFileSync(trashed, 'utf8'), '{"type":"session"}\n');
    // Deleting the same path twice fails loudly instead of silently succeeding.
    await assert.rejects(() => trash.trashSession(sessionPath), /会话文件不存在/);
  });

  await t.test('the trash bin refuses anything that is not an existing session file', async () => {
    const trash = createSessionTrash(() => join(temp, 'trash'));
    const other = join(temp, 'notes.txt');
    writeFileSync(other, 'x', 'utf8');
    await assert.rejects(() => trash.trashSession(other), /仅支持删除 .jsonl 会话文件/);
    await assert.rejects(() => trash.trashSession(join(temp, 'missing.jsonl')), /会话文件不存在/);
    await assert.rejects(() => trash.trashSession(''), /会话路径无效/);
  });

  await t.test('group membership is dropped everywhere when a session is removed', async () => {
    const statePath = join(temp, 'groups.json');
    const service = new SessionGroupService({ path: statePath, validateSessionPath: async () => {} });
    await service.update({ type: 'create', name: 'Research' });
    await service.update({ type: 'create', name: 'Infra' });
    const groups = await service.list();
    await service.update({ type: 'move-session', sessionPath: join(temp, 'a.jsonl'), groupId: groups[0].id });
    await service.update({ type: 'move-session', sessionPath: join(temp, 'b.jsonl'), groupId: groups[0].id });
    await service.update({ type: 'move-session', sessionPath: join(temp, 'a.jsonl'), groupId: groups[1].id });
    const afterRemoval = await service.removeSession(join(temp, 'a.jsonl'));
    assert.deepEqual(afterRemoval.map((group) => group.sessionPaths), [[join(temp, 'b.jsonl')], []]);
    const persisted = await service.list();
    assert.deepEqual(persisted.map((group) => group.sessionPaths), [[join(temp, 'b.jsonl')], []]);
    // Removing an unknown session is a no-op that keeps groups intact.
    const untouched = await service.removeSession(join(temp, 'ghost.jsonl'));
    assert.equal(untouched.length, 2);
  });

  await t.test('cross-volume deletion copies completely before removing the source', async () => {
    const source = join(temp, 'cross-volume.jsonl');
    writeFileSync(source, 'restorable conversation');
    const calls = [];
    const trash = createSessionTrash(() => join(temp, 'cross-volume-trash'), {
      rename: async () => { calls.push('rename'); throw Object.assign(new Error('cross device'), { code: 'EXDEV' }); },
      copyFile: async (...args) => { calls.push('copy'); assert.ok(existsSync(source)); await copyFile(...args); },
      unlink: async (...args) => { calls.push('unlink'); await unlink(...args); },
    });
    const target = await trash.trashSession(source);
    assert.deepEqual(calls, ['rename', 'copy', 'unlink']);
    assert.equal(existsSync(source), false);
    assert.equal(readFileSync(target, 'utf8'), 'restorable conversation');
  });

  await t.test('a failed cross-volume copy keeps the source and does not attempt unlink', async () => {
    const source = join(temp, 'failed-copy.jsonl');
    writeFileSync(source, 'keep this conversation');
    const trash = createSessionTrash(() => join(temp, 'failed-copy-trash'), {
      rename: async () => { throw Object.assign(new Error('cross device'), { code: 'EXDEV' }); },
      copyFile: async () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); },
      unlink: async () => { assert.fail('failed copies must not remove the original'); },
    });
    await assert.rejects(trash.trashSession(source), /no space/);
    assert.equal(readFileSync(source, 'utf8'), 'keep this conversation');
    const denied = createSessionTrash(() => join(temp, 'denied-trash'), {
      rename: async () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); },
      copyFile: async () => { assert.fail('non-EXDEV errors must be propagated'); },
      unlink,
    });
    await assert.rejects(denied.trashSession(source), /permission denied/);
  });

  await t.test('concurrent same-name deletions retain both copies when timestamps collide', async (t) => {
    t.mock.method(Date, 'now', () => 12345);
    const first = join(temp, 'first', 'same.jsonl');
    const second = join(temp, 'second', 'same.jsonl');
    mkdirSync(dirname(first)); mkdirSync(dirname(second));
    writeFileSync(first, 'first'); writeFileSync(second, 'second');
    const trash = createSessionTrash(() => join(temp, 'collision-trash'));
    const [a, b] = await Promise.all([trash.trashSession(first), trash.trashSession(second)]);
    assert.equal(basename(a), '12345-same.jsonl');
    assert.equal(basename(b), '12345-1-same.jsonl');
    assert.equal(readFileSync(a, 'utf8'), 'first');
    assert.equal(readFileSync(b, 'utf8'), 'second');
  });
});

function realpathSyncSafe(value) {
  return value;
}
