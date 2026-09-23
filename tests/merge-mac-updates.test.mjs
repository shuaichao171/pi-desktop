import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import YAML from 'yaml';

const script = resolve('.github/scripts/merge-mac-updates.mjs');

function makeManifest(dir, arch, alteredHash = false) {
  const files = ['zip', 'dmg'].map((extension) => {
    const url = `Pi-Desktop-0.1.0-${arch}.${extension}`;
    const content = `${arch}-${extension}`;
    writeFileSync(join(dir, url), content);
    const sha512 = createHash('sha512').update(content).digest('base64');
    return { url, sha512: alteredHash ? 'invalid' : sha512, size: content.length };
  });
  writeFileSync(join(dir, `latest-mac-${arch}.yml`), YAML.stringify({
    version: '0.1.0',
    files,
    path: files[0].url,
    sha512: files[0].sha512,
  }));
}

test('macOS release metadata merges both native builds and verifies artifact hashes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-desktop-mac-update-test-'));
  try {
    makeManifest(dir, 'x64');
    makeManifest(dir, 'arm64');
    const result = spawnSync(process.execPath, [script, dir], {
      env: { ...process.env, GITHUB_REF_NAME: 'v0.1.0' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const merged = YAML.parse(readFileSync(join(dir, 'latest-mac.yml'), 'utf8'));
    assert.equal(merged.files.length, 4);
    assert.deepEqual(new Set(merged.files.map((file) => file.url)), new Set([
      'Pi-Desktop-0.1.0-x64.zip',
      'Pi-Desktop-0.1.0-x64.dmg',
      'Pi-Desktop-0.1.0-arm64.zip',
      'Pi-Desktop-0.1.0-arm64.dmg',
    ]));
    assert.equal(merged.path, 'Pi-Desktop-0.1.0-x64.zip');
    assert.equal(existsSync(join(dir, 'latest-mac-x64.yml')), false);
    assert.equal(existsSync(join(dir, 'latest-mac-arm64.yml')), false);
  } finally {
    const absolute = resolve(dir);
    if (absolute.startsWith(`${resolve(tmpdir())}${sep}`)) rmSync(absolute, { recursive: true, force: true });
  }
});

test('macOS release metadata rejects an artifact whose bytes do not match its hash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-desktop-mac-update-test-'));
  try {
    makeManifest(dir, 'x64');
    makeManifest(dir, 'arm64', true);
    const result = spawnSync(process.execPath, [script, dir], {
      env: { ...process.env, GITHUB_REF_NAME: 'v0.1.0' },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(dir, 'latest-mac.yml')), false);
  } finally {
    const absolute = resolve(dir);
    if (absolute.startsWith(`${resolve(tmpdir())}${sep}`)) rmSync(absolute, { recursive: true, force: true });
  }
});
