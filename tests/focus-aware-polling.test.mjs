// B6 未聚焦降频轮询：纯逻辑（聚焦双档间隔 + 空闲截止）+ 应用点约定。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { FOCUS_AWARE_POLL_DEFAULTS, focusAwarePollDelayMs } from '../packages/ui/src/focusAwarePolling.ts';

test('focused windows poll at the base interval', () => {
	assert.equal(focusAwarePollDelayMs(60_000, { focused: true, unfocusedMs: 0 }), 60_000);
	assert.equal(focusAwarePollDelayMs(1_000, { focused: true, unfocusedMs: 999_999 }), 1_000, 'focus ignores idle time');
});

test('unfocused windows stretch the interval by the multiplier', () => {
	assert.equal(focusAwarePollDelayMs(60_000, { focused: false, unfocusedMs: 1_000 }), 180_000);
	assert.equal(focusAwarePollDelayMs(60_000, { focused: false, unfocusedMs: 1_000 }, { unfocusedMultiplier: 5 }), 300_000);
	assert.equal(focusAwarePollDelayMs(60_000, { focused: false, unfocusedMs: 1_000 }, { unfocusedMultiplier: 0.5 }), 60_000, 'multipliers below one clamp to the base interval');
});

test('a non-finite multiplier falls back to the default instead of scheduling immediately', () => {
	// Math.max(1, NaN) = NaN 会让 setTimeout 立即触发；非有限倍率按默认值处理。
	assert.equal(focusAwarePollDelayMs(60_000, { focused: false, unfocusedMs: 1_000 }, { unfocusedMultiplier: Number.NaN }), 180_000);
	assert.equal(focusAwarePollDelayMs(60_000, { focused: false, unfocusedMs: 1_000 }, { unfocusedMultiplier: Number.POSITIVE_INFINITY }), 180_000);
});

test('sustained unfocused time pauses the poll at the idle cutoff', () => {
	const justBefore = FOCUS_AWARE_POLL_DEFAULTS.idleCutoffMs - 1;
	assert.equal(focusAwarePollDelayMs(60_000, { focused: false, unfocusedMs: justBefore }), 180_000);
	assert.equal(focusAwarePollDelayMs(60_000, { focused: false, unfocusedMs: FOCUS_AWARE_POLL_DEFAULTS.idleCutoffMs }), null, 'null pauses: no timer is scheduled');
	assert.equal(focusAwarePollDelayMs(60_000, { focused: false, unfocusedMs: Number.MAX_SAFE_INTEGER }, { idleCutoffMs: null }), 180_000, 'an explicit null cutoff never pauses');
	assert.equal(focusAwarePollDelayMs(60_000, { focused: false, unfocusedMs: 60_000 }, { idleCutoffMs: 0 }), null, 'a zero cutoff pauses as soon as the window blurs');
});

test('disabled polls never schedule', () => {
	assert.equal(focusAwarePollDelayMs(0, { focused: true, unfocusedMs: 0 }), null);
	assert.equal(focusAwarePollDelayMs(-5, { focused: true, unfocusedMs: 0 }), null);
	assert.equal(focusAwarePollDelayMs(Number.NaN, { focused: false, unfocusedMs: 0 }), null);
});

test('non-critical polls adopt the scheduler; time-sensitive schedulers keep fixed timers', () => {
	const metrics = readFileSync(new URL('../packages/ui/src/components/ConversationMetrics.tsx', import.meta.url), 'utf8');
	assert.ok((metrics.match(/useFocusAwarePoll\(/g) ?? []).length >= 2, 'usage query and session stats both poll focus-aware');
	assert.doesNotMatch(metrics, /setInterval/, 'no raw interval polling remains in the metrics dock');
	const automation = readFileSync(new URL('../packages/desktop/src/main/automationService.ts', import.meta.url), 'utf8');
	assert.doesNotMatch(automation, /focusAwarePolling/, 'the automation scheduler stays time-sensitive');
});

test('useFocusAwarePoll stays at component top level, never inside an effect callback', () => {
	// 结构性防回归（P0-1）：hook 调用行缩进恰好一个 tab = 组件函数体顶层；
	// effect 内调用会更深，React 19.3 下抛 Invalid hook call 并击穿整个对话视图。
	const metrics = readFileSync(new URL('../packages/ui/src/components/ConversationMetrics.tsx', import.meta.url), 'utf8');
	const callLines = metrics.split('\n').filter((line) => line.includes('useFocusAwarePoll('));
	assert.ok(callLines.length >= 2, 'both call sites remain present');
	for (const line of callLines) {
		assert.match(line, /^\tuseFocusAwarePoll\(/, 'hook calls sit at exactly one tab of indentation (component top level)');
	}
});
