import assert from 'node:assert/strict';
import { test } from 'node:test';

const STORAGE_KEY = 'pi-desktop:operation-notice-timeout';
let importNumber = 0;

function memoryStorage(initial) {
  const values = new Map(initial === undefined ? [] : [[STORAGE_KEY, initial]]);
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

async function withStore(storage, run, blocked = false) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const target = new EventTarget();
  Object.defineProperty(target, 'localStorage', blocked
    ? { get() { throw new Error('Storage disabled'); } }
    : { value: storage });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target });
  try {
    const store = await import(`../packages/ui/src/operationNoticeTimeout.ts?test=${++importNumber}`);
    await run(store, target);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete globalThis.window;
  }
}

test('notice duration defaults to 5s and normalizes stored values', async () => {
  for (const [saved, expected] of [
    [undefined, 5], ['5', 5], ['0', 0], ['3', 3], ['10', 10], ['30', 30],
    ['3.7', 3], ['-1', 5], ['', 5], [' 7 ', 7], ['true', 5], ['soon', 5], ['99999', 3600],
  ]) {
    await withStore(memoryStorage(saved), store => assert.equal(store.getOperationNoticeTimeoutSeconds(), expected, `stored ${JSON.stringify(saved)}`));
  }
  await withStore(memoryStorage(), store => {
    assert.equal(store.normalizeOperationNoticeTimeoutSeconds(null), 5);
    assert.equal(store.normalizeOperationNoticeTimeoutSeconds(undefined), 5);
    assert.equal(store.normalizeOperationNoticeTimeoutSeconds(true), 5);
    assert.equal(store.normalizeOperationNoticeTimeoutSeconds(Number.NaN), 5);
    assert.equal(store.normalizeOperationNoticeTimeoutSeconds(12), 12);
  });
});

test('a zero-second preference and pending work never auto-dismiss', async () => {
  await withStore(memoryStorage(), store => {
    assert.equal(store.operationNoticeTimeoutMs('success', 5), 5_000);
    assert.equal(store.operationNoticeTimeoutMs('error', 5), 10_000, 'failures stay twice as long');
    assert.equal(store.operationNoticeTimeoutMs('error', 30), 60_000);
    assert.equal(store.operationNoticeTimeoutMs('pending', 5), null, 'a running operation keeps its card');
    assert.equal(store.operationNoticeTimeoutMs('success', 0), null, '不限 waits for the close button');
    assert.equal(store.operationNoticeTimeoutMs('error', 0), null);
    assert.equal(store.operationNoticeTimeoutMs('pending', 0), null);
    assert.equal(store.operationNoticeTimeoutMs('success', -1), 5_000, 'unusable values fall back to the default');
    assert.equal(store.operationNoticeTimeoutMs('error', 2), 4_000);
  });
});

test('changes update every subscriber immediately and persist across reloads', async () => {
  const storage = memoryStorage();
  await withStore(storage, store => {
    const settingsChanges = [];
    const noticeChanges = [];
    const unsubscribeSettings = store.subscribeOperationNoticeTimeout(() => settingsChanges.push(store.getOperationNoticeTimeoutSeconds()));
    const unsubscribeNotices = store.subscribeOperationNoticeTimeout(() => noticeChanges.push(store.getOperationNoticeTimeoutSeconds()));
    assert.equal(store.setOperationNoticeTimeoutSeconds(10), true);
    assert.equal(storage.getItem(STORAGE_KEY), '10');
    assert.deepEqual(settingsChanges, [10]);
    assert.deepEqual(noticeChanges, [10]);
    assert.equal(store.setOperationNoticeTimeoutSeconds(10), true);
    assert.deepEqual(settingsChanges, [10], 'unchanged values do not trigger redundant renders');
    unsubscribeSettings();
    assert.equal(store.setOperationNoticeTimeoutSeconds(0), true);
    assert.deepEqual(settingsChanges, [10]);
    assert.deepEqual(noticeChanges, [10, 0]);
    unsubscribeNotices();
    assert.equal(store.setOperationNoticeTimeoutSeconds(3), true);
  });
  await withStore(storage, store => assert.equal(store.getOperationNoticeTimeoutSeconds(), 3));
});

test('unavailable storage preserves the current session preference and reports write failure', async () => {
  for (const [storage, blocked] of [
    [undefined, false],
    [null, true],
    [{ getItem() { throw new Error('Read denied'); }, setItem() { throw new Error('Write denied'); } }, false],
    [{ getItem: () => '5', setItem() { throw new Error('Quota exceeded'); } }, false],
  ]) {
    await withStore(storage, store => {
      const updates = [];
      assert.equal(store.getOperationNoticeTimeoutSeconds(), 5);
      const unsubscribe = store.subscribeOperationNoticeTimeout(() => updates.push(store.getOperationNoticeTimeoutSeconds()));
      assert.equal(store.setOperationNoticeTimeoutSeconds(30), false);
      assert.equal(store.getOperationNoticeTimeoutSeconds(), 30);
      assert.deepEqual(updates, [30]);
      unsubscribe();
      assert.equal(store.getOperationNoticeTimeoutSeconds(), 30, 'remounting consumers keeps the in-memory preference');
    }, blocked);
  }
});

test('saving the same value retries persistence after storage recovers', async () => {
  const storage = memoryStorage();
  const setItem = storage.setItem;
  storage.setItem = () => { throw new Error('Quota exceeded'); };
  await withStore(storage, store => {
    assert.equal(store.setOperationNoticeTimeoutSeconds(10), false);
    assert.equal(store.getOperationNoticeTimeoutSeconds(), 10);
    storage.setItem = setItem;
    assert.equal(store.setOperationNoticeTimeoutSeconds(10), true);
    assert.equal(storage.getItem(STORAGE_KEY), '10');
  });
});

test('other windows sync only local preference changes and reset to the default on clear', async () => {
  const storage = memoryStorage();
  await withStore(storage, (store, target) => {
    const updates = [];
    const unsubscribe = store.subscribeOperationNoticeTimeout(() => updates.push(store.getOperationNoticeTimeoutSeconds()));
    const dispatch = (key, newValue, storageArea = storage) => target.dispatchEvent(Object.assign(new Event('storage'), { key, newValue, storageArea }));
    dispatch('another-preference', '30');
    dispatch(STORAGE_KEY, '30', memoryStorage());
    assert.equal(store.getOperationNoticeTimeoutSeconds(), 5);
    dispatch(STORAGE_KEY, '30');
    assert.equal(store.getOperationNoticeTimeoutSeconds(), 30);
    dispatch(STORAGE_KEY, '0');
    assert.equal(store.getOperationNoticeTimeoutSeconds(), 0);
    dispatch(null, null);
    assert.equal(store.getOperationNoticeTimeoutSeconds(), 5);
    dispatch(STORAGE_KEY, 'soon');
    assert.equal(store.getOperationNoticeTimeoutSeconds(), 5);
    assert.deepEqual(updates, [30, 0, 5], 'an unusable value keeps the current duration instead of re-publishing it');
    unsubscribe();
  });
});
