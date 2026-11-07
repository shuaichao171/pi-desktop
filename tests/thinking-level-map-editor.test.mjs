import assert from 'node:assert/strict';
import { test } from 'node:test';

import { advertisedThinkingMap, supportedThinkingLevels, toggleThinkingLevel } from '../packages/ui/src/thinkingLevelMapEditor.ts';

test('advertisedThinkingMap：off 支持时不写线上值（缺省条目），绝不产生 none', () => {
	const map = advertisedThinkingMap(['off', 'low', 'high']);
	// off 支持 = 缺省条目：openai-completions 适配器对缺失的 off 映射不下发 reasoning_effort
	// （openai-responses 系适配器仍会兑底 'none'，见模块注释）
	assert.equal(map.off, undefined);
	assert.equal('off' in map, false);
	assert.equal(map.low, 'low');
	assert.equal(map.high, 'high');
	assert.equal(map.minimal, null);
	assert.equal(map.medium, null);
	assert.equal(map.xhigh, null);
	assert.equal(map.max, null);
	assert.equal(Object.values(map).includes('none'), false);
});

test('supportedThinkingLevels：镜像 pi-ai 语义（null 不支持；缺省 off…high 支持；xhigh/max 需显式值）', () => {
	assert.deepEqual(supportedThinkingLevels(undefined, ['off', 'low']), ['off', 'low']);
	assert.deepEqual(supportedThinkingLevels(undefined), []);
	const map = { off: undefined, low: 'low', high: null, xhigh: 'xhigh' };
	assert.deepEqual(supportedThinkingLevels(map), ['off', 'minimal', 'low', 'medium', 'xhigh']);
});

test('勾选 off 生成缺省条目：序列化后不含 off 键、不含 none', () => {
	const next = toggleThinkingLevel({ low: 'low' }, 'off', true, ['low', 'off']);
	assert.equal(next.off, undefined);
	assert.equal(next.low, 'low');
	const json = JSON.stringify(next);
	assert.equal(json.includes('none'), false);
	assert.equal(/"off"/.test(json), false);
});

test('重建映射时丢弃遗留的非法 off 线上值 none/disabled，保留其他档位线上值', () => {
	const next = toggleThinkingLevel({ off: 'none', low: 'low' }, 'high', true, ['off', 'low', 'high']);
	assert.equal(next.off, undefined);
	assert.equal(next.low, 'low');
	assert.equal(next.high, 'high');
	const disabled = toggleThinkingLevel({ off: 'disabled' }, 'low', true, ['off', 'low']);
	assert.equal(disabled.off, undefined);
	assert.equal(disabled.low, 'low');
});

test('取消勾选 off 时显式标记为不支持（null）', () => {
	const next = toggleThinkingLevel({ off: 'low', low: 'low' }, 'off', false, ['off', 'low']);
	assert.equal(next.off, null);
});
