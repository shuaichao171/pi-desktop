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

function createNicknameStore() {
  const map = new Map();
  return {
    map,
    async read(cwd) { return map.get(cwd) ?? null; },
    async write(cwd, nickname) { map.set(cwd, nickname); },
    async clear(cwd) { map.delete(cwd); },
  };
}

test('file-level nickname helpers read and write wpmanager.wpnickname in the sole .code-workspace file', async () => {
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

    // Invalid JSON fails loudly instead of overwriting the file.
    writeFileSync(file, '{ not json');
    await assert.rejects(service.writeProjectNickname(workspace, 'x'), /不是有效的 JSON/);
    assert.equal(readFileSync(file, 'utf8'), '{ not json');
  } finally {
    await service.dispose();
    removeSafeTemp(tempRoot);
  }
});

test('without a .code-workspace file the remark is stored app-side and the file is never created', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-nickname-app-'));
  const workspace = join(tempRoot, 'workspace');
  mkdirSync(workspace);
  const { WorkbenchService } = await import('../packages/desktop/src/main/workbenchService.ts');
  const store = createNicknameStore();
  const service = new WorkbenchService(() => workspace, () => {}, store);
  try {
    assert.deepEqual(await service.getProjectNickname(workspace), { nickname: null, hasWorkspaceFile: false });

    // The defining rule: saving without a workspace file succeeds app-side and
    // leaves the project root untouched.
    await service.setProjectNickname(workspace, '  备注名  ');
    assert.equal(store.map.get(workspace), '备注名');
    assert.equal(readdirSync(workspace).length, 0);
    assert.deepEqual(await service.getProjectNickname(workspace), { nickname: '备注名', hasWorkspaceFile: false });

    // An empty remark clears the app-side entry.
    await service.setProjectNickname(workspace, '');
    assert.equal(store.map.has(workspace), false);
    assert.deepEqual(await service.getProjectNickname(workspace), { nickname: null, hasWorkspaceFile: false });

    // Validation still applies to app-side writes.
    await assert.rejects(service.setProjectNickname(workspace, 'x'.repeat(81)), /备注名过长/);
    await assert.rejects(service.setProjectNickname(workspace, 123), /备注名无效/);

    // A project whose folder disappeared degrades to the app-side store.
    store.map.set(workspace, '残留');
    const missing = join(tempRoot, 'missing');
    assert.deepEqual(await service.getProjectNickname(missing), { nickname: null, hasWorkspaceFile: false });
  } finally {
    await service.dispose();
    removeSafeTemp(tempRoot);
  }
});

test('with a .code-workspace file the file field wins and shadows the app-side store', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-nickname-file-'));
  const workspace = join(tempRoot, 'workspace');
  mkdirSync(workspace);
  const { WorkbenchService } = await import('../packages/desktop/src/main/workbenchService.ts');
  const store = createNicknameStore();
  const service = new WorkbenchService(() => workspace, () => {}, store);
  const file = join(workspace, 'proj.code-workspace');
  try {
    // A pre-existing app-side remark keeps answering while the file has no field.
    store.map.set(workspace, '旧名');
    writeFileSync(file, JSON.stringify({ folders: [{ path: '.' }] }));
    assert.deepEqual(await service.getProjectNickname(workspace), { nickname: '旧名', hasWorkspaceFile: true });

    // Saving with the file present writes the file and drops the shadowed copy.
    await service.setProjectNickname(workspace, '新名');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).wpmanager.wpnickname, '新名');
    assert.equal(store.map.has(workspace), false, 'the file wins on read; the stale app-side copy must not resurface');
    assert.deepEqual(await service.getProjectNickname(workspace), { nickname: '新名', hasWorkspaceFile: true });

    // The file field wins over any later app-side entry.
    store.map.set(workspace, '旁路名');
    assert.deepEqual(await service.getProjectNickname(workspace), { nickname: '新名', hasWorkspaceFile: true });

    // Clearing empties the file field and the app-side copy.
    await service.setProjectNickname(workspace, '');
    assert.equal('wpmanager' in JSON.parse(readFileSync(file, 'utf8')), false);
    assert.equal(store.map.has(workspace), false);
    assert.deepEqual(await service.getProjectNickname(workspace), { nickname: null, hasWorkspaceFile: true });
  } finally {
    await service.dispose();
    removeSafeTemp(tempRoot);
  }
});

test('without a store and without a .code-workspace file the save still refuses', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-nickname-plain-'));
  const workspace = join(tempRoot, 'workspace');
  mkdirSync(workspace);
  const { WorkbenchService } = await import('../packages/desktop/src/main/workbenchService.ts');
  const service = new WorkbenchService(() => workspace, () => {});
  try {
    await assert.rejects(service.setProjectNickname(workspace, '名字'), /没有 \.code-workspace 文件/);
    assert.equal(readdirSync(workspace).length, 0);
  } finally {
    await service.dispose();
    removeSafeTemp(tempRoot);
  }
});
