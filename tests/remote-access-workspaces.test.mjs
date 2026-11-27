import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  groupRemoteWorkspaces,
  isRemoteConversationWorkspace,
  mergeRemoteSessionLists,
  remoteWorkspaceKey,
} = await import('../packages/shared/src/remoteClient.ts');

const session = (path, modified, extra = {}) => ({ path, id: path, firstMessage: path, modified, messageCount: 1, ...extra });

test('remote workspace keys follow the desktop sidebar aliasing rules', () => {
  assert.equal(remoteWorkspaceKey('C:\\Users\\Me\\Repo\\'), 'c:/users/me/repo');
  assert.equal(remoteWorkspaceKey('\\\\NAS\\Share\\Proj'), '//nas/share/proj');
  // POSIX paths stay case-sensitive.
  assert.notEqual(remoteWorkspaceKey('/home/me/Repo'), remoteWorkspaceKey('/home/me/repo'));
  assert.equal(isRemoteConversationWorkspace('c:/users/me/pidesktopworkspace/conversation-1', ['C:\\Users\\Me\\PiDesktopWorkspace\\conversation-1']), true);
  assert.equal(isRemoteConversationWorkspace('C:\\Users\\Me\\Repo', ['C:\\Users\\Me\\PiDesktopWorkspace']), false);
});

test('groupRemoteWorkspaces keeps project tabs and moves conversation folders under Unassigned', () => {
  const groups = groupRemoteWorkspaces(
    [
      'E:\\work\\app',
      'C:\\Users\\Me\\PiDesktopWorkspace\\conversation-20261127-1',
      'e:/work/app/',
      'C:\\Users\\Me\\PiDesktopWorkspace\\conversation-20261127-2',
      'D:\\notes',
    ],
    ['c:/users/me/pidesktopworkspace/conversation-20261127-1', 'C:\\Users\\Me\\PiDesktopWorkspace\\conversation-20261127-2', 'C:\\Users\\Me\\PiDesktopWorkspace'],
  );
  // Duplicate spellings collapse to the first one, which is what the host's RPCs expect back.
  assert.deepEqual(groups.projects, ['E:\\work\\app', 'D:\\notes']);
  assert.deepEqual(groups.conversations, [
    'C:\\Users\\Me\\PiDesktopWorkspace\\conversation-20261127-1',
    'C:\\Users\\Me\\PiDesktopWorkspace\\conversation-20261127-2',
  ]);
  // An older desktop without listConversationWorkspaces: every folder stays a project tab.
  assert.deepEqual(groupRemoteWorkspaces(['/a', '/b'], []), { projects: ['/a', '/b'], conversations: [] });
});

test('mergeRemoteSessionLists dedupes by path and orders pinned, then newest first', () => {
  const merged = mergeRemoteSessionLists([
    [session('/c1/a.jsonl', '2026-11-27T08:00:00.000Z'), session('/c1/b.jsonl', '2026-11-20T08:00:00.000Z', { pinned: true })],
    undefined,
    [session('/c2/c.jsonl', '2026-11-27T09:00:00.000Z'), session('/c1/a.jsonl', '2026-11-27T08:00:00.000Z')],
    [session('/c3/d.jsonl', 'not a date')],
  ]);
  assert.deepEqual(merged.map((s) => s.path), ['/c1/b.jsonl', '/c2/c.jsonl', '/c1/a.jsonl', '/c3/d.jsonl']);
});
