import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPluginCatalogCache } from '../packages/ui/src/pluginCatalogCache.ts';

const catalog = (name) => ({ cwd: name, packages: [{ name, source: `npm:${name}` }], resources: [], warnings: [], projectTrusted: true });

test('插件目录缓存按工作区读写、失效与最近使用淘汰', () => {
  const cache = createPluginCatalogCache(2);
  assert.equal(cache.read('C:/a'), null, '未写入门径返回空');

  cache.write('C:/a', catalog('a'));
  cache.write('C:/b', catalog('b'));
  assert.equal(cache.read('C:/a').cwd, 'a');
  assert.equal(cache.read('C:/b').cwd, 'b');

  // 超出容量的最旧条目被淘汰；重写视为最新使用。
  cache.write('C:/a', catalog('a2'));
  cache.write('C:/c', catalog('c'));
  assert.equal(cache.read('C:/b'), null, '最久未使用的工作区被淘汰');
  assert.equal(cache.read('C:/a').cwd, 'a2');
  assert.equal(cache.read('C:/c').cwd, 'c');

  cache.invalidate('C:/a');
  assert.equal(cache.read('C:/a'), null);
  assert.equal(cache.read('C:/c').cwd, 'c', '失效只影响指定工作区');
  cache.invalidate();
  assert.equal(cache.read('C:/c'), null, '无参失效清空全部');
});

test('不同工作区目录互不串扰', () => {
  const cache = createPluginCatalogCache();
  cache.write('C:/a', catalog('a'));
  cache.write('C:/b', catalog('b'));
  assert.equal(cache.read('C:/a').packages[0].name, 'a');
  assert.equal(cache.read('C:/b').packages[0].name, 'b');
});
