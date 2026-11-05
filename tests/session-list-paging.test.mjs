import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { useChatStore } from '../packages/ui/src/store.ts';

// 分页会话列表（refreshSessionCache → bridge.listSessionsPage）：
// 首页先渲染、续页后台补齐；导航/新请求代次（sessionListRequests）与
// 快照代次（revision/total）不一致时迟到的页必须被丢弃，不得写回侧栏。

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const WORKSPACE = 'C:\\review\\paging';
const FIRST_PAGE = 100; // store 侧首页大小（SESSION_LIST_FIRST_PAGE）
const row = (id, extra = {}) => ({
  path: `${WORKSPACE}\\${id}.jsonl`,
  id,
  name: id,
  firstMessage: id,
  modified: `2026-10-0${(Number(id) % 9) + 1}T00:00:00Z`,
  messageCount: 2,
  ...extra,
});
const rows = (count) => Array.from({ length: count }, (_, index) => row(String(index + 1)));
const paths = (sessions) => sessions.map((session) => session.path);
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** 按源数组切片的分页桥；gate(offset) 可挂起某一页，pageOverrides 可改写某页返回值。 */
function pagedBridge(source, { gate = () => null, pageOverrides = {} } = {}) {
  const calls = [];
  const bridge = {
    listSessions: async () => {
      calls.push(['full']);
      return structuredClone(source);
    },
    listSessionsPage: async (cwd, offset, limit) => {
      calls.push(['page', offset, limit]);
      const hold = gate(offset);
      if (hold) await hold;
      const page = source.slice(offset, offset + limit);
      const result = { sessions: structuredClone(page), total: source.length,
        hasMore: offset + page.length < source.length, revision: 1 };
      return pageOverrides[offset] ? pageOverrides[offset](result) : result;
    },
    onAgentEvent: () => () => {},
  };
  return { bridge, calls };
}

function install(bridge) {
  useChatStore.setState(useChatStore.getInitialState(), true);
  useChatStore.setState({ bridge, cwd: WORKSPACE, sessionPath: `${WORKSPACE}\\1.jsonl` });
}

const listState = () => {
  const state = useChatStore.getState();
  return { sessions: state.sessionsByWorkspace[WORKSPACE] ?? [], phase: state.workspaceSessionRequests[WORKSPACE]?.phase };
};

beforeEach(() => {
  useChatStore.setState(useChatStore.getInitialState(), true);
});

test('首页先渲染，续页后台补齐为完整列表', async () => {
  const source = rows(FIRST_PAGE + 80);
  const hold = deferred();
  const { bridge, calls } = pagedBridge(source, { gate: (offset) => (offset === 0 ? null : hold.promise) });
  install(bridge);

  const refreshing = useChatStore.getState().refreshWorkspaceSessions(WORKSPACE);
  await settle();
  const early = listState();
  assert.equal(early.sessions.length, FIRST_PAGE, '续页未返回前先渲染首页');
  assert.equal(early.phase, 'refreshing');

  hold.resolve();
  await refreshing;
  const done = listState();
  assert.deepEqual(paths(done.sessions), paths(source), '续页按同一快照顺序拼回完整列表');
  assert.equal(done.phase, 'idle');
  assert.deepEqual(calls.filter(([kind]) => kind === 'page').map(([, offset]) => offset), [0, FIRST_PAGE]);
});

test('单页可容纳时不发起续页请求', async () => {
  const source = rows(3);
  const { bridge, calls } = pagedBridge(source);
  install(bridge);
  await useChatStore.getState().refreshWorkspaceSessions(WORKSPACE);
  const done = listState();
  assert.deepEqual(paths(done.sessions), paths(source));
  assert.equal(done.phase, 'idle');
  assert.deepEqual(calls, [['page', 0, FIRST_PAGE]]);
});

test('快照 revision 或 total 变化的续页被丢弃，不清空已渲染页', async () => {
  for (const override of [
    (page) => ({ ...page, revision: page.revision + 1 }),
    (page) => ({ ...page, total: page.total + 1 }),
  ]) {
    const source = rows(FIRST_PAGE + 10);
    const hold = deferred();
    const { bridge } = pagedBridge(source, {
      gate: (offset) => (offset === 0 ? null : hold.promise),
      pageOverrides: { [FIRST_PAGE]: override },
    });
    install(bridge);
    const refreshing = useChatStore.getState().refreshWorkspaceSessions(WORKSPACE);
    await settle();
    assert.equal(listState().sessions.length, FIRST_PAGE);
    hold.resolve();
    await refreshing;
    assert.equal(listState().sessions.length, FIRST_PAGE, '不一致的续页不得拼进列表');
    assert.equal(listState().phase, 'refreshing', '中止不清空已渲染数据');
  }
});

test('被新请求取代的迟到续页不得写回', async () => {
  const tagged = (tag) => rows(FIRST_PAGE + 20).map((session) => ({ ...session, id: `${tag}-${session.id}`, path: `${WORKSPACE}\\${tag}-${session.id}.jsonl` }));
  const sources = [tagged('g1'), tagged('g2')];
  const hold = deferred();
  let held = false;
  let generation = 0;
  // 首页递增代次；续页在发出时绑定当时的代次（旧刷新的续页先于新刷新的首页发出）。
  const bridge = {
    async listSessionsPage(cwd, offset, limit) {
      if (offset === 0) generation += 1;
      const source = sources[generation - 1];
      if (offset > 0 && !held) { held = true; await hold.promise; }
      const page = source.slice(offset, offset + limit);
      return { sessions: structuredClone(page), total: source.length,
        hasMore: offset + page.length < source.length, revision: generation };
    },
    onAgentEvent: () => () => {},
  };
  install(bridge);
  const first = useChatStore.getState().refreshWorkspaceSessions(WORKSPACE);
  await settle();
  assert.equal(listState().sessions.length, FIRST_PAGE);

  // 同工作区的新刷新使旧请求失代；旧代次的续页随后才返回。
  const second = useChatStore.getState().refreshWorkspaceSessions(WORKSPACE);
  await settle();
  hold.resolve();
  await Promise.all([first, second]);
  const done = listState();
  assert.equal(done.sessions.length, FIRST_PAGE + 20, '只有有效代次的续页落盘');
  assert.ok(done.sessions.every((session) => session.id.startsWith('g2-')), '失代续页的数据不得写回');
  assert.equal(done.phase, 'idle');
});

test('无 listSessionsPage 的旧桥回退到全量 listSessions', async () => {
  const source = rows(4);
  const bridge = {
    listSessions: async () => structuredClone(source),
    onAgentEvent: () => () => {},
  };
  install(bridge);
  await useChatStore.getState().refreshWorkspaceSessions(WORKSPACE);
  const done = listState();
  assert.deepEqual(paths(done.sessions), paths(source));
  assert.equal(done.phase, 'idle');
});
