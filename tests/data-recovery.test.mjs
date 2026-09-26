import assert from 'node:assert/strict';
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('./') && context.parentURL?.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
  return next(specifier, context);
} });
const { createSessionTrash } = await import('../packages/desktop/src/main/sessionTrash.ts');
const { createCompleteBackup, createSessionImporter, validateNativeSession, validateCompleteBackup } = await import('../packages/desktop/src/main/sessionImport.ts');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-data-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace'), sessionsRoot = join(root, 'sessions'), trashRoot = join(root, 'trash');
  await mkdir(cwd); await mkdir(sessionsRoot);
  const header = { type: 'session', version: 3, id: 'original-session', cwd, timestamp: new Date().toISOString() };
  const message = (id, parentId, text) => ({ type: 'message', id, parentId, timestamp: new Date().toISOString(), message: { role: 'user', content: text, timestamp: Date.now() } });
  const raw = [header, message('root', null, 'root question'), message('branch-old', 'root', 'old answer'), message('branch-new', 'root', 'new answer')].map(JSON.stringify).join('\n') + '\n';
  const source = join(root, 'original.jsonl'); await writeFile(source, raw);
  return { root, cwd, sessionsRoot, trashRoot, raw, source, message, header };
}

test('trash retains desktop metadata, all branches and exact cleanup confirmations', async (t) => {
  const f = await fixture(t), trash = createSessionTrash(() => f.trashRoot);
  const metadata = { pinned: true, archived: true, order: 4, group: { id: 'group', name: 'Research', index: 2 } };
  const moved = await trash.trashSession(f.source, { cwd: f.cwd, sessionId: 'original-session', metadata });
  const entry = (await trash.list()).entries[0];
  assert.equal(entry.id, basename(moved)); assert.deepEqual(entry.metadata, metadata); assert.equal(entry.legacy, false);
  await trash.setRetention(7); assert.ok((await trash.list()).entries[0].expiresAt);
  assert.deepEqual(await trash.cleanup({ entries: [{ id: entry.id, deletedAt: 'wrong' }] }), { removed: [], skipped: [entry.id] });
  assert.deepEqual(await trash.cleanup({ entries: [{ id: entry.id, deletedAt: entry.deletedAt }] }, async () => true), { removed: [], skipped: [entry.id] });
  await writeFile(f.source, 'existing data');
  await assert.rejects(trash.restoreSession(entry.id, f.source), /已有文件/);
  assert.equal(await readFile(f.source, 'utf8'), 'existing data'); assert.equal(await readFile(moved, 'utf8'), f.raw);
  await unlink(f.source);
  await assert.rejects(trash.restoreSession(entry.id, f.source, async () => { throw new Error('metadata disk full'); }), /disk full/);
  await assert.rejects(readFile(f.source), /ENOENT/); assert.equal(await readFile(moved, 'utf8'), f.raw);
  let restored;
  await trash.restoreSession(entry.id, f.source, async (value) => { restored = value.metadata; });
  assert.deepEqual(restored, metadata); assert.equal(await readFile(f.source, 'utf8'), f.raw);
  assert.equal((await trash.list()).entries.length, 0);
  await assert.rejects(trash.restoreSession(entry.id, f.source), /已经恢复/);
});

test('cross-volume restore and legacy trash listing keep recovery safe on copy failures', async (t) => {
  const f = await fixture(t); await mkdir(f.trashRoot);
  const legacy = join(f.trashRoot, '1234567890123-old.jsonl'); await writeFile(legacy, f.raw);
  let fail = true;
  const trash = createSessionTrash(() => f.trashRoot, { rename: async () => { throw Object.assign(new Error('cross-volume'), { code: 'EXDEV' }); },
    copyFile: async (...args) => { if (fail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return copyFile(...args); }, unlink });
  assert.equal((await trash.list()).entries[0].legacy, true);
  const target = join(f.root, 'other-volume', 'restored.jsonl');
  await assert.rejects(trash.restoreSession(basename(legacy), target), /disk full/); assert.equal(await readFile(legacy, 'utf8'), f.raw);
  fail = false; await trash.restoreSession(basename(legacy), target); assert.equal(await readFile(target, 'utf8'), f.raw);
});

test('permanent cleanup releases only confirmed inactive inputs and remains retryable if release fails', async t => {
  const f = await fixture(t), trash = createSessionTrash(() => f.trashRoot);
  const moved = await trash.trashSession(f.source, { cwd: f.cwd, sessionId: 'original-session' });
  const entry = (await trash.list()).entries[0], request = { entries: [{ id: entry.id, deletedAt: entry.deletedAt }] };
  let calls = 0, fail = true;
  const release = async value => { calls++; assert.equal(value.originalPath, f.source); if (fail) throw new Error('owners locked'); };
  await trash.cleanup({ entries: [{ id: entry.id, deletedAt: 'changed' }] }, async () => false, release);
  await trash.cleanup(request, async () => true, release); assert.equal(calls, 0);
  await assert.rejects(trash.cleanup(request, async () => false, release), /owners locked/);
  assert.equal(await readFile(moved, 'utf8'), f.raw); assert.equal((await trash.list()).entries.length, 1);
  fail = false; assert.deepEqual(await trash.cleanup(request, async () => false, release), { removed: [entry.id], skipped: [] });
  assert.equal(calls, 2); assert.equal((await trash.list()).entries.length, 0);
});

test('native import validates every graph before writing and imported sessions can continue with Pi', async (t) => {
  const f = await fixture(t), applied = [];
  const importer = createSessionImporter({ sessionsRoot: () => f.sessionsRoot, journalRoot: () => join(f.root, 'journal'), applyMetadata: async items => applied.push(...items) });
  for (const raw of ['malformed', f.raw.replace('"version":3', '"version":99'), f.raw.replace('"parentId":"root"', '"parentId":"missing"'), f.raw.replace('"id":"branch-new"', '"id":"root"')]) {
    await assert.rejects(importer.import(raw, 'native', f.cwd)); assert.deepEqual(await readdir(f.sessionsRoot), []);
  }
  const first = await importer.import(f.raw, 'native', f.cwd), again = await importer.import(f.raw, 'native', f.cwd);
  assert.equal(first.duplicate, false); assert.equal(again.duplicate, true); assert.deepEqual(first.paths, again.paths);
  const imported = validateNativeSession(await readFile(first.paths[0], 'utf8'));
  assert.notEqual(imported.header.id, 'original-session'); assert.deepEqual(imported.records.slice(1).map(item => item.id), ['root', 'branch-old', 'branch-new']);
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const manager = SessionManager.open(first.paths[0], undefined, f.cwd);
  manager.appendMessage({ role: 'user', content: 'continue after import', timestamp: Date.now() });
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'continued' }], api: 'openai-responses', provider: 'openai', model: 'test', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });
  assert.match(await readFile(first.paths[0], 'utf8'), /continue after import/);
  assert.ok(applied.length); assert.equal(await readFile(f.source, 'utf8'), f.raw);
});

test('complete backup preserves embedded attachments, metadata and branches; partial commit retry is idempotent', async (t) => {
  const f = await fixture(t);
  const raw = f.raw + JSON.stringify(f.message('attachment', 'branch-new', 'question\n\n<!-- pi-desktop:attachments-v1 -->\n<attached-file name="notes.txt" mime="text/plain" length="7">\ncontent\n</attached-file>')) + '\n';
  await writeFile(f.source, raw);
  const second = join(f.root, 'second.jsonl'); await writeFile(second, raw.replace('original-session', 'second-session'));
  const metadata = { archived: true, group: { id: 'g', name: 'Preserved group', index: 1 } };
  const backup = await createCompleteBackup([{ path: f.source, cwd: f.cwd, metadata }, { path: second, cwd: f.cwd }]);
  assert.equal(backup.format, 'pi-desktop-backup'); assert.match(backup.sessions[0].jsonl, /attached-file/);
  assert.throws(() => validateCompleteBackup(JSON.stringify({ ...backup, version: 2 })), /支持/);
  let commits = 0, fail = true, applied;
  const importer = createSessionImporter({ sessionsRoot: () => f.sessionsRoot, journalRoot: () => join(f.root, 'journal'), applyMetadata: async items => { applied = items; },
    commit: async (...args) => { commits++; if (fail && commits === 2) throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); return link(...args); } });
  await assert.rejects(importer.import(JSON.stringify(backup), 'backup', f.cwd), /no space/);
  const directory = join(f.sessionsRoot, `--${resolve(f.cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
  assert.deepEqual(await readdir(directory), []);
  fail = false;
  const restored = await importer.import(JSON.stringify(backup), 'backup', f.cwd);
  assert.equal(restored.paths.length, 2); assert.equal((await readdir(directory)).length, 2); assert.deepEqual(applied[0].metadata, metadata);
  assert.equal((await importer.import(JSON.stringify(backup), 'backup', f.cwd)).duplicate, true);
  assert.equal((await readdir(directory)).length, 2); assert.match(await readFile(restored.paths[0], 'utf8'), /attached-file/);
});

test('failed metadata rollback still removes imported files and retry reuses the transaction', async t => {
  const f = await fixture(t); let fail = true;
  const importer = createSessionImporter({ sessionsRoot: () => f.sessionsRoot, journalRoot: () => join(f.root, 'journal'),
    applyMetadata: async () => { if (fail) throw new Error('metadata write failed'); },
    rollbackMetadata: async () => { if (fail) throw new Error('metadata rollback failed'); } });
  await assert.rejects(importer.import(f.raw, 'native', f.cwd), error => error instanceof AggregateError && error.errors.length === 2);
  const directory = join(f.sessionsRoot, `--${resolve(f.cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
  assert.deepEqual(await readdir(directory), []); assert.equal(await readFile(f.source, 'utf8'), f.raw);
  fail = false; const result = await importer.import(f.raw, 'native', f.cwd);
  assert.equal(result.paths.length, 1); assert.equal((await importer.import(f.raw, 'native', f.cwd)).duplicate, true);
});
