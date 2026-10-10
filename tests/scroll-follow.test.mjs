import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveFollowsBottom } from '../packages/ui/src/scrollFollow.ts';

test('transient layout shift without movement keeps following the bottom', () => {
	// Sending a message grows the composer, shrinking the transcript viewport;
	// the offset jumps past the threshold while scrollTop stays put.
	assert.equal(resolveFollowsBottom(true, false, 1972, 1972), true);
});

test('a real upward scroll breaks bottom-following', () => {
	assert.equal(resolveFollowsBottom(true, false, 824, 924), false);
	// Sub-pixel jitter is not an upward scroll.
	assert.equal(resolveFollowsBottom(true, false, 923.7, 924), true);
});

test('arriving near the bottom re-arms following after reading above', () => {
	assert.equal(resolveFollowsBottom(false, true, 1972, 1872), true);
});

test('scrolling down while still away from the bottom keeps the reading position', () => {
	assert.equal(resolveFollowsBottom(false, false, 500, 400), false);
});

test('streaming growth under a parked reader never resumes following by itself', () => {
	// Content grows below the fold: offset increases, scrollTop unchanged.
	assert.equal(resolveFollowsBottom(false, false, 1163, 1163), false);
});
