import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';

function removeSafeTemp(tempRoot) {
  const base = realpathSync.native(tmpdir());
  const target = realpathSync.native(tempRoot);
  const rel = relative(base, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || !rel.startsWith('pi-desktop-')) throw new Error('Unsafe temporary path');
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

test('project nicknames read and write wpmanager.wpnickname in the sole .code-workspace file', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-nickname-'));
  const workspace = join(tempRoot, 'workspace');
  mkdirSync(workspace);
  const { WorkbenchService } = await import('../packages/desktop/src/main/workbenchService.ts');
  const service = new WorkbenchService(() => workspace, () => {});
  try {
    // No workspace file: no nickname, and the reader must not create anything.
    assert.deepEqual(await service.readProjectNickname(workspace), { nickname: null, hasWorkspaceFile: false });
    assert.equal(readdirSync(workspace).length, 0);

    const file = join(workspace, 'proj.code-workspace');
    writeFileSync(file, JSON.stringify({ folders: [{ path: '.' }], settings: { 'a.b': 1 } }, null, 4) + '\n');
    assert.deepEqual(await service.readProjectNickname(workspace), { nickname: null, hasWorkspaceFile: true });

    // Writing trims the remark and preserves every other field.
    await service.writeProjectNickname(workspace, '  备注名  ');
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(stored.wpmanager.wpnickname, '备注名');
    assert.deepEqual(stored.folders, [{ path: '.' }]);
    assert.deepEqual(stored.settings, { 'a.b': 1 });
    assert.deepEqual(await service.readProjectNickname(workspace), { nickname: '备注名', hasWorkspaceFile: true });
    assert.equal(existsSync(`${file}.pi-nickname-tmp`), false, 'the staging file must be gone after a write');

    // An empty remark clears the field and removes an emptied wpmanager object.
    await service.writeProjectNickname(workspace, '');
    const cleared = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal('wpmanager' in cleared, false);
    assert.deepEqual(await service.readProjectNickname(workspace), { nickname: null, hasWorkspaceFile: true });

    // Overwriting an existing remark keeps unrelated wpmanager siblings.
    await service.writeProjectNickname(workspace, '第二个');
    await service.writeProjectNickname(workspace, '最终名');
    const overwritten = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(overwritten.wpmanager.wpnickname, '最终名');

    // Invalid JSON fails loudly instead of overwriting the file.
    writeFileSync(file, '{ not json');
    await assert.rejects(service.writeProjectNickname(workspace, 'x'), /不是有效的 JSON/);
    assert.equal(readFileSync(file, 'utf8'), '{ not json');
  } finally {
    await service.dispose();
    removeSafeTemp(tempRoot);
  }
});

test('nickname writes never create a .code-workspace file and refuse ambiguity or invalid input', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-nickname-missing-'));
  const workspace = join(tempRoot, 'workspace');
  mkdirSync(workspace);
  const { WorkbenchService } = await import('../packages/desktop/src/main/workbenchService.ts');
  const service = new WorkbenchService(() => workspace, () => {});
  try {
    // The defining rule: without an existing .code-workspace file the write
    // fails and never generates one.
    await assert.rejects(service.writeProjectNickname(workspace, '名字'), /没有 \.code-workspace 文件/);
    assert.equal(readdirSync(workspace).length, 0);
    await assert.rejects(service.writeProjectNickname(workspace, 123), /备注名无效/);
    await assert.rejects(service.writeProjectNickname(workspace, 'x'.repeat(81)), /备注名过长/);
    await assert.rejects(service.writeProjectNickname(workspace, 'a\0b'), /备注名无效/);

    // Two workspace files are ambiguous: reads report nothing, writes refuse.
    writeFileSync(join(workspace, 'a.code-workspace'), '{}');
    writeFileSync(join(workspace, 'B.code-workspace'), '{}');
    assert.deepEqual(await service.readProjectNickname(workspace), { nickname: null, hasWorkspaceFile: false });
    await assert.rejects(service.writeProjectNickname(workspace, '名字'), /没有 \.code-workspace 文件/);

    // A reader ignores invalid JSON but still reports the file exists.
    const single = join(tempRoot, 'single');
    mkdirSync(single);
    const service2 = new WorkbenchService(() => single, () => {});
    try {
      writeFileSync(join(single, 'w.code-workspace'), 'broken');
      assert.deepEqual(await service2.readProjectNickname(single), { nickname: null, hasWorkspaceFile: true });
    } finally {
      await service2.dispose();
    }
  } finally {
    await service.dispose();
    removeSafeTemp(tempRoot);
  }
});
