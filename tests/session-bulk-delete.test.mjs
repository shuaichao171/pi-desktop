import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { useChatStore } from '../packages/ui/src/store.ts';

// The archive view aggregates conversations across every workspace, so the
// bulk-delete staleness precheck must revalidate each selection against its
// owning workspace's listSessions snapshot. Regression: the precheck used to
// consult only the active cwd, so every archived conversation from another
// workspace was reported stale ("选择已过期，已跳过") and never deleted.
const PROJECT_A = 'C:\\review\\project-a';
const PROJECT_B = 'C:\\review\\project-b';
const row = (workspace, id, extra = {}) => ({
  path: `${workspace}\\${id}.jsonl`,
  id,
  name: id,
  firstMessage: id,
  modified: '2026-10-01T00:00:00Z',
  messageCount: 2,
  ...extra,
});

function installBridge(rowsByWorkspace) {
  const listCalls = [];
  const deleted = [];
  const bridge = {
    listSessions: async (cwd) => {
      listCalls.push(cwd);
      return structuredClone(rowsByWorkspace.get(cwd) ?? []);
    },
    deleteSession: async (path) => {
      if (![...rowsByWorkspace.values()].flat().some((row) => row.path === path)) throw new Error('会话不存在');
      deleted.push(path);
      for (const rows of rowsByWorkspace.values()) {
        const index = rows.findIndex((row) => row.path === path);
        if (index >= 0) rows.splice(index, 1);
      }
    },
    onAgentEvent: () => () => {},
  };
  return { bridge, listCalls, deleted };
}

beforeEach(() => {
  useChatStore.setState(useChatStore.getInitialState(), true);
});

test('bulk archive deletion validates each selection against its owning workspace', async () => {
  const rowsA = [row(PROJECT_A, 'arch-a', { archived: true }), row(PROJECT_A, 'open-a')];
  const rowsB = [row(PROJECT_B, 'arch-b', { archived: true }), row(PROJECT_B, 'arch-b-stale')];
  const { bridge, listCalls, deleted } = installBridge(new Map([[PROJECT_A, rowsA], [PROJECT_B, rowsB]]));
  useChatStore.setState({
    bridge,
    cwd: PROJECT_A,
    sessionPath: `${PROJECT_A}\\open-a.jsonl`,
    sessionsByWorkspace: { [PROJECT_A]: structuredClone(rowsA), [PROJECT_B]: structuredClone(rowsB) },
    sessions: structuredClone(rowsA),
  });

  const result = await useChatStore.getState().deleteSessions(
    [`${PROJECT_A}\\arch-a.jsonl`, `${PROJECT_B}\\arch-b.jsonl`, `${PROJECT_B}\\arch-b-stale.jsonl`],
    { expectArchived: true },
  );

  assert.deepEqual(result.deleted.sort(), [`${PROJECT_A}\\arch-a.jsonl`, `${PROJECT_B}\\arch-b.jsonl`].sort());
  assert.deepEqual(Object.keys(result.failed), []);
  assert.deepEqual(Object.keys(result.skipped), [`${PROJECT_B}\\arch-b-stale.jsonl`]);
  assert.deepEqual(deleted.sort(), [`${PROJECT_A}\\arch-a.jsonl`, `${PROJECT_B}\\arch-b.jsonl`].sort());
  // One authoritative snapshot per distinct owning workspace, then one batch
  // refresh of the active workspace's list.
  assert.deepEqual(listCalls, [PROJECT_A, PROJECT_B, PROJECT_A]);
});

test('a workspace whose listing fails surfaces per-path failures without sinking the batch', async () => {
  const rowsA = [row(PROJECT_A, 'arch-a', { archived: true })];
  const rowsB = [row(PROJECT_B, 'arch-b', { archived: true })];
  const deleted = [];
  const bridge = {
    listSessions: async (cwd) => {
      if (cwd === PROJECT_B) throw new Error('未知工作区');
      return structuredClone(rowsA);
    },
    deleteSession: async (path) => { deleted.push(path); },
    onAgentEvent: () => () => {},
  };
  useChatStore.setState({
    bridge,
    cwd: PROJECT_A,
    sessionPath: `${PROJECT_A}\\open-a.jsonl`,
    sessionsByWorkspace: { [PROJECT_A]: structuredClone(rowsA), [PROJECT_B]: structuredClone(rowsB) },
    sessions: structuredClone(rowsA),
  });

  const result = await useChatStore.getState().deleteSessions(
    [`${PROJECT_A}\\arch-a.jsonl`, `${PROJECT_B}\\arch-b.jsonl`],
    { expectArchived: true },
  );

  assert.deepEqual(result.deleted, [`${PROJECT_A}\\arch-a.jsonl`]);
  assert.deepEqual(result.failed, { [`${PROJECT_B}\\arch-b.jsonl`]: '未知工作区' });
  assert.deepEqual(result.skipped, {});
  assert.deepEqual(deleted, [`${PROJECT_A}\\arch-a.jsonl`]);
});
