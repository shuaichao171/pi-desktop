import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import YAML from 'yaml';
import { verifyReleaseArtifacts } from '../.github/scripts/verify-release-artifacts.mjs';

const version = '0.2.0';
const script = resolve('.github/scripts/verify-release-artifacts.mjs');
const setup = `Pi-Desktop-Setup-${version}-x64.exe`;
const portable = `Pi-Desktop-Portable-${version}-x64.exe`;
const appImage = `Pi-Desktop-${version}-x64.AppImage`;
const deb = `Pi-Desktop-${version}-x64.deb`;

async function fixture(t, { macos = false } = {}) {
  const parent = await realpath(tmpdir());
  const dir = await mkdtemp(join(parent, 'pi-release-artifacts-'));
  t.after(async () => {
    assert.equal(dirname(resolve(dir)), parent);
    await rm(dir, { recursive: true, force: true });
  });
  async function artifact(name) {
    const content = `offline fixture ${name}`;
    await writeFile(join(dir, name), content);
    return { url: name, sha512: createHash('sha512').update(content).digest('base64'), size: Buffer.byteLength(content) };
  }
  async function manifest(name, files) {
    await writeFile(join(dir, name), YAML.stringify({ version, files, path: files[0].url, sha512: files[0].sha512 }));
  }
  async function editManifest(name, edit) {
    const info = YAML.parse(await readFile(join(dir, name), 'utf8'));
    edit(info);
    await writeFile(join(dir, name), YAML.stringify(info));
  }
  await manifest('latest.yml', [await artifact(setup)]);
  await artifact(portable);
  await artifact(`${setup}.blockmap`);
  await manifest('latest-linux.yml', [await artifact(appImage), await artifact(deb)]);
  if (macos) {
    const files = [];
    for (const arch of ['x64', 'arm64']) {
      for (const ext of ['zip', 'dmg']) files.push(await artifact(`Pi-Desktop-${version}-${arch}.${ext}`));
    }
    await manifest('latest-mac.yml', files);
  }
  return { dir, artifact, editManifest, verify: () => verifyReleaseArtifacts(dir, { version, macos }) };
}

test('Windows and Linux release returns only verified current-batch assets and known optional blockmaps', async (t) => {
  const f = await fixture(t);
  await f.artifact(`${portable}.blockmap`);
  await f.artifact(`${appImage}.blockmap`);
  for (const name of ['builder-debug.yml', 'latest.yml.tmp', 'build.log', 'Pi-Desktop-Setup-0.1.0-x64.exe', 'latest-mac.yml']) await f.artifact(name);
  await mkdir(join(f.dir, 'win-unpacked'));
  assert.deepEqual((await f.verify()).map((path) => basename(path)), [setup, portable, `${setup}.blockmap`, 'latest.yml', appImage, deb, 'latest-linux.yml', `${portable}.blockmap`, `${appImage}.blockmap`]);
});

test('macOS requires both native ZIPs and DMGs and includes only optional ZIP blockmaps', async (t) => {
  const f = await fixture(t, { macos: true });
  await f.artifact(`Pi-Desktop-${version}-arm64.zip.blockmap`);
  await f.artifact(`Pi-Desktop-${version}-arm64.dmg.blockmap`);
  const files = (await f.verify()).map((path) => basename(path));
  assert.equal(files.length, 13);
  assert.ok(files.includes('latest-mac.yml'));
  assert.ok(files.includes(`Pi-Desktop-${version}-arm64.zip.blockmap`));
  assert.ok(!files.includes(`Pi-Desktop-${version}-arm64.dmg.blockmap`));
  await f.editManifest('latest-mac.yml', (info) => { info.files = info.files.filter((file) => !file.url.endsWith('-arm64.zip')); });
  await assert.rejects(f.verify(), /Required update artifact missing.*arm64\.zip/);
});

test('every required binary, blockmap and manifest must exist as a nonempty regular file', async (t) => {
  const f = await fixture(t, { macos: true });
  for (const path of await f.verify()) {
    const content = await readFile(path);
    await rm(path);
    await assert.rejects(f.verify(), /Missing release artifact/);
    await mkdir(path);
    await assert.rejects(f.verify(), /nonempty regular file/);
    await rm(path, { recursive: true });
    await writeFile(path, content);
  }
  await writeFile(join(f.dir, `${setup}.blockmap`), '');
  await assert.rejects(f.verify(), /nonempty regular file/);
});

test('metadata rejects traversal, absolute URLs, other versions and wrong platform installers', async (t) => {
  const f = await fixture(t);
  const original = await readFile(join(f.dir, 'latest.yml'));
  for (const url of [`../${setup}`, `sub/${setup}`, `sub\\${setup}`, `https://example.com/${setup}`, `C:\\${setup}`, `${setup}?download=1`, 'Pi-Desktop-Setup-0.1.0-x64.exe', portable, appImage]) {
    for (const field of ['files', 'path']) {
      await writeFile(join(f.dir, 'latest.yml'), original);
      await f.editManifest('latest.yml', (info) => { if (field === 'files') info.files[0].url = url; else info.path = url; });
      await assert.rejects(f.verify(), /Unexpected update/);
    }
  }
});

test('all platform metadata versions and every listed/fallback SHA-512 are checked against bytes', async (t) => {
  const f = await fixture(t, { macos: true });
  for (const name of ['latest.yml', 'latest-linux.yml', 'latest-mac.yml']) {
    const original = await readFile(join(f.dir, name));
    for (const [mutate, pattern] of [
      [(info) => { info.version = '0.2.1'; }, /version mismatch/],
      [(info) => { info.files[0].sha512 = 'invalid'; }, /SHA-512 mismatch/],
      [(info) => { info.sha512 = 'invalid'; }, /SHA-512 mismatch/],
      [(info) => { info.files[0].size++; }, /size mismatch/],
      [(info) => { info.files.push(info.files[0]); }, /Duplicate update artifact/],
      [(info) => { info.files = []; }, /files are missing/],
    ]) {
      await writeFile(join(f.dir, name), original);
      await f.editManifest(name, mutate);
      await assert.rejects(f.verify(), pattern);
    }
    await writeFile(join(f.dir, name), original);
  }
  await writeFile(join(f.dir, `Pi-Desktop-${version}-arm64.dmg`), 'tampered artifact bytes');
  await assert.rejects(f.verify(), /SHA-512 mismatch.*arm64\.dmg/);
});

test('Linux metadata accepts the combined AppImage and DEB build in either completion order', async (t) => {
  const f = await fixture(t);
  for (const first of [appImage, deb]) {
    await f.editManifest('latest-linux.yml', (info) => {
      info.files.sort((a, b) => Number(b.url === first) - Number(a.url === first));
      info.path = info.files[0].url;
      info.sha512 = info.files[0].sha512;
    });
    const files = (await f.verify()).map((path) => basename(path));
    assert.ok(files.includes(appImage));
    assert.ok(files.includes(deb));
  }
});

test('Linux metadata requires both update formats, validates DEB bytes and rejects unbuilt formats', async (t) => {
  const f = await fixture(t);
  const original = await readFile(join(f.dir, 'latest-linux.yml'));
  for (const missing of [appImage, deb]) {
    await writeFile(join(f.dir, 'latest-linux.yml'), original);
    await f.editManifest('latest-linux.yml', (info) => {
      info.files = info.files.filter((file) => file.url !== missing);
      info.path = info.files[0].url;
      info.sha512 = info.files[0].sha512;
    });
    await assert.rejects(f.verify(), /Required update artifact missing from latest-linux\.yml/);
  }
  await writeFile(join(f.dir, 'latest-linux.yml'), original);
  await f.editManifest('latest-linux.yml', (info) => { info.files[1].url = `Pi-Desktop-${version}-x64.rpm`; });
  await assert.rejects(f.verify(), /Unexpected update artifact.*\.rpm/);
  await writeFile(join(f.dir, 'latest-linux.yml'), original);
  await writeFile(join(f.dir, deb), 'tampered DEB artifact bytes');
  await assert.rejects(f.verify(), /SHA-512 mismatch.*\.deb/);
});

test('NSIS metadata cannot add web installer packages', async (t) => {
  const f = await fixture(t);
  await f.editManifest('latest.yml', (info) => { info.packages = { x64: { path: 'https://example.com/package.7z' } }; });
  await assert.rejects(f.verify(), /Unexpected web installer packages/);
});

test('CLI emits only publish paths and one delimited files output, and emits no output on validation failure', async (t) => {
  const f = await fixture(t);
  const outputPath = join(f.dir, 'github-output.txt');
  const env = { ...process.env, GITHUB_OUTPUT: outputPath };
  await writeFile(outputPath, 'previous=preserved\n');
  const result = spawnSync(process.execPath, [script, f.dir, '--version', version], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.stdout.trim().split('\n'), await f.verify());
  const output = await readFile(outputPath, 'utf8');
  const lines = output.trimEnd().split('\n');
  assert.equal(lines[0], 'previous=preserved');
  const delimiter = lines[1].replace(/^files<</, '');
  assert.match(delimiter, /^release_files_[\da-f-]+$/);
  assert.equal(lines.at(-1), delimiter);
  assert.deepEqual(lines.slice(2, -1), await f.verify());
  await rm(join(f.dir, setup));
  const failed = spawnSync(process.execPath, [script, f.dir, '--version', version], { env, encoding: 'utf8' });
  assert.notEqual(failed.status, 0);
  assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /Missing release artifact/);
  assert.equal(await readFile(outputPath, 'utf8'), output);
});

test('release version must be canonical stable semver and CLI requires explicit arguments', async (t) => {
  const f = await fixture(t);
  for (const value of [undefined, 'v0.2.0', '0.2', '00.2.0', '0.2.0-beta.1', '0.2.0+build', '../0.2.0', '0.2.0\n', ' 0.2.0']) {
    await assert.rejects(verifyReleaseArtifacts(f.dir, { version: value }), /stable version/);
  }
  const result = spawnSync(process.execPath, [script, f.dir], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Usage:/);
});
