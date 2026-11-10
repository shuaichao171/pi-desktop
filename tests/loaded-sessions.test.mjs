// 「已加载会话」：右键或拖动把会话常驻到主窗口左上角区域，Ctrl+Tab 在其中切换；
// 分屏窗格自己的关闭按钮只隐藏窗格，真正关闭从已加载会话列表里做。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { addLoadedSession, getLoadedSessions, MAX_LOADED_SESSIONS, nextLoadedSession, normalizeLoadedSessions, removeLoadedSession, setLoadedPanes } from '../packages/ui/src/loadedSessions.ts';
import { SHORTCUT_BINDINGS } from '../packages/ui/src/shortcuts/bindings.ts';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const entry = (name) => ({ cwd: 'C:/work', path: `C:/sessions/${name}.jsonl` });
const pane = (paneId, name, hidden = false) => ({ paneId, cwd: 'C:/work', sessionPath: name ? `C:/sessions/${name}.jsonl` : null, hidden, busy: false });

test('stored list drops invalid rows, duplicates and anything past the limit', () => {
	const rows = [entry('a'), { cwd: '', path: 'x' }, null, entry('a'), { path: 'C:/no-cwd.jsonl' }, entry('b')];
	assert.deepEqual(normalizeLoadedSessions(rows), [entry('a'), entry('b')]);
	assert.deepEqual(normalizeLoadedSessions('nope'), []);
	const many = Array.from({ length: MAX_LOADED_SESSIONS + 5 }, (_, index) => entry(`s${index}`));
	assert.equal(normalizeLoadedSessions(many).length, MAX_LOADED_SESSIONS);
});

test('add is idempotent, refuses past the limit, and remove drops the row', () => {
	for (const item of [...getLoadedSessions().main]) removeLoadedSession(item.path);
	assert.equal(addLoadedSession(entry('a')), true);
	assert.equal(addLoadedSession(entry('a')), true);
	assert.equal(getLoadedSessions().main.length, 1);
	for (let index = 1; index < MAX_LOADED_SESSIONS; index += 1) assert.equal(addLoadedSession(entry(`n${index}`)), true);
	assert.equal(addLoadedSession(entry('overflow')), false);
	removeLoadedSession(entry('a').path);
	assert.equal(getLoadedSessions().main.some((item) => item.path === entry('a').path), false);
	for (const item of [...getLoadedSessions().main]) removeLoadedSession(item.path);
	setLoadedPanes([pane(3, 'p', true)]);
	assert.deepEqual(getLoadedSessions().panes, [pane(3, 'p', true)]);
	setLoadedPanes([]);
});

test('Ctrl+Tab cycles loaded main conversations and skips pane-held ones', () => {
	const list = [entry('a'), entry('b'), entry('c')];
	assert.equal(nextLoadedSession(list, [], entry('a').path, 1).path, entry('b').path);
	assert.equal(nextLoadedSession(list, [], entry('c').path, 1).path, entry('a').path);
	assert.equal(nextLoadedSession(list, [], entry('a').path, -1).path, entry('c').path);
	// From a conversation outside the list: forward enters at the first, backward at the last.
	assert.equal(nextLoadedSession(list, [], 'C:/other.jsonl', 1).path, entry('a').path);
	assert.equal(nextLoadedSession(list, [], null, -1).path, entry('c').path);
	// A pane hosts b: it lives in its own view and leaves the cycle.
	assert.equal(nextLoadedSession(list, [pane(1, 'b')], entry('a').path, 1).path, entry('c').path);
	assert.equal(nextLoadedSession([entry('a')], [], entry('a').path, 1), null);
	assert.equal(nextLoadedSession([], [], null, 1), null);
});

test('Ctrl+Tab bindings are registered and handled in the main window only', () => {
	const ids = new Map(SHORTCUT_BINDINGS.map((binding) => [binding.id, binding.keys]));
	assert.equal(ids.get('nextLoadedSession'), 'Ctrl+Tab');
	assert.equal(ids.get('previousLoadedSession'), 'Ctrl+Shift+Tab');
	const shell = read('../packages/ui/src/components/AppShell.tsx');
	assert.match(shell, /bindingKeysFor\('nextLoadedSession'\)/);
	assert.match(shell, /cycle && !paneMode/);
	assert.match(shell, /restoreLoadedSessions\(\)/);
});

test('a pane header close only hides the pane; the loaded list closes it for real', () => {
	const shell = read('../packages/ui/src/components/AppShell.tsx');
	assert.match(shell, /closeLabel=\{t\('pane\.hide'\)\}/);
	assert.match(shell, /setSplitPaneHidden\(true\)/);
	const region = read('../packages/ui/src/components/LoadedSessionsRegion.tsx');
	assert.match(region, /closeLoadedPane\(row\.paneId!\)/);
	assert.match(region, /data-session-drop="loaded"/);
	const panes = read('../packages/desktop/src/main/splitPanes.ts');
	assert.match(panes, /export function setPaneHidden/);
});

test('sidebar rows drag onto the loaded region or the split drop zone', () => {
	const sidebar = read('../packages/ui/src/components/SidebarSessionPanel.tsx');
	assert.match(sidebar, /beginSessionDrop\(session, event\)/);
	assert.match(sidebar, /target === 'loaded'/);
	assert.match(sidebar, /openInSplitPane\(session\)/);
	assert.match(sidebar, /sidebar\.loadSession/);
	const overlays = read('../packages/ui/src/components/SessionDropOverlays.tsx');
	assert.match(overlays, /data-session-drop="split"/);
});
