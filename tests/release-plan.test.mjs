import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { createReleasePlan } from '../.github/scripts/release-plan.mjs';

const input = { tag: 'v0.1.1', rootVersion: '0.1.1', desktopVersion: '0.1.1' };
test('release defaults allow Windows and Linux without signing credentials', () => {
  const plan = createReleasePlan(input);
  assert.equal(plan.signWindows, false);
  assert.equal(plan.buildMac, false);
  assert.equal(plan.feed, 'https://github.com/shuaichao171/pi-desktop/releases/latest/download/');
});

test('release signing is enabled only for complete credential sets and never exposes their values', () => {
  for (const name of ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) {
    assert.throws(() => createReleasePlan({ ...input, env: { [name]: 'test-secret-value' } }), (error) =>
      /Windows signing/.test(error.message) && !error.message.includes('test-secret-value'));
  }
  const env = Object.fromEntries(['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'MAC_CSC_LINK', 'MAC_CSC_KEY_PASSWORD', 'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'].map((name) => [name, 'test-secret-value']));
  assert.equal(createReleasePlan({ ...input, env }).signWindows, true);
  assert.equal(createReleasePlan({ ...input, env }).buildMac, true);
  delete env.APPLE_TEAM_ID;
  const partial = createReleasePlan({ ...input, env });
  assert.equal(partial.buildMac, false);
  assert.equal(partial.partialMac, true);
  assert.deepEqual(partial.missingMac, ['APPLE_TEAM_ID']);
  assert.equal(JSON.stringify(partial).includes('test-secret-value'), false);
});

test('release tags must be stable exact versions matching both manifests', () => {
  for (const tag of ['main', 'v0.1.1-beta.1', 'v0.1.1+build.1', 'v01.1.1', 'v0.1', 'v0.1.1\n', '--help']) {
    assert.throws(() => createReleasePlan({ ...input, tag }), /stable version/);
  }
  assert.throws(() => createReleasePlan({ ...input, desktopVersion: '0.1.0' }), /versions differ/);
  assert.throws(() => createReleasePlan({ ...input, rootVersion: '0.1.2' }), /versions differ/);
  assert.throws(() => createReleasePlan({ ...input, env: { PI_DESKTOP_UPDATE_URL: 'http://example.com/' } }), /HTTPS/);
});

test('release plan pins the checked-out tag commit and rejects a different commit before emitting outputs', async (t) => {
  const parent = await realpath(tmpdir());
  const dir = await mkdtemp(join(parent, 'pi-release-plan-'));
  t.after(async () => { assert.equal(dirname(dir), parent); await rm(dir, { recursive: true, force: true }); });
  await mkdir(join(dir, 'packages', 'desktop'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ version: '0.1.1' }));
  await writeFile(join(dir, 'packages', 'desktop', 'package.json'), JSON.stringify({ version: '0.1.1' }));
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=Release Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init'); git('add', '.'); git('commit', '-m', 'Release fixture'); git('tag', 'v0.1.1');
  const sha = git('rev-parse', 'HEAD');
  const output = join(dir, 'github-output.txt');
  const env = { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: '', PI_DESKTOP_UPDATE_URL: '',
    WIN_CSC_LINK: '', WIN_CSC_KEY_PASSWORD: '', MAC_CSC_LINK: '', MAC_CSC_KEY_PASSWORD: '',
    APPLE_ID: '', APPLE_APP_SPECIFIC_PASSWORD: '', APPLE_TEAM_ID: '' };
  const script = resolve('.github/scripts/release-plan.mjs');
  const invoke = () => spawnSync(process.execPath, [script, '--tag', 'v0.1.1'], { cwd: dir, env, encoding: 'utf8' });
  const first = invoke();
  assert.equal(first.status, 0, first.stderr);
  const outputs = await readFile(output, 'utf8');
  assert.ok(outputs.includes(`sha=${sha}\n`));
  assert.match(outputs, /windows_signed=false\nmacos=false\n/);
  git('commit', '--allow-empty', '-m', 'Unrelated later commit');
  const rejected = invoke();
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Checkout does not match/);
  assert.equal(await readFile(output, 'utf8'), outputs);
});
