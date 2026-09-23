import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ESBUILD_PACKAGES,
  PI_PACKAGE,
  PI_PACKAGES,
  assertStableVersion,
  compareStableVersions,
  updateSources,
  verifySources,
} from '../scripts/sync-pi.mjs';

function fixture(version = '0.87.1', esbuildVersion = '0.28.2') {
  const manifest = (group, extra = {}) => JSON.stringify({
    name: 'unrelated-value',
    [group]: { [PI_PACKAGE]: version, another: '1.2.3' },
    ...extra,
  }, null, 2) + '\n';
  const manifests = {
    root: manifest('devDependencies'),
    agent: manifest('dependencies'),
    desktop: manifest('dependencies', {
      optionalDependencies: Object.fromEntries(ESBUILD_PACKAGES.map((name) => [name, esbuildVersion])),
    }),
  };
  const workspace = `packages:\n  - 'packages/*'\nminimumReleaseAgeExclude:\n${PI_PACKAGES.map((name) => `  - '${name}@${version}'`).join('\n')}\n  - electron@44.4.5\n`;
  const lockfile = `lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      '${PI_PACKAGE}':\n        specifier: ${version}\n        version: ${version}(ws@8.21.3)\n  packages/agent:\n    dependencies:\n      '${PI_PACKAGE}':\n        specifier: ${version}\n        version: ${version}(ws@8.21.3)\n  packages/desktop:\n    dependencies:\n      '${PI_PACKAGE}':\n        specifier: ${version}\n        version: ${version}(ws@8.21.3)\npackages:\n  '${PI_PACKAGE}@${version}':\n    resolution: {integrity: sha512-placeholder}\nsnapshots:\n  '${PI_PACKAGE}@${version}(ws@8.21.3)':\n    dependencies:\n      '@earendil-works/chord': ${version}\n  '@earendil-works/chord@${version}':\n    dependencies:\n      esbuild: ${esbuildVersion}\n`;
  return { manifests, workspace, lockfile };
}

test('exact stable versions use SemVer numeric ordering', () => {
  assert.equal(assertStableVersion('0.87.1'), '0.87.1');
  for (const invalid of ['^0.87.1', '0.87.1-beta.1', '0.87.1+meta', '01.2.3', '1.2', 'latest']) {
    assert.throws(() => assertStableVersion(invalid), /exact stable Pi version/);
  }
  assert.equal(compareStableVersions('0.100.0', '0.99.9'), 1);
  assert.equal(compareStableVersions('0.87.1', '0.87.1'), 0);
  assert.equal(compareStableVersions('0.86.9', '0.87.0'), -1);
});

test('verify catches aligned SDK, exclusions, lockfile, and Pi Chord esbuild', () => {
  assert.deepEqual(verifySources(fixture()), { version: '0.87.1', esbuildVersion: '0.28.2' });
});

test('verify rejects ranged or mismatched manifest declarations', () => {
  const ranged = fixture();
  ranged.manifests.root = ranged.manifests.root.replace('0.87.1', '^0.87.1');
  assert.throws(() => verifySources(ranged), /exact stable version/);
  const drifted = fixture();
  drifted.manifests.agent = drifted.manifests.agent.replace('0.87.1', '0.87.2');
  assert.throws(() => verifySources(drifted), /Pi version drift/);
});

test('verify rejects missing, duplicated, or stale exclusions', () => {
  const missing = fixture();
  missing.workspace = missing.workspace.replace(`  - '${PI_PACKAGES[0]}@0.87.1'\n`, '');
  assert.throws(() => verifySources(missing), /exactly one/);
  const duplicate = fixture();
  duplicate.workspace += `  - '${PI_PACKAGES[0]}@0.87.1'\n`;
  assert.throws(() => verifySources(duplicate), /exactly one/);
  const stale = fixture();
  stale.workspace = stale.workspace.replace(`${PI_PACKAGES[0]}@0.87.1`, `${PI_PACKAGES[0]}@0.86.0`);
  assert.throws(() => verifySources(stale), /exactly one/);
});

test('verify rejects stale importer resolutions and missing package snapshots', () => {
  const stale = fixture();
  stale.lockfile = stale.lockfile.replace('version: 0.87.1(ws@8.21.3)', 'version: 0.86.9(ws@8.21.3)');
  assert.throws(() => verifySources(stale), /importer root/);
  const missing = fixture();
  missing.lockfile = missing.lockfile.replace(`  '${PI_PACKAGE}@0.87.1(ws@8.21.3)':`, `  '${PI_PACKAGE}@0.86.9(ws@8.21.3)':`);
  assert.throws(() => verifySources(missing), /missing a snapshot/);
});

test('verify derives esbuild from Pi Chord and rejects missing or stale desktop binaries', () => {
  const stale = fixture();
  stale.manifests.desktop = stale.manifests.desktop.replace('"@esbuild/win32-x64": "0.28.2"', '"@esbuild/win32-x64": "0.28.1"');
  assert.throws(() => verifySources(stale), /must pin @esbuild\/win32-x64/);
  const missing = fixture();
  missing.lockfile = missing.lockfile.replace('esbuild: 0.28.2', 'not-esbuild: 0.28.2');
  assert.throws(() => verifySources(missing), /missing .* esbuild dependency/);
});

test('update changes only Pi declarations and exclusions, leaving lockfile for pnpm', () => {
  const source = fixture();
  const result = updateSources(source, '0.88.0');
  assert.equal(result.changed, true);
  assert.equal(result.oldVersion, '0.87.1');
  assert.equal(result.newVersion, '0.88.0');
  assert.equal(result.sources.lockfile, source.lockfile);
  for (const label of ['root', 'agent', 'desktop']) {
    assert.equal(JSON.parse(result.sources.manifests[label])[label === 'root' ? 'devDependencies' : 'dependencies'][PI_PACKAGE], '0.88.0');
    assert.ok(result.sources.manifests[label].includes('"another": "1.2.3"'));
  }
  assert.ok(result.sources.workspace.includes("  - electron@44.4.5\n"));
  for (const name of PI_PACKAGES) assert.ok(result.sources.workspace.includes(`${name}@0.88.0`));
  assert.deepEqual(updateSources(source, '0.87.1'), {
    changed: false, oldVersion: '0.87.1', newVersion: '0.87.1', sources: source,
  });
});
