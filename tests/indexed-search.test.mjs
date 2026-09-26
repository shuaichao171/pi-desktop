import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cancelDataSearch, getProjectSearchRules, piSessionDirectory, rebuildSearchIndex, searchProjectFiles, searchSessionsPage, setProjectSearchRules } from '../packages/desktop/src/main/indexedSearch.ts';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-indexed-search-')), sessionsRoot = join(root, 'sessions'), cwd = join(root, 'project');
  await mkdir(cwd); await mkdir(sessionsRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = piSessionDirectory(sessionsRoot, cwd); await mkdir(directory);
  return { root, cwd, sessionsRoot, directory };
}
function message(id, parentId, text) { return { type: 'message', id, parentId, timestamp: '2026-09-26T12:00:00.000Z', message: { role: 'user', content: text } }; }
async function session(f, id, entries) {
  const path = join(f.directory, `${id}.jsonl`);
  await writeFile(path, [{ type: 'session', version: 3, id, cwd: f.cwd, timestamp: '2026-09-26T12:00:00.000Z' }, ...entries].map(JSON.stringify).join('\n') + '\n');
  return path;
}
test('session index paginates past 80 and warm queries never reread unchanged JSONL; edits/deletes rebuild incrementally', async t => {
  const f = await fixture(t), paths = [];
  for (let index = 0; index < 160; index++) paths.push(await session(f, `session-${String(index).padStart(3, '0')}`, [message('m', null, `needle ${index} ${'history '.repeat(1000)}`)]));
  const original = await readFile(paths[0], 'utf8');
  const cold = await searchSessionsPage(f.sessionsRoot, [f.cwd], { query: 'needle', limit: 80 });
  assert.equal(cold.sessions.length, 80); assert.equal(cold.total, 160); assert.ok(cold.nextCursor); assert.equal(cold.diagnostics.filesRead, 160);
  const second = await searchSessionsPage(f.sessionsRoot, [f.cwd], { query: 'needle', limit: 80, cursor: cold.nextCursor });
  assert.equal(new Set([...cold.sessions, ...second.sessions].map(item => item.resultId)).size, 160); assert.equal(second.nextCursor, undefined);
  await assert.rejects(searchSessionsPage(f.sessionsRoot, [f.cwd], { query: 'different', cursor: cold.nextCursor }), /过期/);
  const warm = await searchSessionsPage(f.sessionsRoot, [f.cwd], { query: 'history' });
  assert.equal(warm.diagnostics.filesRead, 0); assert.equal(warm.diagnostics.bytesRead, 0);
  t.diagnostic(`Measured 160 sessions / ${cold.diagnostics.bytesRead} JSONL bytes: cold ${cold.diagnostics.elapsedMs} ms (${cold.diagnostics.filesRead} reads), warm ${warm.diagnostics.elapsedMs} ms (${warm.diagnostics.filesRead} reads).`);
  await writeFile(paths[0], original.replace('needle 0', 'edited keyword')); await rm(paths[1]);
  const edited = await searchSessionsPage(f.sessionsRoot, [f.cwd], { query: 'edited keyword' });
  assert.equal(edited.sessions.length, 1); assert.equal(edited.diagnostics.filesRead, 1); assert.equal(edited.diagnostics.indexed, 159);
  await writeFile(join(f.sessionsRoot, '.desktop-search-v1.json'), '{broken');
  await rebuildSearchIndex(f.sessionsRoot, [f.cwd]);
  assert.equal(await readFile(paths[0], 'utf8'), original.replace('needle 0', 'edited keyword'));
  assert.equal((await searchSessionsPage(f.sessionsRoot, [f.cwd], { query: 'edited' })).sessions.length, 1);
});

test('scope and current in-memory branches are honored before pagination; other branches have explicit identities', async t => {
  const f = await fixture(t), path = await session(f, 'branches', [message('root', null, 'question'), message('old', 'root', 'old branch keyword'), message('live', 'root', 'live branch keyword')]);
  const metadata = { [path]: { archived: true, pinned: true } };
  assert.equal((await searchSessionsPage(f.sessionsRoot, [f.cwd], { query: 'old' })).sessions.length, 0);
  const alternate = await searchSessionsPage(f.sessionsRoot, [f.cwd], { query: 'keyword', otherBranches: true }, metadata);
  assert.equal(alternate.sessions.length, 2); assert.equal(alternate.sessions[0].otherBranch, undefined); assert.equal(alternate.sessions[1].otherBranch, true); assert.equal(alternate.sessions[1].branchLeafId, 'old');
  const switched = await searchSessionsPage(f.sessionsRoot, [f.cwd], { query: 'old' }, metadata, { [path]: 'old' });
  assert.equal(switched.sessions[0].messageId, 'old'); assert.equal(switched.diagnostics.filesRead, 0);
  assert.equal((await searchSessionsPage(f.sessionsRoot, [f.cwd], { query: '', archived: 'exclude' }, metadata)).total, 0);
  assert.equal((await searchSessionsPage(f.sessionsRoot, [f.cwd], { query: '', archived: 'only', workspace: f.cwd }, metadata)).total, 1);
  assert.equal((await searchSessionsPage(f.sessionsRoot, [f.cwd], { query: '', after: '2027-01-01' })).total, 0);
  cancelDataSearch('cancel-before-start');
  const cancelled = await searchSessionsPage(f.sessionsRoot, [f.cwd], { query: '', requestId: 'cancel-before-start' });
  assert.equal(cancelled.cancelled, true); assert.deepEqual(cancelled.sessions, []);
});

test('running automation sessions are excluded before reads, totals and paging; changes invalidate an old cursor', async t => {
  const f = await fixture(t), paths = [];
  for (let index = 0; index < 4; index++) paths.push(await session(f, `run-${index}`, [message('m', null, 'needle')]));
  const first = await searchSessionsPage(f.sessionsRoot, [f.cwd], { query: 'needle', limit: 1 }, {}, {}, [paths[0]]);
  assert.equal(first.total, 3); assert.equal(first.sessions.length, 1); assert.equal(first.diagnostics.filesRead, 3);
  assert.notEqual(first.sessions[0].path, paths[0]); assert.ok(first.nextCursor);
  const next = await searchSessionsPage(f.sessionsRoot, [f.cwd], { query: 'needle', limit: 1, cursor: first.nextCursor }, {}, {}, [paths[0]]);
  assert.equal(next.total, 3); assert.notEqual(next.sessions[0].path, paths[0]);
  await assert.rejects(searchSessionsPage(f.sessionsRoot, [f.cwd], { query: 'needle', cursor: first.nextCursor }, {}, {}, [paths[0], paths[1]]), /过期/);
});

test('project content search returns exact literal positions, explains skips, refreshes renames and shares rules with paths', async t => {
  const f = await fixture(t); await mkdir(join(f.cwd, 'src')); await mkdir(join(f.cwd, 'node_modules'));
  await writeFile(join(f.cwd, 'src', 'innocent.txt'), 'first\n中文 Needle [a.*]\nlast needle');
  await writeFile(join(f.cwd, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(f.cwd, 'large.txt'), 'x'.repeat(3000)); await writeFile(join(f.cwd, 'node_modules', 'hidden.txt'), 'needle');
  const rules = { ...getProjectSearchRules(f.cwd), maxFileBytes: 1024 };
  setProjectSearchRules(f.cwd, rules);
  const result = await searchProjectFiles(f.cwd, { query: 'Needle [a.*]', mode: 'content', caseSensitive: true });
  assert.equal(result.files.length, 1); assert.equal(result.files[0].path, 'src/innocent.txt'); assert.equal(result.files[0].line, 2); assert.equal(result.files[0].column, 4);
  assert.equal(result.skipReasons.binary, 1); assert.equal(result.skipReasons.large, 1); assert.ok(result.skipReasons.ignored);
  assert.equal((await searchProjectFiles(f.cwd, { query: 'needle [a.*]', mode: 'content', caseSensitive: true })).total, 0);
  await rename(join(f.cwd, 'src', 'innocent.txt'), join(f.cwd, 'src', 'renamed.txt'));
  assert.equal((await searchProjectFiles(f.cwd, { query: 'needle', mode: 'content' })).files[0].path, 'src/renamed.txt');
  const path = await searchProjectFiles(f.cwd, { query: 'renamed' }); assert.equal(path.total, 1); assert.equal(path.diagnostics.filesRead, 0);
  setProjectSearchRules(f.cwd, { ...rules, include: ['src/**'], exclude: ['**/renamed.txt'] });
  assert.equal((await searchProjectFiles(f.cwd, { query: 'needle', mode: 'content', refresh: true })).total, 0);
  assert.equal((await searchProjectFiles(f.cwd, { query: 'renamed' })).total, 0);
});
