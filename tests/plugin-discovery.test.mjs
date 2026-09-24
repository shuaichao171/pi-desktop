import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPluginDiscovery, parsePluginDiscovery } from '../packages/desktop/src/main/pluginDiscovery.ts';

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
