import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  await t.test('the trash bin moves .jsonl files and keeps them restorable', () => {
    const trashRoot = join(temp, 'trash');
    const trash = createSessionTrash(() => trashRoot);
	const sessionDir = join(temp, 'sessions');
	mkdirSync(sessionDir, { recursive: true });
    const sessionPath = join(sessionDir, 'conversation.jsonl');
    writeFileSync(sessionPath, '{"type":"session"}\n', 'utf8');
    const trashed = trash.trashSession(sessionPath);
    assert.equal(dirname(trashed), trashRoot);
    assert.ok(basename(trashed).endsWith('conversation.jsonl'));
    assert.ok(!existsSync(sessionPath), 'the original file is gone');
    assert.ok(existsSync(trashed), 'the trashed copy survives');
    assert.equal(readFileSync(trashed, 'utf8'), '{"type":"session"}\n');
    // Deleting the same path twice fails loudly instead of silently succeeding.
    assert.throws(() => trash.trashSession(sessionPath), /会话文件不存在/);
  });

  await t.test('the trash bin refuses anything that is not an existing session file', () => {
    const trash = createSessionTrash(() => join(temp, 'trash'));
    const other = join(temp, 'notes.txt');
    writeFileSync(other, 'x', 'utf8');
    assert.throws(() => trash.trashSession(other), /仅支持删除 .jsonl 会话文件/);
    assert.throws(() => trash.trashSession(join(temp, 'missing.jsonl')), /会话文件不存在/);
    assert.throws(() => trash.trashSession(''), /会话路径无效/);
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
});

function realpathSyncSafe(value) {
  return value;
}
