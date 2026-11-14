// Pending inputs have a single composer presentation until consumed by the session.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildQueueRows } from '../packages/ui/src/queuePresentation.ts';

const item = (id, behavior = 'followUp', extra = {}) => ({ id, text: `text ${id}`, behavior, ...extra });
const queue = (items, paused = false) => ({ version: 3, paused, items: items.map((row) => ({ version: 1, ...row })) });

test('follow-ups expose send-now and cancel in their queue row', () => {
	const [bubble] = buildQueueRows([item('a')], queue([{ ...item('a'), state: 'accepted' }]));
	assert.equal(bubble.status, 'queued');
	assert.equal(bubble.canSendNow, true);
	assert.equal(bubble.canCancel, true);
	assert.equal(bubble.canConfirm, false);
});

test('steering inputs are already being delivered, so only cancel remains', () => {
	const [bubble] = buildQueueRows([item('a', 'steer')], queue([{ ...item('a', 'steer'), state: 'accepted' }]));
	assert.equal(bubble.status, 'steering');
	assert.equal(bubble.canSendNow, false);
	assert.equal(bubble.canCancel, true);
});

test('paused, editing and recovered states each present distinctly', () => {
	const bubbles = buildQueueRows([item('p'), item('e'), item('r')], queue([
		{ ...item('p'), state: 'accepted' }, { ...item('e'), state: 'editing' }, { ...item('r'), state: 'recovered' },
	], true));
	assert.deepEqual(bubbles.map((bubble) => bubble.status), ['paused', 'editing', 'recovered']);
	// A paused follow-up can still be pushed through immediately.
	assert.equal(bubbles[0].canSendNow, true);
	// The composer editor holds an editing entry; actions wait for save/cancel there.
	assert.equal(bubbles[1].canCancel, false);
	assert.equal(bubbles[1].canSendNow, false);
	assert.equal(bubbles[2].canConfirm, true);
	assert.equal(bubbles[2].canSendNow, false);
});

test('state falls back to the queue event payload before the controller snapshot arrives', () => {
	const [bubble] = buildQueueRows([item('r', 'followUp', { state: 'recovered' })], null);
	assert.equal(bubble.status, 'recovered');
});

test('consumed inputs no longer have a pending row', () => {
	assert.deepEqual(buildQueueRows([], queue([])), []);
});

test('previews normalize whitespace while full message content and attachments stay intact', () => {
	const attachment = { name: 'notes.md', kind: 'text', mimeType: 'text/markdown' };
	const original = item('a', 'followUp', { text: '  first line\n\n second\tline  ', attachments: [attachment] });
	const [row] = buildQueueRows([original], null);
	assert.equal(row.preview, 'first line second line');
	assert.equal(row.text, original.text);
	assert.deepEqual(row.attachments, [attachment]);
});

test('an authoritative editing hold overrides a stale accepted event', () => {
	const [row] = buildQueueRows([item('a', 'followUp', { state: 'accepted' })], queue([{ ...item('a'), state: 'editing' }]));
	assert.equal(row.status, 'editing');
	assert.equal(row.canSendNow, false);
	assert.equal(row.canCancel, false);
});
