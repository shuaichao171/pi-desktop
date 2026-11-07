import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { useChatStore } from '../packages/ui/src/store.ts';

// 归档乐观更新（updateSessionMeta → applySessionMetaOverlay）与并发列表刷新
// （refreshSessionCache → bridge.listSessionsPage）的竞态回归：
// 在归档 IPC 落地之前，早于归档发起、响应晚到的刷新 serve 于归档提交之前，
// 落地时必须重放仍在途的乐观翻转，而不是用陈旧快照整表覆盖缓存 —— 否则
// 已归档的行会闪回未归档列表，快速连续归档时反复跳动（会话列表显示异常）。

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const WORKSPACE = 'C:\\review\\archive-race';
const row = (id, extra = {}) => ({
  path: `${WORKSPACE}\\${id}.jsonl`,
  id,
  name: id,
  firstMessage: id,
  modified: `2026-10-01T00:00:00Z`,
  messageCount: 2,
  ...extra,
});
const settle = () => new Promise((resolve) => setImmediate(resolve));
const cachedRow = (id) => useChatStore.getState().sessionsByWorkspace[WORKSPACE]?.find((session) => session.id === id);

/** 模拟主进程：meta 提交后列表才带标记；挂起中的页在释放时返回「serve 时刻」的内容。 */
function makeBridge(source, { metaHold, failMeta, holdPage2 = false } = {}) {
  const meta = new Map();
  const serve = () => structuredClone(source).map((session) => ({ ...session, ...(meta.get(session.path) ?? {}) }));
  let pages = 0;
  const holds = [];
  const bridge = {
    listSessionsPage: async () => {
      pages += 1;
      const snapshot = serve(); // 内容在 serve 时刻固定
      const hold = holdPage2 && pages === 2 ? deferred() : null; // 第 2 页（竞态刷新）挂起
      if (hold) holds.push(hold);
      if (hold) await hold.promise;
      return { sessions: snapshot, total: snapshot.length, hasMore: false, revision: pages };
    },
    updateSessionMeta: async (path, patch) => {
      if (metaHold) await metaHold.promise;
      if (failMeta) throw failMeta;
      meta.set(path, { ...(meta.get(path) ?? {}), ...patch });
    },
    onAgentEvent: () => () => {},
  };
  return { bridge, meta, releaseStalePage: () => holds.forEach((hold) => hold.resolve()), pages: () => pages };
}

beforeEach(() => {
  useChatStore.setState(useChatStore.getInitialState(), true);
});

test('归档 IPC 在途时，先于归档发起的陈旧刷新落地会重放乐观归档标记', async () => {
  const source = [row('a'), row('b'), row('c')];
  const metaHold = deferred();
  const { bridge, releaseStalePage, pages } = makeBridge(source, { metaHold, holdPage2: true });
  useChatStore.setState({ bridge, cwd: WORKSPACE, sessionPath: `${WORKSPACE}\\a.jsonl` });

  // 0) 填充缓存。
  await useChatStore.getState().refreshWorkspaceSessions(WORKSPACE);
  assert.equal(cachedRow('a').archived, undefined);
  assert.equal(pages(), 1);

  // 1) 一个先于归档发起的刷新在途（serve 时刻早于归档提交，响应未回）。
  const staleRefresh = useChatStore.getState().refreshWorkspaceSessions(WORKSPACE);
  await settle();
  assert.equal(pages(), 2);

  // 2) 用户归档 a：乐观翻转缓存行（未归档视图应立即隐藏 a）。
  const archiving = useChatStore.getState().updateSessionMeta(`${WORKSPACE}\\a.jsonl`, { archived: true });
  await settle();
  assert.equal(cachedRow('a').archived, true, '乐观翻转后 a 应为已归档');

  // 3) 陈旧刷新的响应此时才落地 —— 归档触发的刷新要等 IPC 完成才发起，
  //    落地必须重放在途的乐观翻转，不得用陈旧快照抹掉。
  releaseStalePage();
  await staleRefresh;
  assert.equal(cachedRow('a').archived, true, '陈旧刷新落地后乐观归档标记必须保留');

  // 4) IPC 完成后的权威刷新同样收敛。
  metaHold.resolve();
  await archiving;
  assert.equal(cachedRow('a').archived, true);
});

test('归档 IPC 在途时，sessions-changed 触发的并发刷新同样保留乐观标记', async () => {
  const source = [row('a'), row('b')];
  const metaHold = deferred();
  const { bridge } = makeBridge(source, { metaHold });
  useChatStore.setState({ bridge, cwd: WORKSPACE, sessionPath: `${WORKSPACE}\\a.jsonl` });

  // 填充缓存后归档（乐观翻转生效），IPC 在途期间 agent 的 sessions-changed
  // 事件触发一次全量刷新：serve 快照读于归档提交之前，落地时必须重放。
  await useChatStore.getState().refreshWorkspaceSessions(WORKSPACE);
  const archiving = useChatStore.getState().updateSessionMeta(`${WORKSPACE}\\a.jsonl`, { archived: true });
  await settle();
  assert.equal(cachedRow('a').archived, true);

  await useChatStore.getState().refreshWorkspaceSessions(WORKSPACE);
  assert.equal(cachedRow('a').archived, true, '并发刷新落地后乐观归档标记必须保留');

  metaHold.resolve();
  await archiving;
  assert.equal(cachedRow('a').archived, true);
});

test('归档 IPC 失败时，陈旧刷新落地后的乐观标记仍被正确回滚', async () => {
  const source = [row('a'), row('b')];
  const failure = new Error('会话更新失败');
  const { bridge } = makeBridge(source, { failMeta: failure });
  useChatStore.setState({ bridge, cwd: WORKSPACE, sessionPath: `${WORKSPACE}\\a.jsonl` });

  await useChatStore.getState().refreshWorkspaceSessions(WORKSPACE);
  await assert.rejects(
    useChatStore.getState().updateSessionMeta(`${WORKSPACE}\\a.jsonl`, { archived: true }),
    /会话更新失败/,
  );
  assert.equal(cachedRow('a').archived, undefined, '失败后回滚为未归档');

  // 失败后 pending 已清空：再来的刷新按权威数据落地，不重放旧翻转。
  await useChatStore.getState().refreshWorkspaceSessions(WORKSPACE);
  assert.equal(cachedRow('a').archived, undefined, '失败后刷新不得重放已清除的乐观标记');
});

test('同会话连续两次翻转（归档后立即取消归档）时，重放以后一次为准', async () => {
  const source = [row('a'), row('b')];
  const metaHold = deferred();
  const { bridge } = makeBridge(source, { metaHold });
  useChatStore.setState({ bridge, cwd: WORKSPACE, sessionPath: `${WORKSPACE}\\a.jsonl` });

  await useChatStore.getState().refreshWorkspaceSessions(WORKSPACE);
  const archiving = useChatStore.getState().updateSessionMeta(`${WORKSPACE}\\a.jsonl`, { archived: true });
  await settle();
  const unarchiving = useChatStore.getState().updateSessionMeta(`${WORKSPACE}\\a.jsonl`, { archived: false });
  await settle();

  // 两次 IPC 均在途时陈旧刷新落地：重放的合成结果 = 后一次翻转（未归档）。
  await useChatStore.getState().refreshWorkspaceSessions(WORKSPACE);
  assert.equal(cachedRow('a').archived, false, '重放以后一次在途翻转为准');

  metaHold.resolve();
  await Promise.all([archiving, unarchiving]);
  assert.equal(cachedRow('a').archived, false, '两次提交完成后收敛为取消归档');
});
