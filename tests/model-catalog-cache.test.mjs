import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODEL_CATALOG_CACHE_MAX_CHARS, readModelCatalogCache, writeModelCatalogCache } from '../packages/ui/src/modelCatalogCache.ts';

function memoryStorage(initial = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => { items.set(key, String(value)); },
    removeItem: (key) => { items.delete(key); },
  };
}

const model = (id, provider = 'openai') => ({
  provider, id, name: id.toUpperCase(), reasoning: true, input: ['text', 'image'],
  contextWindow: 200_000, maxTokens: 32_000, thinkingLevels: ['off', 'low', 'high'], thinkingLevelMap: { off: null },
});
const provider = (id, models) => ({
  provider: id, name: id, custom: false, editable: false, configured: true, baseUrl: null, api: 'openai-completions', models,
});

test('an empty or missing store yields an empty catalog', () => {
  assert.deepEqual(readModelCatalogCache(memoryStorage()), { models: [], modelProviders: [] });
  assert.deepEqual(readModelCatalogCache(null), { models: [], modelProviders: [] });
});

test('a written catalog round-trips and each half updates independently', () => {
  const storage = memoryStorage();
  const models = [model('gpt-a'), model('gpt-b')];
  writeModelCatalogCache({ models }, storage);
  assert.deepEqual(readModelCatalogCache(storage), { models, modelProviders: [] });
  const modelProviders = [provider('openai', models)];
  writeModelCatalogCache({ modelProviders }, storage);
  assert.deepEqual(readModelCatalogCache(storage), { models, modelProviders }, 'providers added without dropping models');
});

test('an empty response never wipes the last usable catalog', () => {
  const storage = memoryStorage();
  const models = [model('gpt-a')];
  writeModelCatalogCache({ models }, storage);
  writeModelCatalogCache({ models: [], modelProviders: [] }, storage);
  assert.deepEqual(readModelCatalogCache(storage).models, models, 'a host without a runtime session answers [] — not a real empty catalog');
});

test('corrupt or mis-shaped data is discarded per half', () => {
  assert.deepEqual(readModelCatalogCache(memoryStorage({ 'pi-desktop.model-catalog.v1': '{' })), { models: [], modelProviders: [] });
  const storage = memoryStorage({ 'pi-desktop.model-catalog.v1': JSON.stringify({
    models: [model('ok'), { provider: 'x', id: 1 }],
    modelProviders: [provider('openai', [model('ok')])],
  }) });
  assert.deepEqual(readModelCatalogCache(storage), { models: [], modelProviders: [provider('openai', [model('ok')])] }, 'one bad model drops the models half only');
  const badProviderModels = memoryStorage({ 'pi-desktop.model-catalog.v1': JSON.stringify({ models: [], modelProviders: [provider('openai', [{ id: 'nope' }])] }) });
  assert.deepEqual(readModelCatalogCache(badProviderModels).modelProviders, []);
});

test('oversized catalogs are not persisted and clear the stale copy', () => {
  const storage = memoryStorage();
  writeModelCatalogCache({ models: [model('small')] }, storage);
  const huge = Array.from({ length: Math.ceil(MODEL_CATALOG_CACHE_MAX_CHARS / 150) }, (_, index) => model(`m-${index}`));
  writeModelCatalogCache({ models: huge }, storage);
  assert.equal(storage.items.size, 0);
});

test('a throwing storage is tolerated on both read and write', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() {} };
  assert.deepEqual(readModelCatalogCache(broken), { models: [], modelProviders: [] });
  assert.doesNotThrow(() => writeModelCatalogCache({ models: [model('a')] }, broken));
});
