import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	LEGACY_QUESTION_AUTO_RESOLUTION_MINUTES,
	QUESTION_AUTO_RESOLUTION_HIDDEN_GRACE_MS,
	QUESTION_AUTO_RESOLUTION_MINUTE_OPTIONS,
	formatQuestionCountdown,
	isQuestionAutoResolutionKind,
	normalizeQuestionAutoResolutionMinutes,
	planQuestionAutoResolution,
} from '../packages/ui/src/extensionQuestionTimeout.ts';
import { normalizeMessageStreamShowReasoning } from '../packages/ui/src/messageStreamShowReasoning.ts';

const FIVE_MINUTES_MS = LEGACY_QUESTION_AUTO_RESOLUTION_MINUTES * 60_000;

test('the auto-resolution timeline follows the zcode grace/countdown/deadline semantics', () => {
	assert.deepEqual(planQuestionAutoResolution(0, FIVE_MINUTES_MS), { state: 'grace' });
	assert.deepEqual(planQuestionAutoResolution(QUESTION_AUTO_RESOLUTION_HIDDEN_GRACE_MS - 1, FIVE_MINUTES_MS), { state: 'grace' });
	const countdown = planQuestionAutoResolution(QUESTION_AUTO_RESOLUTION_HIDDEN_GRACE_MS, FIVE_MINUTES_MS);
	assert.equal(countdown.state, 'countdown');
	assert.equal(countdown.remainingMs, FIVE_MINUTES_MS - QUESTION_AUTO_RESOLUTION_HIDDEN_GRACE_MS);
	const late = planQuestionAutoResolution(FIVE_MINUTES_MS - 1, FIVE_MINUTES_MS);
	assert.equal(late.state, 'countdown');
	assert.equal(late.remainingMs, 1);
	assert.deepEqual(planQuestionAutoResolution(FIVE_MINUTES_MS, FIVE_MINUTES_MS), { state: 'expired' });
	assert.deepEqual(planQuestionAutoResolution(Number.POSITIVE_INFINITY, FIVE_MINUTES_MS), { state: 'expired' });
	assert.deepEqual(planQuestionAutoResolution(Number.NaN, FIVE_MINUTES_MS), { state: 'expired' });
});

test('no deadline (不限) never expires, however long the question waits', () => {
	assert.deepEqual(planQuestionAutoResolution(0, null), { state: 'unlimited' });
	assert.deepEqual(planQuestionAutoResolution(Number.MAX_SAFE_INTEGER, null), { state: 'unlimited' });
	for (const timeoutMs of [undefined, 0, -1, Number.NaN]) assert.deepEqual(planQuestionAutoResolution(Number.MAX_SAFE_INTEGER, timeoutMs), { state: 'unlimited' });
});

test('the countdown label renders m:ss and rounds up to the next second', () => {
	assert.equal(formatQuestionCountdown(4 * 60_000), '4:00');
	assert.equal(formatQuestionCountdown(1500), '0:02');
	assert.equal(formatQuestionCountdown(1000), '0:01');
	assert.equal(formatQuestionCountdown(0), '0:00');
});

test('only blocking question kinds auto-cancel; approvals and notices never do', () => {
	assert.equal(isQuestionAutoResolutionKind('select'), true);
	assert.equal(isQuestionAutoResolutionKind('input'), true);
	assert.equal(isQuestionAutoResolutionKind('editor'), true);
	assert.equal(isQuestionAutoResolutionKind('confirm'), false);
	assert.equal(isQuestionAutoResolutionKind('notify'), false);
});

test('the question deadline defaults to 不限 and every option is a positive minute count', () => {
	assert.deepEqual([...QUESTION_AUTO_RESOLUTION_MINUTE_OPTIONS], [0, 1, 3, 5, 10, 30]);
	assert.equal(QUESTION_AUTO_RESOLUTION_MINUTE_OPTIONS[0], 0);
	assert.deepEqual([...QUESTION_AUTO_RESOLUTION_MINUTE_OPTIONS].slice(1).toSorted((left, right) => left - right), [1, 3, 5, 10, 30]);
});

test('the timeout preference defaults to no limit and migrates the legacy switch', () => {
	// Missing or disabled states all mean 不限, which is the new default.
	assert.equal(normalizeQuestionAutoResolutionMinutes(undefined), 0);
	assert.equal(normalizeQuestionAutoResolutionMinutes(null), 0);
	assert.equal(normalizeQuestionAutoResolutionMinutes(false), 0);
	assert.equal(normalizeQuestionAutoResolutionMinutes(0), 0);
	// An explicitly enabled switch keeps its old 5-minute behavior.
	assert.equal(normalizeQuestionAutoResolutionMinutes(true), LEGACY_QUESTION_AUTO_RESOLUTION_MINUTES);
	assert.equal(normalizeQuestionAutoResolutionMinutes(1), 1);
	assert.equal(normalizeQuestionAutoResolutionMinutes(5), 5);
	// Fractional deadlines never round down into an instant cancel.
	assert.equal(normalizeQuestionAutoResolutionMinutes(2.5), 3);
	// Unusable values fall back to 不限 instead of cancelling a question early.
	assert.equal(normalizeQuestionAutoResolutionMinutes(-3), 0);
	assert.equal(normalizeQuestionAutoResolutionMinutes('5'), 0);
	assert.equal(normalizeQuestionAutoResolutionMinutes(Number.NaN), 0);
	assert.equal(normalizeQuestionAutoResolutionMinutes(Number.POSITIVE_INFINITY), 0);
	assert.equal(normalizeQuestionAutoResolutionMinutes(10_000), 24 * 60);
});

test('the unrelated reasoning preference still defaults on and only an explicit false disables it', () => {
	assert.equal(normalizeMessageStreamShowReasoning(undefined), true);
	assert.equal(normalizeMessageStreamShowReasoning(null), true);
	assert.equal(normalizeMessageStreamShowReasoning(false), false);
});

test('short deadlines keep a visible countdown: the hidden grace never exceeds half the limit', () => {
	const oneMinute = 60_000;
	assert.deepEqual(planQuestionAutoResolution(29_999, oneMinute), { state: 'grace' });
	assert.deepEqual(planQuestionAutoResolution(30_000, oneMinute), { state: 'countdown', remainingMs: 30_000 });
	assert.deepEqual(planQuestionAutoResolution(oneMinute, oneMinute), { state: 'expired' });
	// Longer limits keep the full 60s grace.
	assert.deepEqual(planQuestionAutoResolution(QUESTION_AUTO_RESOLUTION_HIDDEN_GRACE_MS - 1, 3 * oneMinute), { state: 'grace' });
});
