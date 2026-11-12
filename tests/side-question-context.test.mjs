import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('./') && context.parentURL && new URL(context.parentURL).pathname.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
		return nextResolve(specifier, context);
	},
});

const { buildSideQuestionContext, sideQuestionAnchorFor } = await import('../packages/ui/src/sideQuestionContext.ts');

let order = 0;
const msg = (id, role, text, extra = {}) => ({ id, role, order: order++, text, status: 'done', ...extra });
const user = (id, text) => msg(id, 'user', text);
const assistant = (id, text) => msg(id, 'assistant', text);

function conversation() {
	return [
		user('u1', '帮我看看登录模块'),
		assistant('a1', '登录模块在 src/auth，包含 token 刷新逻辑。'),
		user('u2', 'token 刷新在哪里触发？'),
		assistant('a2', '在 axios 拦截器里，401 时自动刷新。'),
		user('u3', '刷新失败的兜底是什么？'),
		assistant('a3', '失败会跳转登录页并清理本地存储。'),
		user('u4', '再加一个图标'),
		assistant('a4', '图标已加到登录按钮。'),
	];
}

test('anchor resolution maps messages to their turn user message', () => {
	const messages = conversation();
	assert.equal(sideQuestionAnchorFor(messages, 'u2'), 'u2');
	assert.equal(sideQuestionAnchorFor(messages, 'a2'), 'u2');
	assert.equal(sideQuestionAnchorFor(messages, 'missing'), null);
	// Assistant text before any user message has no anchor.
	assert.equal(sideQuestionAnchorFor([assistant('a0', 'hi')], 'a0'), null);
});

test('the slice quotes the anchor turn plus one turn on each side, chronologically', () => {
	const slice = buildSideQuestionContext(conversation(), 'u2');
	assert.ok(slice);
	assert.equal(slice.truncated, false);
	const text = slice.text;
	assert.ok(text.indexOf('[User]\n帮我看看登录模块') < text.indexOf('[User]\ntoken 刷新在哪里触发？'), 'previous turn precedes the anchor turn');
	assert.ok(text.indexOf('[User]\ntoken 刷新在哪里触发？') < text.indexOf('[User]\n刷新失败的兜底是什么？'), 'anchor turn precedes the following turn');
	assert.ok(text.includes('[Assistant]\n在 axios 拦截器里，401 时自动刷新。'));
	assert.ok(!text.includes('再加一个图标'), 'turns beyond the ±1 window stay out');
	assert.ok(!text.includes('图标已加到登录按钮'));
});

test('system notices and empty messages never enter the slice', () => {
	const messages = [
		user('u1', '第一轮'),
		msg('s1', 'system', '压缩摘要', { systemKind: 'compaction' }),
		msg('s2', 'system', '插件通知', { systemKind: 'extension-notice' }),
		assistant('a1', ''),
		assistant('a2', '回答'),
	];
	const slice = buildSideQuestionContext(messages, 'u1');
	assert.ok(slice);
	assert.ok(slice.text.includes('[Assistant]\n回答'));
	assert.ok(!slice.text.includes('压缩摘要'));
	assert.ok(!slice.text.includes('插件通知'));
});

test('outer turns that do not fit are dropped and flagged, the anchor turn always survives', () => {
	const slice = buildSideQuestionContext(conversation(), 'u2', { limit: 60 });
	assert.ok(slice);
	assert.equal(slice.truncated, true);
	assert.ok(slice.text.includes('token 刷新在哪里触发？'), 'the anchor question always survives');
	assert.ok(!slice.text.includes('帮我看看登录模块') || !slice.text.includes('刷新失败的兜底'), 'at most one outer turn fits');
});

test('an oversized anchor turn clips message tails and keeps every turn message', () => {
	const messages = [
		user('u1', 'x'.repeat(50)),
		assistant('a1', `${'首'.repeat(200)}\n结论在最后。`),
	];
	const slice = buildSideQuestionContext(messages, 'u1', { limit: 120, messageLimit: 10_000 });
	assert.ok(slice);
	assert.equal(slice.truncated, true);
	assert.ok(slice.text.includes('[User]'));
	assert.ok(slice.text.includes('结论在最后。'), 'the assistant tail (conclusion) is kept');
	assert.ok(slice.text.includes('[beginning omitted]'), 'the clip is marked');
	assert.ok(!slice.text.includes('首'.repeat(60)), 'the assistant head is dropped');
	assert.ok(slice.text.length <= 140, 'the slice stays within a small constant of the budget');
});

test('a single long message keeps its tail (the question), per-message, before turn assembly', () => {
	const messages = [
		user('u1', `${'前'.repeat(300)}问题在末尾：为什么？`),
		assistant('a1', '回答'),
	];
	const slice = buildSideQuestionContext(messages, 'u1', { messageLimit: 40 });
	assert.ok(slice);
	assert.equal(slice.truncated, true);
	assert.ok(slice.text.includes('问题在末尾：为什么？'), 'the trailing question survives the clip');
	assert.ok(slice.text.includes('[beginning omitted]'));
	assert.ok(slice.text.includes('回答'));
	assert.ok(!slice.text.includes('前'.repeat(30)));
});

test('anchors outside the loaded transcript yield no slice', () => {
	assert.equal(buildSideQuestionContext(conversation(), 'missing'), null);
	assert.equal(buildSideQuestionContext([], 'u1'), null);
	assert.equal(buildSideQuestionContext(conversation(), 'u2', { limit: 0 }), null);
});

test('before-turns outrank after-turns when the budget only fits one neighbour', () => {
	const messages = [
		user('u1', '前一轮问题'),
		assistant('a1', '前一轮回答'),
		user('u2', '锚点问题'),
		assistant('a2', '锚点回答'),
		user('u3', '后一轮问题'),
		assistant('a3', '后一轮回答'),
	];
	// Budget fits the anchor turn plus exactly one neighbour: the previous turn wins.
	const anchorSize = '[User]\n锚点问题'.length + 2 + '[Assistant]\n锚点回答'.length;
	const beforeSize = '[User]\n前一轮问题'.length + 2 + '[Assistant]\n前一轮回答'.length;
	const slice = buildSideQuestionContext(messages, 'u2', { limit: anchorSize + 2 + beforeSize });
	assert.ok(slice);
	assert.ok(slice.text.includes('前一轮问题'));
	assert.ok(!slice.text.includes('后一轮问题'));
	assert.equal(slice.truncated, true);
});
