// B5 悬停摘要懒加载：纯逻辑（首行摘要提取、预览缓存去重/静默降级/容量上限、
// 分支感知的主进程摘要提取）+ 接线约定（行组件使用延迟打开的悬停卡片）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createSessionPreviewCache, firstSummaryLine, previewFromMessages, SESSION_PREVIEW_CACHE_LIMIT, sessionPreviewCacheKey } from '../packages/ui/src/sessionPreview.ts';
import { messagesForBranchHead, sessionPreviewFrom } from '../packages/desktop/src/main/indexedSearch.ts';

test('firstSummaryLine collapses the first line, caps length and never splits a surrogate pair', () => {
	assert.equal(firstSummaryLine('  hello   world  '), 'hello world');
	assert.equal(firstSummaryLine('first line\r\nsecond line'), 'first line');
	assert.equal(firstSummaryLine('tab\tand\nnewline collapsed'), 'tab and', 'only the first line survives; its whitespace collapses');
	assert.equal(firstSummaryLine('x'.repeat(300)).length, 240);
	assert.equal(firstSummaryLine('\n\nonly later lines matter'), 'only later lines matter', 'leading blank lines are skipped before the first line');
	// 唯一的行内容以代理对结尾时，截断点不切半个字符。
	const emojiLine = firstSummaryLine('a' + '😀'.repeat(200));
	assert.ok(!/[\uD800-\uDBFF]$/u.test(emojiLine), 'never ends on a lone high surrogate');
	assert.equal([...emojiLine].length, 120);
});

test('previewFromMessages takes the last user and assistant lines from memory without IPC', () => {
	assert.deepEqual(previewFromMessages([
		{ role: 'user', text: 'first question' },
		{ role: 'assistant', text: 'first answer\nsecond line dropped' },
		{ role: 'user', text: 'follow up' },
		{ role: 'assistant', text: 'final answer' },
	]), { lastUser: 'follow up', lastAssistant: 'final answer' });
	// 只有用户消息：仅返回 lastUser；两条都为空文本时返回 null（无摘要区）。
	assert.deepEqual(previewFromMessages([{ role: 'user', text: 'only question' }]), { lastUser: 'only question' });
	assert.equal(previewFromMessages([{ role: 'user', text: '   \n  ' }]), null);
	assert.equal(previewFromMessages([]), null);
});

test('preview cache dedupes in-flight lookups and settles fetch failures as silent null', async () => {
	const cache = createSessionPreviewCache(3);
	let calls = 0;
	const fetch = async () => { calls += 1; if (calls === 1) throw new Error('probe rejected'); return { lastUser: 'later' }; };
	const first = cache.get('k', fetch);
	assert.equal(cache.peek('k'), undefined, 'in-flight entry has no synchronous value yet');
	assert.equal(await first, null, 'a failing probe degrades to null instead of rejecting');
	assert.equal(cache.peek('k'), null, 'the degraded null is cached');
	await cache.get('k', fetch);
	assert.equal(calls, 1, 'no retry storm while the revision key stays the same');
	// 同一修订的并发悬停只触发一次请求。
	let concurrent = 0;
	const slow = cache.get('k2', async () => { concurrent += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return { lastAssistant: 'a' }; });
	await Promise.all([cache.get('k2', () => { throw new Error('never'); }), slow]);
	assert.equal(concurrent, 1);
	// 新修订（key 变化）重新加载。
	assert.deepEqual(await cache.get('k2:rev2', async () => ({ lastUser: 'fresh' })), { lastUser: 'fresh' });
});

test('preview cache stays bounded by evicting the oldest revision', async () => {
	const cache = createSessionPreviewCache(2);
	await cache.get('a', async () => ({ lastUser: 'a' }));
	await cache.get('b', async () => ({ lastUser: 'b' }));
	await cache.get('c', async () => ({ lastUser: 'c' }));
	assert.equal(cache.peek('a'), undefined, 'oldest entry evicted');
	assert.deepEqual(cache.peek('c'), { lastUser: 'c' });
	assert.ok(SESSION_PREVIEW_CACHE_LIMIT > 0);
	assert.equal(sessionPreviewCacheKey('p', 'm1') === sessionPreviewCacheKey('p', 'm1'), true);
	assert.notEqual(sessionPreviewCacheKey('p', 'm1'), sessionPreviewCacheKey('p', 'm2'), 'a new revision is a new key');
});

const message = (id, parentId, role, text) => ({ parentId, message: { id, role, text } });
const parsed = (entries, leaf) => {
	const nodes = entries.map((entry) => [entry.message.id, entry]);
	const messages = [];
	let cursor = leaf;
	const seen = new Set();
	while (cursor && !seen.has(cursor)) { seen.add(cursor); const entry = entries.find((candidate) => candidate.message.id === cursor); if (!entry) break; messages.unshift(entry.message); cursor = entry.parentId; }
	return { summary: { path: 'p', cwd: 'c', id: 's', firstMessage: '', modified: '', messageCount: messages.length }, messages, otherMessages: [], nodes, truncated: false, incomplete: false };
};

test('sessionPreviewFrom summarizes the latest leaf chain and follows the selected branch head', () => {
	const tree = parsed([
		message('u1', null, 'user', 'original question'),
		message('a1', 'u1', 'assistant', 'original answer'),
		message('u2', 'a1', 'user', 'revised question'),
		message('a2', 'u2', 'assistant', 'revised answer'),
		message('a1b', 'u1', 'assistant', 'branched answer'),
	], 'a2');
	assert.deepEqual(sessionPreviewFrom(tree), { lastUser: 'revised question', lastAssistant: 'revised answer' });
	// 侧栏记忆的分支头改变可见链路：摘要跟随被查看的分支。
	assert.deepEqual(sessionPreviewFrom(tree, 'a1b'), { lastUser: 'original question', lastAssistant: 'branched answer' });
	assert.deepEqual(sessionPreviewFrom(tree, 'a2'), { lastUser: 'revised question', lastAssistant: 'revised answer' }, 'the leaf chain needs no branch head');
	// 环状分支头不会死循环。
	const cyclic = parsed([message('u1', 'u1', 'user', 'loop')], 'u1');
	assert.equal(messagesForBranchHead(cyclic, 'u1').length, 1);
	assert.equal(sessionPreviewFrom(null), null);
	assert.equal(sessionPreviewFrom(parsed([], null)), null, 'no user/assistant text means no summary area');
});

test('sidebar rows wire the delayed hover card and lazy summary trigger', () => {
	const panel = readFileSync(new URL('../packages/ui/src/components/SidebarSessionPanel.tsx', import.meta.url), 'utf8');
	assert.match(panel, /<SessionHoverPreview session=\{session\} title=\{title\} row=\{/);
	const preview = readFileSync(new URL('../packages/ui/src/components/SessionHoverPreview.tsx', import.meta.url), 'utf8');
	assert.match(preview, /SESSION_PREVIEW_OPEN_DELAY_MS = 300/);
	assert.match(preview, /onOpen=\{open\}/);
	assert.match(preview, /loadSessionPreview\(/);
	const tooltip = readFileSync(new URL('../packages/ui/src/components/HoverTooltip.tsx', import.meta.url), 'utf8');
	assert.match(tooltip, /openDelayMs/);
	assert.match(tooltip, /onOpen\?\.?\(\)/);
});
