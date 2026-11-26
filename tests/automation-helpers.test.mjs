import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatRunDuration, splitIntervalMinutes, supportedTimeZones, toIntervalMinutes } from '../packages/ui/src/automationHelpers.ts';

test('splitIntervalMinutes chooses the coarsest exact unit (days, hours, minutes)', () => {
	assert.deepEqual(splitIntervalMinutes(5), { value: 5, unit: 'minutes' });
	assert.deepEqual(splitIntervalMinutes(90), { value: 90, unit: 'minutes' });
	assert.deepEqual(splitIntervalMinutes(60), { value: 1, unit: 'hours' });
	assert.deepEqual(splitIntervalMinutes(720), { value: 12, unit: 'hours' });
	assert.deepEqual(splitIntervalMinutes(1440), { value: 1, unit: 'days' });
	assert.deepEqual(splitIntervalMinutes(4320), { value: 3, unit: 'days' });
});

test('toIntervalMinutes converts units and enforces 5..43200 integer minutes', () => {
	assert.equal(toIntervalMinutes('5', 'minutes'), 5);
	assert.equal(toIntervalMinutes('4', 'minutes'), null);
	assert.equal(toIntervalMinutes('1', 'hours'), 60);
	assert.equal(toIntervalMinutes('720', 'hours'), 43_200);
	assert.equal(toIntervalMinutes('721', 'hours'), null);
	assert.equal(toIntervalMinutes('30', 'days'), 43_200);
	assert.equal(toIntervalMinutes('31', 'days'), null);
	assert.equal(toIntervalMinutes('1.5', 'hours'), null);
	assert.equal(toIntervalMinutes('', 'minutes'), null);
	assert.equal(toIntervalMinutes('-5', 'minutes'), null);
});

test('formatRunDuration formats Chinese and English durations cleanly', () => {
	const base = '2026-09-26T01:00:00.000Z';
	assert.equal(formatRunDuration(base, null, 'zh-CN'), null);
	assert.equal(formatRunDuration(base, '2026-09-26T00:59:59.000Z', 'zh-CN'), null);
	assert.equal(formatRunDuration(base, '2026-09-26T01:00:00.300Z', 'zh-CN'), '<1 秒');
	assert.equal(formatRunDuration(base, '2026-09-26T01:00:00.300Z', 'en-US'), '<1s');
	assert.equal(formatRunDuration(base, '2026-09-26T01:00:42.000Z', 'zh-CN'), '42 秒');
	assert.equal(formatRunDuration(base, '2026-09-26T01:01:00.000Z', 'zh-CN'), '1 分钟');
	assert.equal(formatRunDuration(base, '2026-09-26T01:02:15.000Z', 'zh-CN'), '2 分 15 秒');
	assert.equal(formatRunDuration(base, '2026-09-26T01:02:15.000Z', 'en-US'), '2m 15s');
	assert.equal(formatRunDuration(base, '2026-09-26T02:05:00.000Z', 'zh-CN'), '1 小时 5 分');
	assert.equal(formatRunDuration(base, '2026-09-26T03:00:00.000Z', 'en-US'), '2h');
});

test('supportedTimeZones returns a non-empty list containing standard zones', () => {
	const zones = supportedTimeZones();
	assert.ok(zones.length > 0);
	assert.ok(zones.includes('Asia/Shanghai'));
});
