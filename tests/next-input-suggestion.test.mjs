// 「猜你下一句」：回复结束后用单独一次模型请求猜用户下一句，灰字显示在空输入框，Tab 填入；
// 默认关闭、模型在设置里单独指定；请求不写会话记录，失败静默。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
	buildNextInputContext, cleanNextInputSuggestion, NEXT_INPUT_MAX_CHARS, NEXT_INPUT_MAX_CONTEXT_CHARS, NEXT_INPUT_MAX_MESSAGES,
} from '../packages/agent/src/nextInputSuggestion.ts';
import { normalizeNextInputSuggestionPreference, suggestionKey } from '../packages/ui/src/nextInputSuggestion.ts';

const msg = (role, text, extra = {}) => ({ id: `${role}-${text.length}-${Math.random()}`, role, text, status: 'done', ...extra });

test('context keeps the latest user/assistant text in order and skips system rows', () => {
	const context = buildNextInputContext([
		msg('user', 'first question'), msg('system', 'compacted', { systemKind: 'compaction' }), msg('assistant', 'first answer'),
		msg('user', 'second question'), msg('assistant', 'Shall I also add tests?'),
	]);
	assert.ok(context.indexOf('first question') < context.indexOf('Shall I also add tests?'));
	assert.doesNotMatch(context, /compacted/);
	assert.match(context, /USER:\nsecond question/);
	assert.match(context, /Predict the USER's next message\.$/);
});

test('context is bounded by message count and total size, keeping the newest', () => {
	const many = Array.from({ length: 40 }, (_, index) => msg(index % 2 ? 'assistant' : 'user', `m${index} ${'x'.repeat(3000)}`));
	const context = buildNextInputContext(many);
	assert.ok(context.length <= NEXT_INPUT_MAX_CONTEXT_CHARS + 200);
	// Long user text keeps its start, long assistant text keeps its end (the newest part).
	assert.ok(context.includes('m38 '), 'newest user message missing');
	assert.ok(context.trimEnd().endsWith("Predict the USER's next message."));
	assert.doesNotMatch(context, /m0 /);
	assert.ok((context.match(/^(USER|ASSISTANT):/gm) ?? []).length <= NEXT_INPUT_MAX_MESSAGES);
	assert.equal(buildNextInputContext([]), '');
});

test('model output is cleaned to one short line', () => {
	assert.equal(cleanNextInputSuggestion('"好的，继续实现第二步"'), '好的，继续实现第二步');
	assert.equal(cleanNextInputSuggestion('USER: run the tests\nand explain'), 'run the tests');
	assert.equal(cleanNextInputSuggestion('```\n用户：帮我提交\n```'), '帮我提交');
	assert.equal(cleanNextInputSuggestion('   '), '');
	assert.equal(cleanNextInputSuggestion('a'.repeat(500)).length, NEXT_INPUT_MAX_CHARS);
});

test('preference is off by default and validates the chosen model', () => {
	assert.deepEqual(normalizeNextInputSuggestionPreference(null), { enabled: false, model: null });
	assert.deepEqual(normalizeNextInputSuggestionPreference({ enabled: 'yes', model: { provider: 'p' } }), { enabled: false, model: null });
	assert.deepEqual(normalizeNextInputSuggestionPreference({ enabled: true, model: { provider: 'p', id: 'm' } }), { enabled: true, model: { provider: 'p', id: 'm' } });
});

test('a suggestion belongs to the settled reply that ends the conversation', () => {
	const reply = { id: 'a1', role: 'assistant', status: 'done', text: 'done' };
	assert.equal(suggestionKey('s.jsonl', [{ id: 'u1', role: 'user', text: 'hi' }, reply]), 's.jsonl\0a1');
	// Extension notices after the reply do not invalidate it.
	assert.equal(suggestionKey('s.jsonl', [reply, { id: 'n', role: 'system', systemKind: 'extension-notice', text: 'note' }]), 's.jsonl\0a1');
	assert.equal(suggestionKey('s.jsonl', [reply, { id: 'u2', role: 'user', text: 'next' }]), null);
	assert.equal(suggestionKey('s.jsonl', [{ ...reply, status: 'error' }]), null);
	assert.equal(suggestionKey('s.jsonl', [{ ...reply, status: 'streaming' }]), null);
	assert.equal(suggestionKey(null, [reply]), null);
});

test('composer shows the guess as placeholder text and Tab fills it in', () => {
	const composer = readFileSync(new URL('../packages/ui/src/components/Composer.tsx', import.meta.url), 'utf8');
	assert.match(composer, /placeholder=\{suggestion \?\? placeholder\}/);
	assert.match(composer, /event\.key === 'Tab'[^\n]*suggestion && !event\.currentTarget\.value/);
	assert.match(composer, /const suggestion = nextSuggestion && !text && !attachments\.length && status === 'idle'/);
	const hook = readFileSync(new URL('../packages/ui/src/useNextInputSuggestion.ts', import.meta.url), 'utf8');
	// Fires once per settled reply (busy → idle) and only when enabled; failures cache an empty hint.
	assert.match(hook, /if \(status !== 'idle' \|\| !sawBusy\.current\) return;/);
	assert.match(hook, /!preference\.enabled/);
	assert.match(hook, /\(\) => remember\(key, ''\)/);
	const agent = readFileSync(new URL('../packages/agent/src/index.ts', import.meta.url), 'utf8');
	assert.match(agent, /async suggestNextInput\(request: UiNextInputRequest\)/);
	const protocol = readFileSync(new URL('../packages/desktop/src/main/agentHostProtocol.ts', import.meta.url), 'utf8');
	assert.match(protocol, /'suggestNextInput'/);
});
