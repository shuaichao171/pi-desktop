import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  buildSidebarGroups,
  collectSidebarSessions,
  groupSessionsByDate,
  readSidebarPreferences,
  saveSidebarPreferences,
  selectSidebarSessions,
} from '../packages/ui/src/sidebarOrganization.ts';

const defaults = { mode: 'grouped', projectView: 'project', sort: 'newest', filter: 'all', collapsed: [] };
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
  const preferred = { mode: 'project', projectView: 'timeline', sort: 'oldest', filter: 'unread', collapsed: ['project:a', 'group:b'] };
  saveSidebarPreferences(preferred, storage);
  assert.deepEqual(readSidebarPreferences(storage), preferred);
  stored = '{invalid';
  assert.deepEqual(readSidebarPreferences(storage), defaults);
  assert.deepEqual(readSidebarPreferences({ getItem() { throw new Error('blocked'); } }), defaults);
  assert.doesNotThrow(() => saveSidebarPreferences(preferred, { setItem() { throw new Error('quota'); } }));
});

test('sidebar preference validation preserves valid fields and supplies independent defaults', () => {
  const read = (value) => readSidebarPreferences({ getItem: () => JSON.stringify(value) });
  for (const value of [null, [], true, 7, 'wrong']) assert.deepEqual(read(value), defaults);
  assert.deepEqual(read({ mode: 'wrong', projectView: 'timeline', sort: 7, filter: 'pinned', collapsed: ['group:a', null, '', 1, 'group:a', 'group:b'] }), {
    ...defaults, projectView: 'timeline', filter: 'pinned', collapsed: ['group:a', 'group:b'],
  });
  const first = read(null);
  first.collapsed.push('changed');
  assert.deepEqual(read(null), defaults);
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
