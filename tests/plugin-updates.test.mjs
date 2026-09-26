import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPluginUpdate, installPluginUpdate } from '../packages/agent/src/pluginUpdates.ts';

async function fixture(t, source = 'npm:example-plugin@^1.0.0', installed = '1.0.0') {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-plugin-update-')), path = join(cwd, 'installed');
  t.after(() => rm(cwd, { recursive: true, force: true })); await mkdir(path);
  if (installed) await writeFile(join(path, 'package.json'), JSON.stringify({ name: 'example-plugin', version: installed }));
  const state = { user: [source], project: [], calls: [], sets: 0, flushes: 0, install: null, fetch: null };
  const settingsManager = {
    reload: async () => {}, getGlobalSettings: () => ({ packages: structuredClone(state.user) }), getProjectSettings: () => ({ packages: structuredClone(state.project) }),
    setPackages: value => { state.sets++; state.user = structuredClone(value); }, setProjectPackages: value => { state.sets++; state.project = structuredClone(value); }, flush: async () => { state.flushes++; },
  };
  const manager = { getInstalledPath: () => path, install: async (source, options) => {
    state.calls.push({ source, options }); if (state.install) return state.install(source, options);
    await writeFile(join(path, 'package.json'), JSON.stringify({ name: 'example-plugin', version: source.slice(source.lastIndexOf('@') + 1) }));
  } };
  const registry = { versions: { '1.0.0': {}, '1.5.0': {}, '2.0.0': {}, '2.1.0-beta.1': {} }, 'dist-tags': { latest: '2.0.0', next: '2.1.0-beta.1' } };
  const dependencies = { createManager: () => manager, fetch: async (...args) => state.fetch ? state.fetch(...args) : new Response(JSON.stringify(registry)) };
  const services = { cwd, agentDir: join(cwd, 'agent'), settingsManager, resourceLoader: {} };
  const check = latest => checkPluginUpdate(services, { cwd, scope: 'user', source: typeof source === 'string' ? source : source.source, ...(latest !== undefined ? { latest } : {}) }, dependencies);
  const install = preview => installPluginUpdate(services, { cwd, scope: 'user', previewId: preview.id }, dependencies);
  return { cwd, path, state, dependencies, services, check, install };
}

test('npm version check is read only, selects exact range target and preserves resource filters on install', async t => {
  const entry = { source: 'npm:example-plugin@^1.0.0', extensions: ['src/*.ts', '!src/private.ts'], skills: [] };
  const f = await fixture(t, entry), before = await readFile(join(f.path, 'package.json'));
  const preview = await f.check(); assert.equal(preview.kind, 'upgrade'); assert.equal(preview.target, '1.5.0'); assert.equal(preview.latest, '2.0.0'); assert.equal(preview.constraint, '^1.0.0');
  assert.equal(f.state.calls.length, 0); assert.equal(f.state.sets, 0); assert.equal(f.state.flushes, 0); assert.deepEqual(await readFile(join(f.path, 'package.json')), before);
  await f.install(preview); assert.deepEqual(f.state.calls, [{ source: 'npm:example-plugin@1.5.0', options: { local: false } }]); assert.deepEqual(f.state.user, [{ ...entry, source: 'npm:example-plugin@1.5.0' }]);
  await assert.rejects(f.install(preview), /已过期/);
});

test('fixed version repair and explicit latest upgrade produce distinct confirmed targets', async t => {
  const f = await fixture(t, 'npm:example-plugin@1.0.0'); const repair = await f.check(), latest = await f.check(true);
  assert.equal(repair.kind, 'repair'); assert.equal(repair.target, '1.0.0'); assert.equal(latest.kind, 'upgrade'); assert.equal(latest.target, '2.0.0'); assert.equal(f.state.calls.length, 0);
  await f.install(repair); assert.equal(f.state.calls[0].source, 'npm:example-plugin@1.0.0');
  const missing = await fixture(t, 'npm:example-plugin@1.0.0', null); assert.equal((await missing.check()).kind, 'repair');
});

test('newer installed versions are never offered as downgrades; current and prerelease tags are accurate', async t => {
  const newer = await fixture(t, 'npm:example-plugin@1.0.0', '2.0.0'), preview = await newer.check(); assert.equal(preview.kind, 'current'); await assert.rejects(newer.install(preview), /没有可安装目标/);
  const current = await fixture(t, 'npm:example-plugin@^1.0.0', '1.5.0'); assert.equal((await current.check()).kind, 'current');
  const next = await fixture(t, 'npm:example-plugin@next'); assert.equal((await next.check()).target, '2.1.0-beta.1');
});

test('unsupported sources and network failure have no install or configuration side effects', async t => {
  const git = await fixture(t, 'git:https://example.invalid/plugin#main'); git.state.fetch = () => { throw new Error('must not fetch'); }; assert.equal((await git.check()).kind, 'unsupported');
  const npm = await fixture(t); npm.state.fetch = async () => { throw new Error('offline'); }; const failed = await npm.check(); assert.equal(failed.kind, 'failed'); assert.equal(failed.target, null); assert.equal(failed.targetSource, null);
  assert.equal(git.state.calls.length + npm.state.calls.length, 0); assert.equal(git.state.sets + npm.state.sets, 0);
});

test('actual installed version mismatch fails without rewriting configured sources', async t => {
  const f = await fixture(t), preview = await f.check(); f.state.install = async () => {}; await assert.rejects(f.install(preview), /实际安装版本/); assert.equal(f.state.sets, 0); assert.deepEqual(f.state.user, ['npm:example-plugin@^1.0.0']);
});

test('configuration changes before check completion or during install never overwrite newer settings', async t => {
  const f = await fixture(t); f.state.fetch = async () => { f.state.user = ['npm:different@1.0.0']; return new Response(JSON.stringify({ versions: { '1.5.0': {} }, 'dist-tags': { latest: '1.5.0' } })); };
  const stale = await f.check(); await assert.rejects(f.install(stale), /配置已改变/); assert.equal(f.state.calls.length, 0);
  const other = await fixture(t), preview = await other.check(); other.state.install = async () => { await writeFile(join(other.path, 'package.json'), JSON.stringify({ version: preview.target })); other.state.user = [{ source: 'npm:external@3.0.0', skills: [] }]; };
  await assert.rejects(other.install(preview), /外部修改/); assert.equal(other.state.sets, 0); assert.deepEqual(other.state.user, [{ source: 'npm:external@3.0.0', skills: [] }]);
});

test('cross-workspace requests and duplicate pending installations are rejected', async t => {
  const f = await fixture(t), preview = await f.check(); await assert.rejects(installPluginUpdate(f.services, { cwd: join(f.cwd, 'other'), scope: 'user', previewId: preview.id }, f.dependencies), /安装参数无效/);
  let release; f.state.install = async () => { await new Promise(resolve => { release = resolve; }); await writeFile(join(f.path, 'package.json'), JSON.stringify({ version: preview.target })); };
  const first = f.install(preview); while (!release) await new Promise(resolve => setImmediate(resolve)); await assert.rejects(f.install(preview), /正在安装/); release(); await first; assert.equal(f.state.calls.length, 1);
});
