import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { normalizeSessionPath, pruneMissingSessionMeta } from '../packages/desktop/src/main/sessionPaths.ts';

test('session paths reject malformed input and normalize absolute paths', () => {
  for (const value of [null, 12, {}, '', 'relative.jsonl', '/bad\0.jsonl', '/bad\n.jsonl', `/${'x'.repeat(32768)}`]) {
    assert.throws(() => normalizeSessionPath(value), /会话路径无效/);
  }
  assert.equal(normalizeSessionPath(join(tmpdir(), 'one', '..', 'session.jsonl')), join(tmpdir(), 'session.jsonl'));
});

test('metadata cleanup only removes missing files in accessible directories', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-session-meta-prune-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'sessions');
  await mkdir(directory);
  const existing = join(directory, 'exists.jsonl');
  const deleted = join(directory, 'deleted.jsonl');
  const listed = join(directory, 'listed.jsonl');
  const offline = join(root, 'offline-volume', 'session.jsonl');
  await writeFile(existing, 'exists');
  const meta = Object.fromEntries([existing, deleted, listed, offline].map((path) => [path, { pinned: true }]));
  assert.equal(await pruneMissingSessionMeta(meta, new Set([listed])), true);
  assert.deepEqual(Object.keys(meta).sort(), [existing, listed, offline].sort());
  assert.equal(await pruneMissingSessionMeta(meta, new Set([listed])), false);
  const inaccessible = { [existing]: { unread: true } };
  assert.equal(await pruneMissingSessionMeta(inaccessible, new Set(), async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }), false);
  assert.deepEqual(inaccessible, { [existing]: { unread: true } });
});
