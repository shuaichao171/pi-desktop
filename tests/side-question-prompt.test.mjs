// 侧问：一次独立的旁路模型调用（不写会话转录），这里测纯提示词拼装与答案清理。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSideQuestionPrompt, cleanSideQuestionAnswer, sideQuestionAnswerFrom, SIDE_QUESTION_TIMEOUT_MS } from '../packages/agent/src/sideQuestion.ts';

test('the prompt quotes the context slice and ends with the question', () => {
	const prompt = buildSideQuestionPrompt({ context: '[User]\n问题\n\n[Assistant]\n回答', question: '为什么？' });
	assert.match(prompt, /<<<CONVERSATION\n\[User\]\n问题\n\n\[Assistant\]\n回答\nCONVERSATION/);
	assert.match(prompt, /用户针对这个轮次的旁路问题：为什么？$/);
	// An empty slice (anchor turn alone was empty) still asks the question.
	assert.match(buildSideQuestionPrompt({ context: '  ', question: '问' }), /旁路问题：问$/);
});

test('answer cleanup only strips whitespace and one stray body fence', () => {
	assert.equal(cleanSideQuestionAnswer('  答案\n'), '答案');
	assert.equal(cleanSideQuestionAnswer('```\n答案正文\n```'), '答案正文');
	assert.equal(cleanSideQuestionAnswer('````md\n答案\n````'), '````md\n答案\n````'.slice(3, -3));
	assert.equal(cleanSideQuestionAnswer(''), '');
	// A timeout of a few minutes covers a deliberate aside answer without hanging forever.
	assert.ok(SIDE_QUESTION_TIMEOUT_MS >= 60_000 && SIDE_QUESTION_TIMEOUT_MS <= 300_000);
});

test('provider failures surface their real reason and never store partial text as an answer', () => {
	const text = (value) => ({ type: 'text', text: value });
	assert.equal(sideQuestionAnswerFrom({ stopReason: 'stop', content: [text('答'), { type: 'thinking', thinking: 'x' }, text('案')] }), '答案');
	// pi-ai resolves (not rejects) with stopReason 'error'; the provider message must reach the card.
	assert.throws(() => sideQuestionAnswerFrom({ stopReason: 'error', errorMessage: '401 invalid api key', content: [text('半截')] }), /401 invalid api key/);
	assert.throws(() => sideQuestionAnswerFrom({ stopReason: 'error', content: [] }), /模型调用失败/);
	// Our timeout aborts the request: report the timeout, not "no answer".
	assert.throws(() => sideQuestionAnswerFrom({ stopReason: 'aborted', content: [text('半截')] }, true), /超时/);
	assert.throws(() => sideQuestionAnswerFrom({ stopReason: 'aborted', content: [] }), /取消/);
	assert.throws(() => sideQuestionAnswerFrom({ stopReason: 'stop', content: [text('  ')] }), /未返回/);
});
