import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile, utimes } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
registerHooks({ resolve(specifier, context, next) { if (specifier.startsWith('./') && context.parentURL?.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context); return next(specifier, context); } });
const { DiagnosticsService } = await import('../packages/desktop/src/main/diagnostics.ts');
const { UsageService } = await import('../packages/desktop/src/main/usageService.ts');
const { StorageService } = await import('../packages/desktop/src/main/storageService.ts');
const { unzipSync, strFromU8 } = createRequire(new URL('../packages/desktop/package.json', import.meta.url))('fflate');
async function fixture(t) { const root = await mkdtemp(join(tmpdir(), 'pi-management-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test('diagnostics preserve stages and RPC identity without arbitrary error bodies or credentials', async t => {
  const root = await fixture(t), service = new DiagnosticsService(join(root, 'logs'));
  for (const stage of ['startup', 'host', 'plugin', 'rpc']) service.record({ stage, action: 'test', outcome: 'failure', durationMs: 12, requestId: 42, error: 'Authorization: Bearer secret-token', apiKey: 'sk-private', prompt: 'private prompt' });
  await service.flush();
  await writeFile(join(root, 'logs', 'events.1.jsonl'), JSON.stringify({ time: new Date().toISOString(), stage: 'rpc', action: 'prompt', outcome: 'failure', authorization: 'Bearer another-secret' }) + '\ninvalid\n');
  const output = join(root, 'diagnostics.zip'), result = await service.archive(output, 7, { app: 'test' });
  assert.equal(result.entries, 5); assert.ok(result.skipped.some(v => v.includes('损坏')));
  const files = unzipSync(await readFile(output));
  const text = Object.values(files).map(strFromU8).join('\n');
  assert.doesNotMatch(text, /secret-token|sk-private|private prompt|another-secret/);
  assert.match(text, /"requestId":42/);
  assert.ok(files['manifest.json']);
  assert.deepEqual((await readdir(root)).filter(name => name.endsWith('.tmp')), []);
});

test('diagnostics rotate before appending and bound export with a skipped-file manifest', async t => {
  const root = await fixture(t), service = new DiagnosticsService(root);
  await writeFile(join(root, 'events.jsonl'), 'x'.repeat(512 * 1024));
  await writeFile(join(root, 'events.8.jsonl'), 'oldest');
  service.record({ stage: 'host', action: 'exit', outcome: 'exit', code: '1' }); await service.flush();
  assert.equal((await readFile(join(root, 'events.1.jsonl'))).length, 512 * 1024);
  assert.ok((await readFile(join(root, 'events.jsonl'))).length < 1024);
  await assert.rejects(readFile(join(root, 'events.8.jsonl')), { code: 'ENOENT' });
});

function session(cwd, sid, messages) { return [{ type: 'session', id: sid, version: 3, cwd }, ...messages.map((m, i) => ({ type: 'message', id: m.id ?? `message-${i}`, parentId: i ? `message-${i - 1}` : null, message: { role: 'assistant', provider: 'mock', model: m.model ?? 'test-model', timestamp: m.timestamp ?? '2026-09-25T18:00:00.000Z', usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, ...(m.cost === undefined ? {} : { cost: { total: m.cost } }) } } }))].map(v => JSON.stringify(v)).join('\n') + '\n'; }
test('usage ledger counts real branch messages once, persists cache and respects timezone, source and unknown prices', async t => {
  const root = await fixture(t), sessions = join(root, 'sessions'), dir = join(sessions, 'project'); await mkdir(dir, { recursive: true });
  const cwd = join(root, 'workspace'), a = join(dir, 'a.jsonl'), b = join(dir, 'b.jsonl');
  const raw = session(cwd, 'same-session', [{ cost: .25 }, { cost: .5 }]);
  await writeFile(a, raw); await writeFile(join(dir, 'copy.jsonl'), raw);
  await writeFile(b, session(cwd, 'automation-session', [{ id: 'automated', model: 'other', cost: undefined }]));
  const index = join(root, 'usage.json'), service = new UsageService(sessions, index);
  const query = { requestId: 'first', from: '2026-09-26', to: '2026-09-26', timeZone: 'Asia/Shanghai' };
  const first = await service.report(query, [cwd], [b]);
  assert.equal(first.rows.reduce((n, row) => n + row.messages, 0), 3);
  assert.equal(first.rows.find(row => row.source === 'interactive').cost, .75);
  assert.equal(first.rows.find(row => row.source === 'automation').cost, null);
  const second = await new UsageService(sessions, index).report({ ...query, requestId: 'second' }, [cwd], [b]);
  assert.equal(second.updated, 0); assert.deepEqual(second.rows, first.rows);
  const utc = await service.report({ ...query, requestId: 'utc', timeZone: 'UTC' }, [cwd], [b]); assert.equal(utc.rows.length, 0);
  const onlyModel = await service.report({ ...query, requestId: 'model', model: 'other' }, [cwd], [b]); assert.equal(onlyModel.rows[0].messages, 1);
});

test('usage cancellation stops a pending query and does not create an index', async t => {
  const root = await fixture(t), service = new UsageService(join(root, 'sessions'), join(root, 'index.json'));
  const pending = service.report({ requestId: 'cancel', from: '2026-01-01', to: '2026-12-31', timeZone: 'UTC' }, [], []); service.cancel('cancel');
  await assert.rejects(pending, /abort/i); await assert.rejects(readFile(join(root, 'index.json')), { code: 'ENOENT' });
});

test('storage cleanup excludes live data and detects changed preview files while reporting partial success', async t => {
  const root = await fixture(t), user = join(root, 'user'), agent = join(root, 'agent'); await mkdir(user); await mkdir(agent);
  await mkdir(join(agent, 'sessions')); await mkdir(join(user, 'diagnostics'));
  const backup = join(user, 'settings.json.corrupt-123.bak'), changed = join(user, 'diagnostics', 'events.1.jsonl'), live = join(user, 'diagnostics', 'events.jsonl');
  const sessionIndex = join(agent, 'sessions', '.desktop-search-v1.json');
  for (const path of [backup, changed, live, join(agent, 'auth.json'), join(agent, 'sessions', 'normal.jsonl'), sessionIndex]) { await writeFile(path, 'original'); await utimes(path, new Date(0), new Date(0)); }
  const service = new StorageService(user, agent), snapshot = await service.snapshot('scan');
  assert.equal(snapshot.items.find(v => v.category === 'sessions').files, 1);
  assert.equal(snapshot.items.find(v => v.category === 'search-cache').files, 1);
  const preview = await service.preview({ requestId: 'preview', categories: ['diagnostics', 'corrupt-backups'], olderThanDays: 1 });
  assert.equal(preview.files.length, 2); assert.ok(!preview.files.some(f => f.path === live));
  await writeFile(changed, 'externally changed');
  const result = await service.execute(preview.id);
  assert.equal(result.removed, 1); assert.equal(result.releasedBytes, 8); assert.equal(result.failed.length, 1);
  assert.equal(await readFile(changed, 'utf8'), 'externally changed'); assert.equal(await readFile(join(agent, 'auth.json'), 'utf8'), 'original');
  await assert.rejects(service.execute(preview.id), /过期/);
  await assert.rejects(service.preview({ requestId: 'bad', categories: ['sessions'], olderThanDays: 1 }), /范围/);
  const cachePlan = await service.preview({ requestId: 'cache-preview', categories: ['search-cache'], olderThanDays: 1 });
  assert.deepEqual(cachePlan.files.map(file => file.path), [sessionIndex]);
  assert.equal((await service.execute(cachePlan.id)).removed, 1);
  assert.equal(await readFile(join(agent, 'sessions', 'normal.jsonl'), 'utf8'), 'original');
});

test('storage cleanup refuses a replaced root junction even when file contents and inode still match', async t => {
  const root = await fixture(t), user = join(root, 'user'), agent = join(root, 'agent'), moved = join(root, 'moved'); await mkdir(user); await mkdir(agent);
  const name = 'settings.json.corrupt-123.bak'; await writeFile(join(user, name), 'keep original'); await utimes(join(user, name), new Date(0), new Date(0));
  const service = new StorageService(user, agent), plan = await service.preview({ requestId: 'root-preview', categories: ['corrupt-backups'], olderThanDays: 1 }); assert.equal(plan.files.length, 1);
  await rename(user, moved); await symlink(moved, user, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await service.execute(plan.id); assert.equal(result.removed, 0); assert.equal(result.failed.length, 1); assert.match(result.failed[0].reason, /根目录/); assert.equal(await readFile(join(moved, name), 'utf8'), 'keep original');
});

test('real SDK forks do not duplicate inherited usage or transfer original project and automation attribution', async t => {
  const { SessionManager } = await import('../packages/agent/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js');
  const root = await fixture(t), sessions = join(root, 'sessions'), originalDir = join(sessions, 'z-original'), forkDir = join(sessions, 'a-fork'); await mkdir(originalDir, { recursive: true });
  const originalCwd = join(root, 'original'), forkCwd = join(root, 'fork'); await mkdir(originalCwd); await mkdir(forkCwd);
  const originalPath = join(originalDir, 'original.jsonl'); await writeFile(originalPath, session(originalCwd, 'original-session', [{ id: 'copied-entry', cost: .5 }]));
  const fork = SessionManager.forkFrom(originalPath, forkCwd, forkDir); assert.notEqual(fork.getSessionId(), 'original-session');
  const service = new UsageService(sessions, join(root, 'usage-index.json')), query = { requestId: 'sdk-fork', from: '2026-09-25', to: '2026-09-26', timeZone: 'UTC' };
  const report = await service.report(query, [originalCwd, forkCwd], [originalPath]); assert.equal(report.rows.length, 1); assert.equal(report.rows[0].messages, 1); assert.equal(report.rows[0].cwd, originalCwd); assert.equal(report.rows[0].source, 'automation'); assert.equal(report.rows[0].cost, .5);
  const forkOnly = await service.report({ ...query, requestId: 'fork-only', cwd: forkCwd }, [originalCwd, forkCwd], [originalPath]); assert.equal(forkOnly.rows.length, 0);
});

test('invalid cached usage values rebuild from source and impossible calendar dates reject', async t => {
  const root = await fixture(t), sessions = join(root, 'sessions'), dir = join(sessions, 'project'), cwd = join(root, 'workspace'), index = join(root, 'index.json'); await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'a.jsonl'), session(cwd, 'one', [{ cost: .25 }]));
  const query = { requestId: 'initial-cache', from: '2026-09-25', to: '2026-09-26', timeZone: 'UTC' }; await new UsageService(sessions, index).report(query, [cwd], []);
  const cache = JSON.parse(await readFile(index, 'utf8')); Object.values(cache.files)[0].entries[0].input = 'bad'; await writeFile(index, JSON.stringify(cache));
  const service = new UsageService(sessions, index), report = await service.report({ ...query, requestId: 'repair-cache' }, [cwd], []); assert.equal(report.updated, 1); assert.equal(report.rows[0].input, 10);
  await assert.rejects(service.report({ ...query, requestId: 'invalid-date', from: '2026-02-30' }, [cwd], []), /范围无效/);
});

test('diagnostic malformed-line manifest remains bounded', async t => {
  const root = await fixture(t), service = new DiagnosticsService(root); await writeFile(join(root, 'events.jsonl'), 'invalid\n'.repeat(50000));
  const result = await service.archive(join(root, 'bounded.zip'), 7, { app: 'test' }); assert.equal(result.entries, 0); assert(result.skipped.length <= 201); const files = unzipSync(await readFile(join(root, 'bounded.zip'))); assert(files['manifest.json'].length < 30000); assert.match(strFromU8(files['manifest.json']), /省略/);
});
