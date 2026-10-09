import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile, utimes } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
registerHooks({ resolve(specifier, context, next) { if (specifier.startsWith('./') && context.parentURL?.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context); return next(specifier, context); } });
const { DiagnosticsService } = await import('../packages/desktop/src/main/diagnostics.ts');
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

test('renderer diagnostics retain correlation and timing in exported archives while filtering arbitrary payloads twice', async t => {
  const root = await fixture(t), service = new DiagnosticsService(join(root, 'logs'));
  const ui = {id:'navigation-12345678',scope:'session-navigation',kind:'session-open',outcome:'cancelled',temperature:'warm',
    durationMs:30.25,phases:{rpcMs:10.1,snapshotMs:15.2,renderMs:5.3,paintMs:9.65}};
  const unsafe = {cwd:'C:/private-project',message:'private conversation',apiKey:'sk-private-secret'};
  service.record({stage:'renderer',action:'session-open',outcome:'exit',ui:{...ui,...unsafe,phases:{...ui.phases,...unsafe}},...unsafe});
  await service.flush();
  const raw = await readFile(join(root,'logs','events.jsonl'),'utf8');
  assert.deepEqual(JSON.parse(raw).ui, ui);
  // Old or manually altered files are normalized again at export time.
  await writeFile(join(root,'logs','events.1.jsonl'), JSON.stringify({time:new Date().toISOString(),stage:'renderer',action:'render-error',outcome:'failure',
    ui:{id:'error-id-12345678',scope:'conversation',kind:'render-error',outcome:'failure',...unsafe},...unsafe}) + '\n');
  const output = join(root,'ui-diagnostics.zip');
  assert.equal((await service.archive(output,1,{app:'test'})).entries,2);
  const files = unzipSync(await readFile(output));
  assert.deepEqual(JSON.parse(strFromU8(files['events.jsonl'])).ui,ui);
  assert.equal(JSON.parse(strFromU8(files['events.1.jsonl'])).ui.id,'error-id-12345678');
  assert.doesNotMatch(raw + Object.values(files).map(strFromU8).join('\n'),/private-project|private conversation|sk-private-secret/);
});
test('diagnostic malformed-line manifest remains bounded', async t => {
  const root = await fixture(t), service = new DiagnosticsService(root); await writeFile(join(root, 'events.jsonl'), 'invalid\n'.repeat(50000));
  const result = await service.archive(join(root, 'bounded.zip'), 7, { app: 'test' }); assert.equal(result.entries, 0); assert(result.skipped.length <= 201); const files = unzipSync(await readFile(join(root, 'bounded.zip'))); assert(files['manifest.json'].length < 30000); assert.match(strFromU8(files['manifest.json']), /省略/);
});
