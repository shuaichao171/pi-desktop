import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPluginDiscovery, parsePluginDiscovery } from '../packages/desktop/src/main/pluginDiscovery.ts';
import { installedNpmPackage, npmPackageName, pluginSourceUrl } from '../packages/ui/src/pluginRecommendations.ts';

const pkg = (overrides = {}) => ({ package: { name: '@demo/pi-review', version: '1.2.3', keywords: ['pi-package'], description: 'Review code', publisher: { username: 'demo', email: 'private@example.test' }, ...overrides } });
test('plugin discovery accepts actual Pi packages and pins safe versions without copying arbitrary URLs or emails', () => {
  const value = parsePluginDiscovery({ objects: [pkg(), pkg(), pkg({ name: '--eval' }), pkg({ name: 'irrelevant', keywords: [] }), pkg({ name: 'inject', version: '1.0.0; execute' }), pkg({ name: 'valid', version: '2.0.0-beta.1', description: 'one\ntwo', links: { homepage: 'javascript:bad' } })], total: 6 });
  assert.deepEqual(value.items.map((item) => item.source), ['npm:@demo/pi-review@1.2.3', 'npm:valid@2.0.0-beta.1']);
  assert.equal(value.items[1].description, 'one two');
  assert.equal(value.items[0].author, 'demo');
  assert.doesNotMatch(JSON.stringify(value), /private@|javascript/);
});

test('discovery validates queries, uses a fixed registry and caches independent result copies', async () => {
  const calls = [];
  let clock = 0;
  const discover = createPluginDiscovery(async (url, options) => {
    calls.push([url, options]);
    return Response.json({ objects: [pkg()], total: 1 });
  }, () => clock);
  const first = await discover(' review ');
  first.items.length = 0;
  assert.equal((await discover('review')).items.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].origin, 'https://registry.npmjs.org');
  assert.equal(calls[0][0].searchParams.get('text'), 'keywords:pi-package review');
  assert.equal(calls[0][1].redirect, 'error');
  await assert.rejects(discover('x'.repeat(121)), /无效/);
  await assert.rejects(discover('query\n'), /无效/);
  clock = 61_000;
  await discover('review');
  assert.equal(calls.length, 2);
});

test('network errors, invalid data and oversized metadata fail without poisoning the cache', async () => {
  for (const response of [new Response('', { status: 503 }), Response.json({ invalid: true }), new Response('not json'), new Response('x'.repeat(2 * 1024 * 1024 + 1))]) {
    const discover = createPluginDiscovery(async () => response);
    await assert.rejects(discover(''));
  }
});

test('installedNpmPackage matches installed npm packages regardless of version and never conflates non-npm sources', () => {
  const packages = [
    { source: 'npm:pi-subagents@0.70.0', scope: 'user', name: 'pi-subagents', description: '', version: '0.70.0', installed: true, path: '/a' },
    { source: 'npm:@ff-labs/pi-fff', scope: 'project', name: '@ff-labs/pi-fff', description: '', version: '0.11.0', installed: true, path: '/b' },
    { source: 'npm:missing-pkg@1.0.0', scope: 'user', name: 'missing-pkg', description: '', version: null, installed: false, path: null },
    { source: 'https://github.com/example/local-plugin', scope: 'user', name: 'local-plugin', description: '', version: '1.0.0', installed: true, path: '/c' },
  ];
  assert.equal(npmPackageName('npm:@ff-labs/pi-fff@1.2.3'), '@ff-labs/pi-fff');
  assert.equal(npmPackageName('https://github.com/example/local-plugin'), null);
  assert.equal(installedNpmPackage(packages, 'npm:pi-subagents@0.75.0')?.source, 'npm:pi-subagents@0.70.0');
  assert.equal(installedNpmPackage(packages, 'npm:@ff-labs/pi-fff@0.12.0')?.source, 'npm:@ff-labs/pi-fff');
  assert.equal(installedNpmPackage(packages, 'npm:missing-pkg@1.0.0'), undefined);
  assert.equal(installedNpmPackage(packages, 'https://github.com/example/other'), undefined);
});

test('pluginSourceUrl builds safe external links for npm and HTTPS Git sources only', () => {
  assert.equal(pluginSourceUrl('npm:pi-web-access'), 'https://www.npmjs.com/package/pi-web-access');
  assert.equal(pluginSourceUrl('npm:pi-subagents@0.75.0'), 'https://www.npmjs.com/package/pi-subagents');
  assert.equal(pluginSourceUrl('npm:@ff-labs/pi-fff@0.11.0'), 'https://www.npmjs.com/package/@ff-labs/pi-fff');
  assert.equal(pluginSourceUrl('https://github.com/owner/repo.git@v1.0.0'), 'https://github.com/owner/repo');
  assert.equal(pluginSourceUrl('git:https://github.com/owner/repo@main'), 'https://github.com/owner/repo');
  assert.equal(pluginSourceUrl('https://user:pass@github.com/owner/repo'), null);
  assert.equal(pluginSourceUrl('http://github.com/owner/repo'), null);
  assert.equal(pluginSourceUrl('C:\\plugins\\local'), null);
  assert.equal(pluginSourceUrl('javascript:alert(1)'), null);
});
