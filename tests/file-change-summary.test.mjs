// 文件修改感知：转录回退聚合（老会话）、跨轮并集、路径规范化与挂点约定。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const {
	normalizeToolFilePath, fallbackTurnChanges,
	mergeTurnFileChanges, sessionFileChanges, unionFileChanges, withUnavailableDiffs,
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
	// r1：同一文件多次编辑去重，跨文件按路径排序，不产出增删行数。
	assert.deepEqual(changes.get('r1'), [
		{ path: 'src/a.ts', kind: 'modified' },
		{ path: 'src/b.ts', kind: 'modified' },
	]);
	// r2：工作区外路径与失败调用被丢弃；read 工具不参与。
	assert.deepEqual(changes.get('r2'), [{ path: 'docs/new.md', kind: 'modified' }]);
	// 无 runId 的老记录落入 null 桶（会话级汇总用）。
	assert.deepEqual(changes.get(null), [{ path: 'legacy.ts', kind: 'modified' }]);
});

test('mergeTurnFileChanges layers the fallback under recorded tracker turns', () => {
	const tracked = [
		{ runId: 'r1', items: [{ path: 'src/a.ts', kind: 'modified' }] },
		{ runId: null, items: [{ path: 'legacy.ts', kind: 'added' }] },
	];
	const merged = mergeTurnFileChanges(tracked, new Map([
		['r1', [{ path: 'src/a.ts', kind: 'modified' }, { path: 'gen.ts', kind: 'modified' }]],
		['r2', [{ path: 'other.ts', kind: 'modified' }]],
		[null, [{ path: 'legacy2.ts', kind: 'modified' }]],
	]));
	assert.deepEqual(merged, [
		{ runId: 'r1', items: [
			{ path: 'gen.ts', kind: 'modified' },
			{ path: 'src/a.ts', kind: 'modified' },
		] },
		{ runId: null, items: [
			{ path: 'legacy.ts', kind: 'added' },
			{ path: 'legacy2.ts', kind: 'modified' },
		] },
		{ runId: 'r2', items: [{ path: 'other.ts', kind: 'modified' }] },
	]);
	// 记录优先：tracker 条目不得被回退数据覆盖（原数组不被修改）。
	assert.equal(tracked[0].items.length, 1);
	assert.deepEqual(mergeTurnFileChanges(tracked, new Map()), tracked);
});

test('unionFileChanges dedupes across turns with recorded details winning', () => {
	const union = unionFileChanges([
		{ runId: 'r1', items: [{ path: 'b.ts', kind: 'modified' }, { path: 'a.ts', kind: 'added' }] },
		{ runId: 'r2', items: [{ path: 'b.ts', kind: 'deleted' }, { path: 'c.ts', kind: 'deleted' }] },
	]);
	assert.deepEqual(union, [
		{ path: 'a.ts', kind: 'added' },
		{ path: 'b.ts', kind: 'modified' },
		{ path: 'c.ts', kind: 'deleted' },
	]);
	assert.deepEqual(unionFileChanges([]), []);
});

test('withUnavailableDiffs degrades fallback paths instead of claiming no differences', () => {
	const loaded = new Map([['a.ts', { path: 'a.ts', diff: '+1', preview: undefined }]]);
	const degraded = withUnavailableDiffs(loaded, [
		{ path: 'a.ts', kind: 'modified' },
		{ path: 'gen.ts', kind: 'modified' },
	]);
	assert.equal(degraded.get('gen.ts').preview, 'unavailable');
	assert.equal(degraded.get('gen.ts').diff, null);
	assert.equal(degraded.get('a.ts').diff, '+1');
	// 输入映射不被修改。
	assert.equal(loaded.has('gen.ts'), false);
});

test('挂点约定：保留轮次变更卡与审查对话框，移除输入框上方浮条', () => {
	const chat = uiSource('components/ChatView.tsx');
	const composer = uiSource('components/Composer.tsx');
	const turn = uiSource('components/ConversationTurn.tsx');
	const composerChanges = uiSource('components/ComposerChanges.tsx');
	// ChatView 用「记录优先 + 转录回退」的合并轮次派生 changesByRun / 会话并集。
	assert.match(chat, /mergeTurnFileChanges\(fileChangeTurns, fallbackChanges\)/);
	assert.match(chat, /fallbackTurnChanges\(cwd, activities, trackedRunIds\)/);
	assert.match(chat, /sessionFileChanges\(fileChangeTurns, fileChanges, mergedTurns\)/);
	// 每轮的结算卡来自 changesByRun，且只在 lastForRun 的轮尾挂一次。
	assert.match(chat, /changes=\{entry\.runId && entry\.lastForRun \? changesByRun\.get\(entry\.runId\) : undefined\}/);
	assert.match(turn, /entry\.runId && <div className="pd-turn-changes"><ChangesCard/);
	// 输入框上方不再渲染运行中/空闲会话文件修改浮条或挂槽。
	assert.doesNotMatch(chat, /LiveChangesSummary|SessionChangesSummary|changesSlotRef/);
	assert.doesNotMatch(composer, /pd-composer-changes-slot|changesSlotRef/);
	assert.doesNotMatch(composerChanges, /LiveChangesSummary|SessionChangesSummary/);
	// 审查对话框按会话范围展示合并后的并集，并对无记录差异的路径降级。
	assert.match(chat, /changesReview\.scope\.kind === 'conversation'\) return sessionChanges/);
	assert.match(chat, /withUnavailableDiffs\(loaded, reviewItems\)/);
});

test('mergeTurnFileChanges 合并回退路径后同轮清单保持路径排序', () => {
	const tracked = [{ runId: 'r1', items: [
		{ path: 'src/z.ts', kind: 'modified' },
		{ path: 'src/b.ts', kind: 'modified' },
	] }];
	const fallback = new Map([['r1', [
		{ path: 'src/a.ts', kind: 'modified' },
		{ path: 'src/b.ts', kind: 'modified' }, // 已知路径应被跳过
	]]]);
	const merged = mergeTurnFileChanges(tracked, fallback);
	assert.deepEqual(merged[0].items.map(item => item.path), ['src/a.ts', 'src/b.ts', 'src/z.ts']);
});

test('sessionFileChanges 取跟踪器会话级净差，净零路径不计，只补跟踪器从未见过的回退路径', () => {
	// x.ts：r1 新建、r2 删除，会话净差为零——跟踪器会话级记录里没有它。
	const tracked = [
		{ runId: 'r1', items: [{ path: 'a.ts', kind: 'modified' }, { path: 'x.ts', kind: 'added' }] },
		{ runId: 'r2', items: [{ path: 'a.ts', kind: 'modified' }, { path: 'x.ts', kind: 'deleted' }] },
	];
	const session = [{ path: 'a.ts', kind: 'modified' }];
	// 跟踪器之前的老轮次只有回退数据：old.ts 跟踪器从未见过。
	const merged = [{ runId: 'r0', items: [{ path: 'old.ts', kind: 'modified' }, { path: 'a.ts', kind: 'added' }] }, ...tracked];
	const result = sessionFileChanges(tracked, session, merged);
	assert.deepEqual(result, [
		{ path: 'a.ts', kind: 'modified' }, // 净差，与会话范围差异正文同源
		{ path: 'old.ts', kind: 'modified' }, // 纯回退路径保持近似
	]);
	assert.ok(!result.some(item => item.path === 'x.ts'), '先建后删的文件不算本次对话修改');
	// 纯老会话（无跟踪器数据）：汇总即回退并集。
	assert.deepEqual(sessionFileChanges([], [], merged.slice(0, 1)).map(item => item.path), ['a.ts', 'old.ts']);
	// 不修改输入。
	assert.equal(session.length, 1);
});

test('fallbackTurnChanges 在跟踪器首个记录轮次之后停止：先改后还原的净零编辑不会冒出幻影改动', () => {
	const activities = [
		activity({ id: 'o', runId: 'r0', files: ['old.ts'], diff: '+1 o' }), // 跟踪器之前的老轮次
		activity({ id: 'a', runId: 'r1', files: ['a.ts'], diff: '+1 x' }),
		activity({ id: 'b1', runId: 'r2', files: ['b.ts'], diff: '-1 old\n+1 new' }),
		activity({ id: 'b2', runId: 'r2', files: ['b.ts'], diff: '-1 new\n+1 old' }), // 还原：跟踪器净零、不记录 r2
	];
	const changes = fallbackTurnChanges('/work/app', activities, new Set(['r1']));
	assert.deepEqual([...changes.keys()], ['r0'], '只有跟踪器之前的轮次走回退');
	const merged = mergeTurnFileChanges([{ runId: 'r1', items: [{ path: 'a.ts', kind: 'modified' }] }], changes);
	assert.ok(!merged.some(turn => turn.items.some(item => item.path === 'b.ts')), 'b.ts 不得作为幻影改动出现');
	// 没有跟踪器记录时（老会话）照旧全量回退。
	assert.deepEqual([...fallbackTurnChanges('/work/app', activities).keys()], ['r0', 'r1', 'r2']);
});
