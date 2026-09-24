import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupModelsByProvider, selectModelProvider } from '../packages/ui/src/modelPicker.ts';

const model = (provider, id, name = id) => ({ provider, id, name, reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 8192 });

test('model groups use provider identity and locale order while preserving model order and the input catalog', () => {
  const models = Object.freeze([
    Object.freeze(model('zeta', 'shared', 'Zeta Shared')),
    Object.freeze(model('alpha', 'shared', 'Alpha Shared')),
    Object.freeze(model('zeta', 'first', 'Zeta First')),
  ]);
  const groups = groupModelsByProvider(models, '', 'en-US');
  assert.deepEqual(groups.map((group) => group.provider), ['alpha', 'zeta']);
  assert.deepEqual(groups[0].models, [models[1]]);
  assert.deepEqual(groups[1].models, [models[0], models[2]], 'models must retain catalog order within their provider');
  assert.notEqual(groups[0].models[0], groups[1].models[0], 'identical ids across providers remain distinct models');
  assert.deepEqual(groupModelsByProvider([model('z', 'one'), model('ä', 'two')], '', 'sv-SE').map((group) => group.provider), ['z', 'ä']);
  assert.deepEqual(models.map((entry) => entry.provider), ['zeta', 'alpha', 'zeta']);
});

test('providers and matching models beyond the first 80 catalog entries remain available', () => {
  const models = [...Array.from({ length: 100 }, (_, index) => model('alpha', `model-${index}`)), model('zeta', 'last-model')];
  const groups = groupModelsByProvider(models, '', 'en-US');
  assert.deepEqual(groups.map((group) => group.provider), ['alpha', 'zeta']);
  assert.equal(groups[0].models.length, 100);
  assert.equal(groups[1].models[0].id, 'last-model');
  assert.equal(groupModelsByProvider(models, 'MODEL-99', 'en-US')[0].models[0].id, 'model-99');
});

test('model search matches provider, model id and display name without case sensitivity', () => {
  const models = [model('OpenAI', 'reasoning-id', 'Friendly Reasoner'), model('Anthropic', 'chat-id', '中文助手')];
  for (const query of [' openai ', 'REASONING-ID', 'fRiEnDlY']) {
    assert.deepEqual(groupModelsByProvider(models, query, 'en-US'), [{ provider: 'OpenAI', models: [models[0]] }]);
  }
  assert.deepEqual(groupModelsByProvider(models, '中文', 'zh-CN'), [{ provider: 'Anthropic', models: [models[1]] }]);
  assert.deepEqual(groupModelsByProvider(models, 'not-present', 'en-US'), []);
  assert.equal(groupModelsByProvider(models, '   ', 'en-US').length, 2);
});

test('provider selection prefers the requested tab, then current provider, then first search result', () => {
  const models = [model('OpenAI', 'one'), model('Anthropic', 'two')];
  const all = groupModelsByProvider(models, '', 'en-US');
  assert.equal(selectModelProvider(all, 'OpenAI', 'Anthropic'), 'OpenAI');
  const filtered = groupModelsByProvider(models, 'anthropic', 'en-US');
  assert.equal(selectModelProvider(filtered, 'OpenAI', 'Anthropic'), 'Anthropic');
  assert.equal(selectModelProvider(all, 'OpenAI', 'Anthropic'), 'OpenAI', 'clearing search can restore a still-requested provider');
  assert.equal(selectModelProvider(all, null, 'OpenAI'), 'OpenAI');
  assert.equal(selectModelProvider(all, 'missing', 'missing'), 'Anthropic');
  assert.equal(selectModelProvider([], 'OpenAI', 'Anthropic'), null);
  assert.deepEqual(groupModelsByProvider([], '', 'en-US'), []);
});
