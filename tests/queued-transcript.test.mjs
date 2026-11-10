// 会话运行中排队的消息要立刻出现在对话末尾（只在界面合成，不写会话记录），
// 气泡上带「立即发送」（steer）与「取消发送」（remove），被真实轮次消费后随队列消失。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildQueuedBubbles } from '../packages/ui/src/queuedTranscript.ts';

const item = (id, behavior = 'followUp', extra = {}) => ({ id, text: `text ${id}`, behavior, ...extra });
const queue = (items, paused = false) => ({ version: 3, paused, items: items.map((row) => ({ version: 1, ...row })) });

test('follow-ups render as queued bubbles with send-now and cancel', () => {
	const [bubble] = buildQueuedBubbles([item('a')], queue([{ ...item('a'), state: 'accepted' }]));
	assert.equal(bubble.status, 'queued');
	assert.equal(bubble.canSendNow, true);
	assert.equal(bubble.canCancel, true);
	assert.equal(bubble.canConfirm, false);
});

test('steering inputs are already being delivered, so only cancel remains', () => {
	const [bubble] = buildQueuedBubbles([item('a', 'steer')], queue([{ ...item('a', 'steer'), state: 'accepted' }]));
	assert.equal(bubble.status, 'steering');
	assert.equal(bubble.canSendNow, false);
	assert.equal(bubble.canCancel, true);
});

test('paused, editing and recovered states each present distinctly', () => {
	const bubbles = buildQueuedBubbles([item('p'), item('e'), item('r')], queue([
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
	const [bubble] = buildQueuedBubbles([item('r', 'followUp', { state: 'recovered' })], null);
	assert.equal(bubble.status, 'recovered');
});

test('consumed inputs leave the queue and therefore the transcript', () => {
	// The SDK drops a consumed entry from the queue snapshot in the same burst that emits the
	// real user message, so the synthesized bubble never duplicates the delivered turn.
	assert.deepEqual(buildQueuedBubbles([], queue([])), []);
});

test('ChatView mounts the pending bubbles and follows them to the bottom', () => {
	const source = readFileSync(new URL('../packages/ui/src/components/ChatView.tsx', import.meta.url), 'utf8');
	assert.match(source, /<QueuedTranscriptMessages \/>/);
	assert.match(source, /observer\.observe\(queuedRegionRef\.current\)/);
	const bubbles = readFileSync(new URL('../packages/ui/src/components/QueuedTranscriptMessages.tsx', import.meta.url), 'utf8');
	assert.match(bubbles, /mutate\('steer', bubble\.id\)/);
	assert.match(bubbles, /mutate\('remove', bubble\.id\)/);
});

test('composer strip and transcript bubbles share one queue controller per scope', () => {
	const source = readFileSync(new URL('../packages/ui/src/useInputQueue.ts', import.meta.url), 'utf8');
	assert.match(source, /acquireController\(bridge, scope\)/);
	// One consumer unmounting must not disable the controller for the other.
	assert.match(source, /if \(shared\.holds === 0\) controller\.setEnabled\(false\)/);
});
