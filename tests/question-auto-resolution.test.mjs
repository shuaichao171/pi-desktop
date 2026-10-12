import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	QUESTION_AUTO_RESOLUTION_HIDDEN_GRACE_MS,
	QUESTION_AUTO_RESOLUTION_MS,
	formatQuestionCountdown,
	isQuestionAutoResolutionKind,
	normalizeQuestionAutoResolution,
	planQuestionAutoResolution,
} from '../packages/ui/src/extensionQuestionTimeout.ts';
import { normalizeMessageStreamShowReasoning } from '../packages/ui/src/messageStreamShowReasoning.ts';

test('the auto-resolution timeline follows the zcode grace/countdown/deadline semantics', () => {
	assert.deepEqual(planQuestionAutoResolution(0), { state: 'grace' });
	assert.deepEqual(planQuestionAutoResolution(QUESTION_AUTO_RESOLUTION_HIDDEN_GRACE_MS - 1), { state: 'grace' });
	const countdown = planQuestionAutoResolution(QUESTION_AUTO_RESOLUTION_HIDDEN_GRACE_MS);
	assert.equal(countdown.state, 'countdown');
	assert.equal(countdown.remainingMs, QUESTION_AUTO_RESOLUTION_MS - QUESTION_AUTO_RESOLUTION_HIDDEN_GRACE_MS);
	const late = planQuestionAutoResolution(QUESTION_AUTO_RESOLUTION_MS - 1);
	assert.equal(late.state, 'countdown');
	assert.equal(late.remainingMs, 1);
	assert.deepEqual(planQuestionAutoResolution(QUESTION_AUTO_RESOLUTION_MS), { state: 'expired' });
	assert.deepEqual(planQuestionAutoResolution(Number.POSITIVE_INFINITY), { state: 'expired' });
	assert.deepEqual(planQuestionAutoResolution(Number.NaN), { state: 'expired' });
});

test('the countdown label renders m:ss and rounds up to the next second', () => {
	assert.equal(formatQuestionCountdown(QUESTION_AUTO_RESOLUTION_MS - QUESTION_AUTO_RESOLUTION_HIDDEN_GRACE_MS), '4:00');
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

test('both renderer preferences default on and only an explicit false disables them', () => {
	assert.equal(normalizeQuestionAutoResolution(undefined), true);
	assert.equal(normalizeQuestionAutoResolution(null), true);
	assert.equal(normalizeQuestionAutoResolution(false), false);
	assert.equal(normalizeMessageStreamShowReasoning(undefined), true);
	assert.equal(normalizeMessageStreamShowReasoning(null), true);
	assert.equal(normalizeMessageStreamShowReasoning(false), false);
});
