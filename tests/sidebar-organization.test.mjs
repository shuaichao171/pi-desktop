import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  buildSidebarGroups,
  buildSidebarProjectGroups,
  collectSidebarSessions,
  clearPinnedProjects,
  groupSessionsByDate,
  mergeSidebarProjectOrder,
  orderSidebarProjects,
  readSidebarPreferences,
  readPinnedProjects,
  reorderSidebarProjectPositions,
  saveSidebarPreferences,
  savePinnedProjects,
  selectSidebarSessions,
  sidebarProjectPaths,
  sidebarWorkspaceKey,
  splitSidebarProjects,
} from '../packages/ui/src/sidebarOrganization.ts';

const defaults = { mode: 'grouped', projectView: 'project', sort: 'newest', filter: 'all', collapsed: [], projectOrder: [] };
const session = (path, overrides = {}) => ({
  path, id: path, firstMessage: path, modified: '2026-09-24T08:00:00Z', messageCount: 1,
  workspace: 'first-project', ...overrides,
});
const paths = (sessions) => sessions.map((entry) => entry.path);
const selectActive = (sessions, overrides = {}) => selectSidebarSessions(sessions, {
  archived: false, filter: 'all', sort: 'newest', ...overrides,
});

test('sidebar preferences survive storage and tolerate corrupt or unavailable storage', () => {
  let stored;
  const storage = {
    getItem(key) { assert.equal(key, 'pi-desktop.sidebar-organization.v1'); return stored; },
    setItem(key, value) { assert.equal(key, 'pi-desktop.sidebar-organization.v1'); stored = value; },
  };
  assert.deepEqual(readSidebarPreferences(storage), defaults);
  const preferred = { mode: 'project', projectView: 'timeline', sort: 'oldest', filter: 'unread', collapsed: ['project:a', 'group:b'], projectOrder: ['b', 'a'] };
  saveSidebarPreferences(preferred, storage);
  assert.deepEqual(readSidebarPreferences(storage), preferred);
  stored = '{invalid';
  assert.deepEqual(readSidebarPreferences(storage), defaults);
  assert.deepEqual(readSidebarPreferences({ getItem() { throw new Error('blocked'); } }), defaults);
  assert.doesNotThrow(() => saveSidebarPreferences(preferred, { setItem() { throw new Error('quota'); } }));
});

test('legacy project pins migrate safely and can be cleared after desktop persistence', () => {
  let stored;
  const storage = {
    getItem(key) { assert.equal(key, 'pi-desktop.pinned-projects.v1'); return stored; },
    setItem(key, value) { assert.equal(key, 'pi-desktop.pinned-projects.v1'); stored = value; },
    removeItem(key) { assert.equal(key, 'pi-desktop.pinned-projects.v1'); stored = undefined; },
  };
  savePinnedProjects(['C:/one', 'C:/one', 'D:/two'], storage);
  assert.deepEqual(readPinnedProjects(storage), ['C:/one', 'D:/two']);
  clearPinnedProjects(storage);
  assert.deepEqual(readPinnedProjects(storage), []);
  assert.doesNotThrow(() => clearPinnedProjects({ removeItem() { throw new Error('blocked'); } }));
});

test('sidebar preference validation preserves valid fields and supplies independent defaults', () => {
  const read = (value) => readSidebarPreferences({ getItem: () => JSON.stringify(value) });
  for (const value of [null, [], true, 7, 'wrong']) assert.deepEqual(read(value), defaults);
  assert.deepEqual(read({ mode: 'wrong', projectView: 'timeline', sort: 7, filter: 'pinned', collapsed: ['group:a', null, '', 1, 'group:a', 'group:b'] }), {
    ...defaults, projectView: 'timeline', filter: 'pinned', collapsed: ['group:a', 'group:b'],
  });
  const first = read(null);
  first.collapsed.push('changed');
  first.projectOrder.push('changed');
  assert.deepEqual(read(null), defaults);
  assert.deepEqual(read({ projectOrder: ['b', null, '', 'b', 1, 'a'] }).projectOrder, ['b', 'a']);
});

test('project ordering is persisted independently of workspace MRU and respects pin partitions', () => {
  const saved = ['C:/second', 'C:/first', 'C:/pinned', 'C:/temporarily-unavailable'];
  const current = ['C:/first', 'C:/second', 'C:/pinned', 'C:/new'];
  const pinned = new Set(['C:/pinned']);
  const expected = ['C:/pinned', 'C:/second', 'C:/first', 'C:/new'];
  assert.deepEqual(orderSidebarProjects(current, saved, pinned), expected);
  assert.deepEqual(orderSidebarProjects([...current].reverse(), saved, pinned), expected, 'switching workspaces must not reshuffle project headers');
  assert.deepEqual(mergeSidebarProjectOrder(saved, ['C:/first']), saved, 'a partial startup registry must not erase other saved positions');
  assert.deepEqual(mergeSidebarProjectOrder(saved, current), [...saved, 'C:/new']);
  assert.deepEqual(orderSidebarProjects(['b', 'a', 'b'], [], new Set()), ['b', 'a']);
  assert.deepEqual(orderSidebarProjects(['a', 'b', 'c', 'd'], ['d', 'b', 'c', 'a'], new Set(['a', 'c'])), ['c', 'a', 'd', 'b']);
});

test('project pin sections preserve manual positions through pin and unpin changes', () => {
  const saved = ['D:/fourth', 'D:/second', 'D:/third', 'D:/first'];
  const workspaces = ['D:/first', 'D:/second', 'D:/third', 'D:/fourth'];
  const projectSections = (pins) => splitSidebarProjects(orderSidebarProjects(workspaces, saved, pins), pins);
  assert.deepEqual(projectSections(new Set()), { pinned: [], unpinned: saved });
  assert.deepEqual(projectSections(new Set(['D:/first', 'D:/third'])), {
    pinned: ['D:/third', 'D:/first'], unpinned: ['D:/fourth', 'D:/second'],
  });
  assert.deepEqual(projectSections(new Set(['D:/first'])), {
    pinned: ['D:/first'], unpinned: ['D:/fourth', 'D:/second', 'D:/third'],
  });
  assert.deepEqual(projectSections(new Set()), { pinned: [], unpinned: saved });
  assert.deepEqual(saved, ['D:/fourth', 'D:/second', 'D:/third', 'D:/first']);
  assert.deepEqual(workspaces, ['D:/first', 'D:/second', 'D:/third', 'D:/fourth']);
});

test('project pin sections match Windows aliases, deduplicate projects, and ignore stale pins', () => {
  const workspaces = ['D:/Projects/One', 'd:\\projects\\one\\', '//Server/share/Two', '/src/One', '/src/one'];
  const pins = new Set(['d:\\PROJECTS\\ONE\\', '\\\\server\\SHARE\\two\\', '/src/one', 'D:/removed']);
  assert.deepEqual(splitSidebarProjects(workspaces, pins), {
    pinned: ['D:/Projects/One', '//Server/share/Two', '/src/one'], unpinned: ['/src/One'],
  });
  assert.deepEqual(splitSidebarProjects([], pins), { pinned: [], unpinned: [] });
  assert.deepEqual([...pins], ['d:\\PROJECTS\\ONE\\', '\\\\server\\SHARE\\two\\', '/src/one', 'D:/removed']);
});

test('dragging one project section preserves the other section positions after unpinning', () => {
  const saved = Object.freeze(['A', 'B', 'C', 'D']);
  const pins = new Set(['B', 'D']);
  const movedRegular = reorderSidebarProjectPositions(saved, ['C', 'A']);
  assert.deepEqual(orderSidebarProjects(saved, movedRegular, pins), ['B', 'D', 'C', 'A']);
  assert.deepEqual(orderSidebarProjects(saved, movedRegular, new Set()), ['C', 'B', 'A', 'D']);
  const movedPinned = reorderSidebarProjectPositions(movedRegular, ['D', 'B']);
  assert.deepEqual(orderSidebarProjects(saved, movedPinned, pins), ['D', 'B', 'C', 'A']);
  assert.deepEqual(orderSidebarProjects(saved, movedPinned, new Set()), ['C', 'D', 'A', 'B']);
  assert.deepEqual(reorderSidebarProjectPositions(saved, ['A', 'C']), saved, 'dropping back in place must not move pinned projects to the beginning of saved order');
});

test('project reordering retains unavailable positions and normalizes reordered Windows aliases', () => {
  const saved = ['D:/one', 'D:/offline', 'D:/pinned', 'd:\\two\\', 'd:\\ONE\\'];
  assert.deepEqual(reorderSidebarProjectPositions(saved, ['D:/Two', 'd:/ONE', 'D:/new', 'd:\\two\\']), [
    'D:/Two', 'D:/offline', 'D:/pinned', 'd:/ONE', 'D:/new',
  ]);
  assert.deepEqual(reorderSidebarProjectPositions([], ['new', 'other', 'new']), ['new', 'other']);
});

test('project ordering keeps saved positions across Windows aliases and stale project pins', () => {
  const workspaces = ['D:/Projects/One', 'D:/Projects/Two', 'd:\\projects\\one\\', 'D:/Projects/Three'];
  const saved = ['d:\\projects\\three\\', 'd:\\projects\\two\\', 'D:/removed', 'd:\\projects\\one\\'];
  assert.deepEqual(orderSidebarProjects(workspaces, saved, new Set(['d:\\PROJECTS\\two\\', 'D:/removed'])), [
    'D:/Projects/Two', 'D:/Projects/Three', 'D:/Projects/One',
  ]);
  assert.deepEqual(orderSidebarProjects(workspaces, saved, new Set()), [
    'D:/Projects/Three', 'D:/Projects/Two', 'D:/Projects/One',
  ]);
});

test('collecting sessions uses paths, retaining equal SDK ids in different projects', () => {
  const a = session('/a/one.jsonl', { id: 'same-sdk-id' });
  const b = session('/b/one.jsonl', { id: 'same-sdk-id' });
  const collected = collectSidebarSessions(['a', 'missing', 'b', 'a'], {
    a: [a], b: [b, a], excluded: [session('hidden')],
  });
  assert.deepEqual(paths(collected), ['/a/one.jsonl', '/b/one.jsonl']);
  assert.deepEqual(collected.map((entry) => entry.workspace), ['a', 'b']);
  assert.equal(a.workspace, 'first-project');
});

test('project list excludes the default conversation workspace and deduplicates Windows aliases', () => {
  const workspacePaths = ['C:/Users/me/PiDesktopWorkspace', 'D:/Projects/One', 'd:\\projects\\one\\', '/src/One', '/src/one'];
  assert.deepEqual(sidebarProjectPaths(workspacePaths, 'c:\\users\\me\\pidesktopworkspace\\'), [
    'D:/Projects/One', '/src/One', '/src/one',
  ]);
  assert.deepEqual(sidebarProjectPaths(workspacePaths, null), [
    'C:/Users/me/PiDesktopWorkspace', 'D:/Projects/One', '/src/One', '/src/one',
  ]);
  assert.equal(sidebarWorkspaceKey('C:\\'), sidebarWorkspaceKey('c:/'));
  assert.equal(sidebarWorkspaceKey('\\\\server\\share\\'), sidebarWorkspaceKey('//SERVER/share'));
  assert.notEqual(sidebarWorkspaceKey('/src/One'), sidebarWorkspaceKey('/src/one'));
});

test('project grouping keeps default and unregistered conversations below projects without duplicate pins', () => {
  const home = 'C:/Users/me/PiDesktopWorkspace';
  const workspaces = [home, 'D:/Projects/One', 'D:/Projects/Empty'];
  const sessions = collectSidebarSessions([...workspaces, 'D:/Projects/Removed'], {
    [home]: [session('general'), session('general-pin', { pinned: true })],
    'D:/Projects/One': [session('project'), session('project-pin', { pinned: true })],
    'D:/Projects/Removed': [session('removed')],
  });
  const original = structuredClone(sessions);
  const grouped = buildSidebarProjectGroups([...sessions, sessions[0]], sidebarProjectPaths(workspaces, home));
  assert.deepEqual(grouped.projects.map(project => [project.workspace, paths(project.sessions)]), [
    ['D:/Projects/One', ['project']], ['D:/Projects/Empty', []],
  ]);
  assert.deepEqual(paths(grouped.unassigned), ['general', 'removed']);
  assert.deepEqual(paths(buildSidebarGroups(sessions, []).pinned), ['general-pin', 'project-pin']);
  assert.deepEqual(sessions, original);
});

test('project membership uses exact normalized workspaces and preserves filtering and manual order', () => {
  const sessions = [
    session('manual-general', { workspace: 'home', order: 4 }),
    session('new-general', { workspace: 'home' }),
    session('alias', { workspace: 'd:\\projects\\one\\', order: 2 }),
    session('project', { workspace: 'D:/Projects/One', order: 1 }),
    session('nested', { workspace: 'D:/Projects/One/other', unread: true }),
    session('archived-general', { workspace: 'home', archived: true }),
  ];
  const projectPaths = ['D:/Projects/One', 'd:\\projects\\one'];
  const grouped = buildSidebarProjectGroups(selectActive(sessions), projectPaths);
  assert.deepEqual(grouped.projects.map(project => [project.workspace, paths(project.sessions)]), [
    ['D:/Projects/One', ['project', 'alias']],
  ]);
  assert.deepEqual(paths(grouped.unassigned), ['new-general', 'nested', 'manual-general']);
  const unread = buildSidebarProjectGroups(selectActive(sessions, { filter: 'unread' }), projectPaths);
  assert.deepEqual(paths(unread.unassigned), ['nested']);
  assert.deepEqual(unread.projects[0].sessions, []);
  const archive = buildSidebarProjectGroups(selectActive(sessions, { archived: true }), projectPaths);
  assert.deepEqual(paths(archive.unassigned), ['archived-general']);
});

test('session filters separate archives and apply unread or pinned within that scope', () => {
  const sessions = [session('normal'), session('unread', { unread: true }), session('pin', { pinned: true }),
    session('archive', { archived: true }), session('archive-unread', { archived: true, unread: true }),
    session('archive-pin', { archived: true, pinned: true })];
  assert.deepEqual(paths(selectActive(sessions)), ['normal', 'unread', 'pin']);
  assert.deepEqual(paths(selectActive(sessions, { filter: 'unread' })), ['unread']);
  assert.deepEqual(paths(selectActive(sessions, { filter: 'pinned' })), ['pin']);
  assert.deepEqual(paths(selectActive(sessions, { archived: true })), ['archive', 'archive-unread', 'archive-pin']);
  assert.deepEqual(paths(selectActive(sessions, { archived: true, filter: 'unread' })), ['archive-unread']);
  assert.deepEqual(paths(selectActive(sessions, { archived: true, filter: 'pinned' })), ['archive-pin']);
});

test('time sorting is stable and puts invalid timestamps last in both directions', () => {
  const sessions = [session('bad-a', { modified: 'invalid' }), session('old', { modified: '2026-01-01' }),
    session('same-a'), session('bad-b', { modified: '' }), session('same-b')];
  assert.deepEqual(paths(selectActive(sessions)), ['same-a', 'same-b', 'old', 'bad-a', 'bad-b']);
  assert.deepEqual(paths(selectActive(sessions, { sort: 'oldest' })), ['old', 'same-a', 'same-b', 'bad-a', 'bad-b']);
  assert.deepEqual(paths(sessions), ['bad-a', 'old', 'same-a', 'bad-b', 'same-b']);
});

test('groups preserve empty groups, separate pins, and never duplicate sessions', () => {
  const sessions = [session('first'), session('pin', { pinned: true }), session('ungrouped'), session('first')];
  const groups = [
    { id: 'a', name: 'First group', sessionPaths: ['first', 'pin', 'not-loaded'] },
    { id: 'b', name: 'Second group', sessionPaths: ['first'] },
    { id: 'empty', name: 'Empty', sessionPaths: [] },
  ];
  const original = structuredClone(groups);
  const result = buildSidebarGroups(sessions, groups);
  assert.deepEqual(paths(result.pinned), ['pin']);
  assert.deepEqual(result.groups.map((group) => [group.id, group.name, paths(group.sessions)]), [
    ['a', 'First group', ['first']], ['b', 'Second group', []], ['empty', 'Empty', []],
  ]);
  assert.deepEqual(paths(result.ungrouped), ['ungrouped']);
  assert.deepEqual(groups, original);
});

test('archive and pin projections preserve membership for restore and unpin', () => {
  const archived = session('archived', { archived: true });
  const pinned = session('pinned', { pinned: true });
  const group = { id: 'a', name: 'Saved group', sessionPaths: ['archived', 'pinned'] };
  const projected = buildSidebarGroups(selectActive([archived, pinned]), [group]);
  assert.deepEqual(paths(projected.pinned), ['pinned']);
  assert.deepEqual(projected.groups[0].sessions, []);
  const restored = buildSidebarGroups(selectActive([
    { ...archived, archived: false }, { ...pinned, pinned: false },
  ]), [group]);
  assert.deepEqual(paths(restored.groups[0].sessions), ['archived', 'pinned']);
  assert.deepEqual(group.sessionPaths, ['archived', 'pinned']);
  assert.deepEqual(paths(buildSidebarGroups(restored.groups[0].sessions, []).ungrouped), ['archived', 'pinned']);
});

test('date groups use local midnight boundaries and preserve the supplied row order', () => {
  const now = new Date(2026, 8, 24, 13, 0);
  const local = (day, hour = 0, minute = 0) => new Date(2026, 8, day, hour, minute).toISOString();
  const grouped = groupSessionsByDate([
    session('old', { modified: local(17, 23, 59) }),
    session('today-first', { modified: local(24) }),
    session('week', { modified: local(18) }),
    session('yesterday-end', { modified: local(23, 23, 59) }),
    session('today-second', { modified: local(24, 12) }),
    session('yesterday-start', { modified: local(23) }),
    session('invalid', { modified: 'invalid' }),
  ], now);
  assert.deepEqual(grouped.map((group) => [group.id, paths(group.sessions)]), [
    ['today', ['today-first', 'today-second']], ['yesterday', ['yesterday-end', 'yesterday-start']],
    ['week', ['week']], ['older', ['old', 'invalid']],
  ]);
  assert.deepEqual(groupSessionsByDate([], now), []);
});

test('date groups remain on calendar dates across spring and fall DST transitions', () => {
  const moduleUrl = new URL('../packages/ui/src/sidebarOrganization.ts', import.meta.url).href;
  const code = `
    import assert from 'node:assert/strict';
    import { groupSessionsByDate } from ${JSON.stringify(moduleUrl)};
    const check = (year, month, day) => {
      const now = new Date(year, month, day, 12);
      const previous = new Date(year, month, day - 1, 0, 15);
      const before = new Date(year, month, day - 2, 23, 45);
      const groups = groupSessionsByDate([
        { path: 'previous', modified: previous.toISOString() },
        { path: 'before', modified: before.toISOString() },
      ], now);
      assert.deepEqual(groups.map(group => [group.id, group.sessions.map(s => s.path)]), [
        ['yesterday', ['previous']], ['week', ['before']],
      ]);
    };
    assert.notEqual(new Date(2026, 2, 8).getTimezoneOffset(), new Date(2026, 2, 9).getTimezoneOffset());
    check(2026, 2, 9);
    check(2026, 10, 2);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('running sessions form a stable top tier ordered by creation, never by modified (zcode two-tier)', () => {
  const sessions = [
    session('idle-old', { modified: '2026-09-20T08:00:00Z', created: '2026-09-01T08:00:00Z' }),
    session('run-new', { modified: '2026-09-24T09:00:00Z', created: '2026-09-10T08:00:00Z', runtime: { phase: 'running' } }),
    session('idle-new', { modified: '2026-09-24T10:00:00Z', created: '2026-09-05T08:00:00Z' }),
    session('waiting', { modified: '2026-09-24T12:00:00Z', created: '2026-09-02T08:00:00Z', runtime: { phase: 'waiting-input' } }),
    session('run-old', { modified: '2026-09-24T07:00:00Z', created: '2026-09-15T08:00:00Z', runtime: { phase: 'running' } }),
    session('run-nocreated', { modified: '2026-09-24T11:00:00Z', runtime: { phase: 'running' } }),
  ];
  // Running tier floats to the top and sorts by created desc (entries without
  // created keep insertion order after the dated ones); waiting stays in the
  // time tier; idle sorts by modified desc as before.
  assert.deepEqual(paths(selectActive(sessions)), ['run-old', 'run-new', 'run-nocreated', 'waiting', 'idle-new', 'idle-old']);
  // The oldest preference only flips the time tier; the running tier keeps its
  // stable creation ordering either way.
  assert.deepEqual(paths(selectActive(sessions, { sort: 'oldest' })), ['run-old', 'run-new', 'run-nocreated', 'idle-old', 'idle-new', 'waiting']);
  // Regression: turn-boundary modified bumps on any running conversation must
  // never reorder the list while several conversations run concurrently.
  const churned = sessions.map((entry) => entry.runtime?.phase === 'running'
    ? { ...entry, modified: '2026-09-24T23:59:59Z' } : entry);
  assert.deepEqual(paths(selectActive(churned)), ['run-old', 'run-new', 'run-nocreated', 'waiting', 'idle-new', 'idle-old'],
    'modified churn on running rows does not move them');
  // When a run settles it re-enters the time tier exactly once, at its new position.
  const settled = churned.map((entry) => entry.path === 'run-new' ? { ...entry, runtime: undefined } : entry);
  assert.deepEqual(paths(selectActive(settled)), ['run-old', 'run-nocreated', 'run-new', 'waiting', 'idle-new', 'idle-old']);
});
