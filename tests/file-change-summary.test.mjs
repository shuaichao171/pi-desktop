// 文件修改感知：转录回退聚合（老会话）、跨轮并集、路径规范化与挂点约定。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const {
	normalizeToolFilePath, editDiffStats, fallbackTurnChanges,
	mergeTurnFileChanges, overlaySessionStats, unionFileChanges, withUnavailableDiffs,
} = await import('../packages/ui/src/fileChangeSummary.ts');

const uiSource = (relative) => readFileSync(fileURLToPath(new URL(`../packages/ui/src/${relative}`, import.meta.url)), 'utf8');

test('normalizeToolFilePath relativizes and rejects escapes lexically', () => {
	// 相对路径：分隔符归一、./ 折叠、重复斜杠折叠。
	assert.equal(normalizeToolFilePath('/work/app', 'src\\lib\\a.ts'), 'src/lib/a.ts');
	assert.equal(normalizeToolFilePath('/work/app', './/src/./a.ts'), 'src/a.ts');
	assert.equal(normalizeToolFilePath('/work/app', 'src/../lib/a.ts'), 'lib/a.ts');
	// .. 逃逸工作区、空串、.git、控制字符一律拒绝。
	assert.equal(normalizeToolFilePath('/work/app', '../outside.ts'), null);
	assert.equal(normalizeToolFilePath('/work/app', 'src/../../outside.ts'), null);
	assert.equal(normalizeToolFilePath('/work/app', ''), null);
	assert.equal(normalizeToolFilePath('/work/app', '.git/config'), null);
	assert.equal(normalizeToolFilePath('/work/app', 'src/\u0000a'), null);
	// POSIX 绝对路径：根内相对化、根外拒绝、根工作区放行。
	assert.equal(normalizeToolFilePath('/work/app', '/work/app/src/a.ts'), 'src/a.ts');
	assert.equal(normalizeToolFilePath('/work/app', '/work/other/a.ts'), null);
	assert.equal(normalizeToolFilePath('/', '/srv/x/a.ts'), 'srv/x/a.ts');
	// Windows 绝对路径：盘符大小写无关（路径段保持录入大小写）、根内相对化、根外拒绝、盘根工作区放行。
	assert.equal(normalizeToolFilePath('E:\\work\\app', 'e:/work/app/src/a.ts'), 'src/a.ts');
	assert.equal(normalizeToolFilePath('E:\\work\\app', 'E:\\work\\app\\b.ts'), 'b.ts');
	assert.equal(normalizeToolFilePath('E:\\work\\app', 'E:\\work\\b.ts'), null);
	assert.equal(normalizeToolFilePath('E:\\work\\app', 'C:\\work\\a.ts'), null);
	assert.equal(normalizeToolFilePath('E:\\work\\app', '/srv/a.ts'), null);
	assert.equal(normalizeToolFilePath('E:\\', 'E:\\src\\a.ts'), 'src/a.ts');
	// 盘相对路径（C:file）按进程 CWD 解析，无法静态相对化，拒绝。
	assert.equal(normalizeToolFilePath('E:\\work\\app', 'E:a.ts'), null);
});

test('editDiffStats counts pi edit-tool rows exactly and rejects foreign text', () => {
	// 变更行逐行列出；上下文与 `...` 省略行不计入。
	assert.deepEqual(editDiffStats('+1 hello\n 2 context\n-3 old\n  ...'), { additions: 1, deletions: 1 });
	assert.deepEqual(editDiffStats('+10 a\n+11 b\n-2 c'), { additions: 2, deletions: 1 });
	// 空文本、纯上下文、格式外文本（含被截断的行）、无变更行都返回 null。
	assert.equal(editDiffStats(''), null);
	assert.equal(editDiffStats(' 1 only context'), null);
	assert.equal(editDiffStats('+1 fine\nrandom junk'), null);
	assert.equal(editDiffStats('The file was written.'), null);
});

function activity(partial) {
	return { id: partial.id ?? 't', order: 0, tool: partial.tool ?? 'edit', title: '', status: partial.status ?? 'done', files: partial.files ?? null, diff: partial.diff ?? null, runId: partial.runId };
}

test('fallbackTurnChanges aggregates completed edit/write calls per run', () => {
	const changes = fallbackTurnChanges('/work/app', [
		activity({ id: 'a', runId: 'r1', tool: 'edit', files: ['src/a.ts'], diff: '+1 x\n-1 y' }),
		activity({ id: 'b', runId: 'r1', tool: 'edit', files: ['src\\a.ts', 'src/b.ts'], diff: '+2 p\n+3 q\n 4 ctx' }),
		activity({ id: 'c', runId: 'r2', tool: 'write', files: ['docs/new.md'] }),
		activity({ id: 'd', runId: 'r2', tool: 'edit', files: ['../outside.ts'], diff: '+1 z' }),
		activity({ id: 'e', runId: 'r2', tool: 'edit', status: 'error', files: ['src/failed.ts'], diff: '+9 broken' }),
		activity({ id: 'f', runId: 'r2', tool: 'read', files: ['src/read.ts'] }),
		activity({ id: 'g', runId: undefined, tool: 'edit', files: ['legacy.ts'], diff: '+1 l' }),
	]);
	// r1：同一文件两次编辑计数求和，跨文件去重后按路径排序。
	assert.deepEqual(changes.get('r1'), [
		{ path: 'src/a.ts', kind: 'modified', additions: 3, deletions: 1 },
		{ path: 'src/b.ts', kind: 'modified', additions: 2, deletions: 0 },
	]);
	// r2：write 无行数；工作区外路径与失败调用被丢弃；read 工具不参与。
	assert.deepEqual(changes.get('r2'), [{ path: 'docs/new.md', kind: 'modified', additions: null, deletions: null }]);
	// 无 runId 的老记录落入 null 桶（会话级汇总用）。
	assert.deepEqual(changes.get(null), [{ path: 'legacy.ts', kind: 'modified', additions: 1, deletions: 0 }]);
	// 混入一次 write 后同文件计数不可知，退化为纯清单。
	const mixed = fallbackTurnChanges('/work/app', [
		activity({ id: 'a', runId: 'r1', tool: 'edit', files: ['a.ts'], diff: '+1 x' }),
		activity({ id: 'b', runId: 'r1', tool: 'write', files: ['a.ts'] }),
	]);
	assert.deepEqual(mixed.get('r1'), [{ path: 'a.ts', kind: 'modified', additions: null, deletions: null }]);
	// 计数不可解析（截断/格式外）同样退化为纯清单。
	const unparsed = fallbackTurnChanges('/work/app', [activity({ id: 'a', runId: 'r1', files: ['a.ts'], diff: 'not a diff' })]);
	assert.deepEqual(unparsed.get('r1'), [{ path: 'a.ts', kind: 'modified', additions: null, deletions: null }]);
});

test('mergeTurnFileChanges layers the fallback under recorded tracker turns', () => {
	const tracked = [
		{ runId: 'r1', items: [{ path: 'src/a.ts', kind: 'modified', additions: 5, deletions: 2 }] },
		{ runId: null, items: [{ path: 'legacy.ts', kind: 'added', additions: 1, deletions: 0 }] },
	];
	const merged = mergeTurnFileChanges(tracked, new Map([
		['r1', [{ path: 'src/a.ts', kind: 'modified', additions: null, deletions: null }, { path: 'gen.ts', kind: 'modified', additions: null, deletions: null }]],
		['r2', [{ path: 'other.ts', kind: 'modified', additions: null, deletions: null }]],
		[null, [{ path: 'legacy2.ts', kind: 'modified', additions: null, deletions: null }]],
	]));
	assert.deepEqual(merged, [
		{ runId: 'r1', items: [
			{ path: 'gen.ts', kind: 'modified', additions: null, deletions: null },
			{ path: 'src/a.ts', kind: 'modified', additions: 5, deletions: 2 },
		] },
		{ runId: null, items: [
			{ path: 'legacy.ts', kind: 'added', additions: 1, deletions: 0 },
			{ path: 'legacy2.ts', kind: 'modified', additions: null, deletions: null },
		] },
		{ runId: 'r2', items: [{ path: 'other.ts', kind: 'modified', additions: null, deletions: null }] },
	]);
	// 记录优先：tracker 条目不得被回退数据覆盖（原数组不被修改）。
	assert.equal(tracked[0].items.length, 1);
	assert.deepEqual(mergeTurnFileChanges(tracked, new Map()), tracked);
});

test('unionFileChanges dedupes across turns with recorded details winning', () => {
	const union = unionFileChanges([
		{ runId: 'r1', items: [{ path: 'b.ts', kind: 'modified', additions: 1, deletions: 0 }, { path: 'a.ts', kind: 'added', additions: 2, deletions: 0 }] },
		{ runId: 'r2', items: [{ path: 'b.ts', kind: 'modified', additions: null, deletions: null }, { path: 'c.ts', kind: 'deleted', additions: null, deletions: null }] },
	]);
	assert.deepEqual(union, [
		{ path: 'a.ts', kind: 'added', additions: 2, deletions: 0 },
		{ path: 'b.ts', kind: 'modified', additions: 1, deletions: 0 },
		{ path: 'c.ts', kind: 'deleted', additions: null, deletions: null },
	]);
	assert.deepEqual(unionFileChanges([]), []);
});

test('withUnavailableDiffs degrades fallback paths instead of claiming no differences', () => {
	const loaded = new Map([['a.ts', { path: 'a.ts', diff: '+1', preview: undefined }]]);
	const degraded = withUnavailableDiffs(loaded, [
		{ path: 'a.ts', kind: 'modified', additions: 1, deletions: 0 },
		{ path: 'gen.ts', kind: 'modified', additions: null, deletions: null },
	]);
	assert.equal(degraded.get('gen.ts').preview, 'unavailable');
	assert.equal(degraded.get('gen.ts').diff, null);
	assert.equal(degraded.get('a.ts').diff, '+1');
	// 输入映射不被修改。
	assert.equal(loaded.has('gen.ts'), false);
});

test('挂点约定：轮次变更卡、会话汇总与回退聚合的接线', () => {
	const chat = uiSource('components/ChatView.tsx');
	const turn = uiSource('components/ConversationTurn.tsx');
	const composerChanges = uiSource('components/ComposerChanges.tsx');
	// ChatView 用「记录优先 + 转录回退」的合并轮次派生 changesByRun / 会话并集。
	assert.match(chat, /mergeTurnFileChanges\(fileChangeTurns, fallbackChanges\)/);
	assert.match(chat, /unionFileChanges\(mergedTurns\)/);
	// 每轮的结算卡来自 changesByRun，且只在 lastForRun 的轮尾挂一次。
	assert.match(chat, /changes=\{entry\.runId && entry\.lastForRun \? changesByRun\.get\(entry\.runId\) : undefined\}/);
	assert.match(turn, /entry\.runId && <div className="pd-turn-changes"><ChangesCard/);
	// 运行中摘要进输入框 dock；空闲时会话汇总进同一 dock（互斥于 agentStatus）。
	assert.match(chat, /agentStatus === 'busy' && liveChanges\.length > 0 && <LiveChangesSummary/);
	assert.match(chat, /agentStatus !== 'busy' && hasTurnScopedChanges && sessionChanges\.length > 0 && <SessionChangesSummary/);
	assert.match(composerChanges, /export function SessionChangesSummary/);
	assert.match(composerChanges, /className="pd-composer-changes is-session"/);
	// 审查对话框按会话范围展示合并后的并集，并对无记录差异的路径降级。
	assert.match(chat, /changesReview\.scope\.kind === 'conversation'\) return sessionChanges/);
	assert.match(chat, /withUnavailableDiffs\(loaded, reviewItems\)/);
});

test('i18n：会话汇总文案中英齐备', () => {
	const i18n = uiSource('i18n.ts');
	assert.match(i18n, /'composerChanges\.sessionSummary':\s*\{\s*'zh-CN': '[^']*',\s*'en-US': '[^']*'\s*\}/);
});

test('editDiffStats 与权威解析器语法对齐（裸数字行、符号后空格、多空格上下文）', () => {
	// unifiedDiff.ts / isEditDiffText 均接受：符号+可选空格+数字（尾空格或行尾）。
	assert.deepEqual(editDiffStats('+3 bare addition'), { additions: 1, deletions: 0 });
	assert.deepEqual(editDiffStats('+ 3 spaced sign'), { additions: 1, deletions: 0 });
	assert.deepEqual(editDiffStats('- 7 x\n-  7 y'), { additions: 0, deletions: 2 });
	assert.deepEqual(editDiffStats('  5 multi-space context\n+10 a'), { additions: 1, deletions: 0 });
	assert.deepEqual(editDiffStats('+3'), { additions: 1, deletions: 0 });
});

test('mergeTurnFileChanges 合并回退路径后同轮清单保持路径排序', () => {
	const tracked = [{ runId: 'r1', items: [
		{ path: 'src/z.ts', kind: 'modified', additions: 1, deletions: 0 },
		{ path: 'src/b.ts', kind: 'modified', additions: 2, deletions: 0 },
	] }];
	const fallback = new Map([['r1', [
		{ path: 'src/a.ts', kind: 'modified', additions: null, deletions: null },
		{ path: 'src/b.ts', kind: 'modified', additions: null, deletions: null }, // 已知路径应被跳过
	]]]);
	const merged = mergeTurnFileChanges(tracked, fallback);
	assert.deepEqual(merged[0].items.map(item => item.path), ['src/a.ts', 'src/b.ts', 'src/z.ts']);
});

test('overlaySessionStats 会话级净差覆盖并集首见统计', () => {
	const union = [
		{ path: 'a.ts', kind: 'modified', additions: 10, deletions: 2 }, // 轮次首见（r1 的统计）
		{ path: 'b.ts', kind: 'modified', additions: 3, deletions: 0 },  // 纯回退路径，无会话记录
	];
	const session = [
		{ path: 'a.ts', kind: 'modified', additions: 15, deletions: 3 }, // 跟踪器会话级净差（r1+r2）
	];
	const overlay = overlaySessionStats(union, session);
	assert.deepEqual(overlay[0], session[0]); // 覆盖为净差，与差异正文同源
	assert.deepEqual(overlay[1], union[1]);   // 回退路径保持近似
	// 不修改输入数组。
	assert.equal(union[0].additions, 10);
});
