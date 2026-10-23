import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionTimeLabel } from '../packages/ui/src/sessionTime.ts';
import { providerHue, providerInitial } from '../packages/ui/src/providerMark.ts';

const now = Date.parse('2026-10-23T12:00:00Z');
const ago = (ms) => new Date(now - ms).toISOString();

test('session rows show compact recency buckets in both locales', () => {
  assert.equal(sessionTimeLabel(ago(20_000), now, 'zh-CN'), '刚刚');
  assert.equal(sessionTimeLabel(ago(5 * 60_000), now, 'zh-CN'), '5分钟');
  assert.equal(sessionTimeLabel(ago(3 * 3_600_000), now, 'en-US'), '3h');
  assert.equal(sessionTimeLabel(ago(2 * 86_400_000), now, 'en-US'), '2d');
  // Clock skew never produces negative ages.
  assert.equal(sessionTimeLabel(new Date(now + 60_000).toISOString(), now, 'en-US'), 'now');
});

test('sessions older than a week carry no recency label', () => {
  assert.equal(sessionTimeLabel(ago(6 * 86_400_000), now, 'zh-CN'), '6天');
  assert.equal(sessionTimeLabel(ago(7 * 86_400_000), now, 'zh-CN'), '');
  assert.equal(sessionTimeLabel('2025-03-05T12:00:00Z', now, 'en-US'), '');
  assert.equal(sessionTimeLabel(undefined, now, 'en-US'), '');
  assert.equal(sessionTimeLabel('not a date', now, 'en-US'), '');
});

test('provider marks use one meaningful character and a stable hue', () => {
  assert.equal(providerInitial('openai'), 'O');
  assert.equal(providerInitial('  -review-gateway'), 'R');
  assert.equal(providerInitial('团队模型网关'), '团');
  assert.equal(providerInitial('---'), '?');
  assert.equal(providerHue('anthropic'), providerHue('Anthropic'));
  assert.equal(providerHue('custom-gateway'), providerHue('custom-gateway'));
  // Whole id segments only: "spark" is not Volcengine Ark, while "gpt-review" is OpenAI.
  assert.notEqual(providerHue('spark-gateway'), providerHue('ark'));
  assert.equal(providerHue('gpt-review'), providerHue('openai'));
  assert.match(providerHue('anything'), /^#[0-9a-f]{6}$/);
});

test('dates share one format: year only when it differs, 24-hour times', async () => {
  const { formatDate } = await import('../packages/ui/src/dateFormat.ts');
  assert.equal(formatDate('2026-10-09T08:30:00Z', 'zh-CN', { now }), '10月9日');
  assert.equal(formatDate('2025-03-05T08:30:00Z', 'zh-CN', { now }), '2025年3月5日');
  assert.equal(formatDate('2026-10-09T08:30:00Z', 'en-US', { now }), 'Oct 9');
  assert.equal(formatDate('2026-10-09T16:30:00Z', 'en-US', { now, time: true, timeZone: 'UTC' }), 'Oct 9, 16:30');
  assert.equal(formatDate('2026-10-09T16:30:00Z', 'zh-CN', { now, time: true, timeZone: 'UTC', year: 'always' }), '2026年10月9日 16:30');
  assert.equal(formatDate('not a date', 'en-US'), '');
  assert.equal(formatDate(null, 'en-US'), '');
  // An unknown zone keeps the date visible in local time instead of failing.
  assert.notEqual(formatDate('2026-10-09T16:30:00Z', 'en-US', { now, timeZone: 'Not/AZone' }), '');
});
