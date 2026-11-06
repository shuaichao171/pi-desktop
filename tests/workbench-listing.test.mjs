import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { streamDirectoryListing, WORKBENCH_LISTING_CAP } from '../packages/ui/src/workbenchListing.ts';

const pad = (value) => String(value).padStart(4, '0');

test('large folders list page by page: folders first, stable offsets, nothing dropped', async () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'pi-desktop-listing-'));
  try {
    for (let index = 0; index < 950; index += 1) writeFileSync(join(root, `f${pad(index)}.txt`), 'x');
    for (let index = 0; index < 5; index += 1) mkdirSync(join(root, `d${index}`));
    const { WorkbenchService } = await import('../packages/desktop/src/main/workbenchService.ts');
    const service = new WorkbenchService(() => root, () => {});
    const first = await service.listEntriesPage('', undefined, 0);
    assert.equal(first.total, 955);
    assert.equal(first.entries.length, 400);
    assert.equal(first.nextOffset, 400);
    assert.deepEqual(first.entries.slice(0, 5).map((entry) => entry.name), ['d0', 'd1', 'd2', 'd3', 'd4'], 'folders lead the first page');
    const second = await service.listEntriesPage('', undefined, 400);
    const third = await service.listEntriesPage('', undefined, 800);
    assert.equal(second.nextOffset, 800);
    assert.equal(third.nextOffset, null);
    assert.equal(third.entries.length, 155);
    const names = [...first.entries, ...second.entries, ...third.entries].map((entry) => entry.name);
    assert.equal(new Set(names).size, 955, 'every child appears exactly once across pages');
    assert.equal(names.at(-1), 'f0949.txt');
    assert.deepEqual(await service.listEntries(), first.entries, 'listEntries keeps answering the first page');
    assert.deepEqual(await service.listEntriesPage('', undefined, 2000), { entries: [], nextOffset: null, total: 955 }, 'past the end is empty, not an error');
    for (const offset of [-1, 1.5, Number.NaN]) await assert.rejects(service.listEntriesPage('', undefined, offset), /列表偏移无效/);
    await assert.rejects(service.listEntriesPage('../', undefined, 0), /不属于当前工作区/);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function pagedBridge(total, { pageSize = 400, onPage } = {}) {
  const entries = Array.from({ length: total }, (_, index) => ({ name: `f${pad(index)}`, path: `dir/f${pad(index)}`, kind: 'file' }));
  const calls = [];
  return {
    calls,
    listWorkspaceEntries: async () => { throw new Error('the paged bridge should be used'); },
    listWorkspaceEntriesPage: async (directory, offset) => {
      calls.push([directory, offset]);
      await onPage?.(offset);
      const end = Math.min(total, offset + pageSize);
      return { entries: entries.slice(offset, end), nextOffset: end < total ? end : null, total };
    },
  };
}

test('streamDirectoryListing reports the first page at once and the full folder at the end', async () => {
  const bridge = pagedBridge(950);
  const reports = [];
  const result = await streamDirectoryListing(bridge, 'dir', { isCurrent: () => true, onEntries: (entries, complete) => reports.push([entries.length, complete]) });
  assert.deepEqual(reports, [[400, false], [800, false], [950, true]]);
  assert.deepEqual(bridge.calls, [['dir', 0], ['dir', 400], ['dir', 800]]);
  assert.deepEqual(result, { truncated: false });
});

test('streamDirectoryListing stops at the cap and says so', async () => {
  const bridge = pagedBridge(WORKBENCH_LISTING_CAP + 1000);
  const reports = [];
  const result = await streamDirectoryListing(bridge, 'dir', { isCurrent: () => true, onEntries: (entries, complete) => reports.push([entries.length, complete]) });
  assert.deepEqual(reports.at(-1), [WORKBENCH_LISTING_CAP, true]);
  assert.deepEqual(result, { truncated: true });
  assert.equal(bridge.calls.length, WORKBENCH_LISTING_CAP / 400);
});

test('a superseded listing stops asking and never reports', async () => {
  let current = true;
  const bridge = pagedBridge(950, { onPage: (offset) => { if (offset === 400) current = false; } });
  const reports = [];
  await streamDirectoryListing(bridge, 'dir', { isCurrent: () => current, onEntries: (entries) => reports.push(entries.length) });
  assert.deepEqual(reports, [400], 'the late second page is dropped');
  assert.equal(bridge.calls.length, 2);
});

test('entries shifted across a page boundary are not duplicated', async () => {
  const bridge = {
    listWorkspaceEntries: async () => [],
    listWorkspaceEntriesPage: async (_directory, offset) => offset === 0
      ? { entries: [{ name: 'b', path: 'b', kind: 'file' }, { name: 'a', path: 'a', kind: 'directory' }], nextOffset: 2, total: 3 }
      : { entries: [{ name: 'b', path: 'b', kind: 'file' }, { name: 'c', path: 'c', kind: 'file' }], nextOffset: null, total: 3 },
  };
  let final = [];
  await streamDirectoryListing(bridge, '', { isCurrent: () => true, onEntries: (entries) => { final = entries; } });
  assert.deepEqual(final.map((entry) => entry.name), ['a', 'b', 'c'], 'deduped and sorted folders-first');
});

test('older bridges without paging keep the single-response listing', async () => {
  const items = Array.from({ length: 400 }, (_, index) => ({ name: `f${pad(index)}`, path: `f${pad(index)}`, kind: 'file' }));
  const reports = [];
  const result = await streamDirectoryListing({ listWorkspaceEntries: async () => items }, '', { isCurrent: () => true, onEntries: (entries, complete) => reports.push([entries.length, complete]) });
  assert.deepEqual(reports, [[400, true]]);
  assert.deepEqual(result, { truncated: true }, 'a full legacy page still shows the limit notice');
});

test('a failing page rejects so the pane can show the error', async () => {
  const bridge = pagedBridge(950, { onPage: (offset) => { if (offset === 400) throw new Error('disk gone'); } });
  const reports = [];
  await assert.rejects(streamDirectoryListing(bridge, 'dir', { isCurrent: () => true, onEntries: (entries) => reports.push(entries.length) }), /disk gone/);
  assert.deepEqual(reports, [400], 'rows already shown stay');
});
