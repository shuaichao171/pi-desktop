// 侧问：一次独立的旁路模型调用（不写会话转录），这里测纯提示词拼装与答案清理。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSideQuestionPrompt, cleanSideQuestionAnswer, SIDE_QUESTION_TIMEOUT_MS } from '../packages/agent/src/sideQuestion.ts';

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
