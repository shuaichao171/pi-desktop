import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import YAML from 'yaml';
import { prepareUpdateConfig } from '../scripts/prepare-update-config.mjs';

const defaultUrl = 'https://github.com/shuaichao171/pi-desktop/releases/latest/download/';
function fixture(t) {
  const base = realpathSync(tmpdir());
  const root = mkdtempSync(join(base, 'pi-update-packaging-'));
  const source = join(root, 'packages', 'desktop', 'build', 'update-config.json');
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, JSON.stringify({ url: defaultUrl }));
  t.after(() => { assert.equal(dirname(resolve(root)), base); rmSync(root, { recursive: true, force: true }); });
  return { root, source };
}

test('packaged client and updater metadata share the configured feed; temporary overrides do not alter tracked defaults', (t) => {
  const { root, source } = fixture(t);
  for (const override of [undefined, '', 'https://updates.example.com/desktop/']) {
    const prepared = prepareUpdateConfig({ root, env: { PI_DESKTOP_UPDATE_URL: override } });
    const expected = override || defaultUrl;
    assert.equal(prepared.url, expected);
    assert.deepEqual(prepared.publish, { provider: 'generic', url: expected });
    assert.deepEqual(JSON.parse(readFileSync(prepared.output, 'utf8')), { url: expected });
    assert.deepEqual(JSON.parse(readFileSync(source, 'utf8')), { url: defaultUrl });
  }
  assert.equal(prepareUpdateConfig({ root, env: {} }).url, defaultUrl);
});

test('invalid feed overrides fail before replacing the last valid generated config', (t) => {
  const { root } = fixture(t);
  const valid = prepareUpdateConfig({ root, env: {} });
  for (const url of ['http://example.com/', 'https://user:password@example.com/', 'https://example.com/?token=secret', 'https://example.com/file', ' ']) {
    assert.throws(() => prepareUpdateConfig({ root, env: { PI_DESKTOP_UPDATE_URL: url } }), /HTTPS directory/);
    assert.equal(JSON.parse(readFileSync(valid.output, 'utf8')).url, defaultUrl);
  }
});

test('default builder feed matches the shipped source configuration and copies generated client settings', () => {
  const config = YAML.parse(readFileSync(new URL('../packages/desktop/electron-builder.yml', import.meta.url), 'utf8'));
  const source = JSON.parse(readFileSync(new URL('../packages/desktop/build/update-config.json', import.meta.url), 'utf8'));
  assert.equal(config.publish.url, source.url);
  assert.equal(config.publish.provider, 'generic');
  assert.deepEqual(config.extraResources.find((entry) => entry.to === 'update-config.json'), { from: 'out/update-config.json', to: 'update-config.json' });
  assert.equal(config.win.verifyUpdateCodeSignature, true, 'signed releases retain publisher verification');
});
