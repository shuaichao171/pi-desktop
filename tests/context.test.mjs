import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { readWorkspaceContext, validateContextRequest } from '../packages/desktop/src/main/contextService.ts';
import { readSessionContext } from '../packages/desktop/src/main/searchService.ts';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-context-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project');
  const outside = join(root, 'outside');
  const sessionsRoot = join(root, 'sessions');
  await Promise.all([workspace, outside, sessionsRoot].map((path) => mkdir(path)));
  return { root, workspace, outside, sessionsRoot };
}

function message(id, parentId, role, content) {
  return { type: 'message', id, parentId, message: { role, content }, timestamp: '2026-09-24T00:00:00Z' };
}

async function history(sessionsRoot, cwd, entries, version = 3) {
  const directory = join(sessionsRoot, `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'context.jsonl');
  await writeFile(path, [{ type: 'session', version, cwd, id: 'context', timestamp: '2026-09-24T00:00:00Z' }, ...entries].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  return path;
}

test('file context is an escaped UTF-8 path reference, including binary and very large files', async (t) => {
  const { workspace } = await fixture(t);
  await mkdir(join(workspace, '中文 空格'));
  const relativePath = '中文 空格/图像.bin';
  const path = join(workspace, relativePath);
  await writeFile(path, Buffer.from([0, 255, 1, 2]));
  await truncate(path, 100 * 1024 * 1024);
  const result = await readWorkspaceContext({ kind: 'file', workspace, path: relativePath });
  assert.equal(result.name, relativePath);
  assert.equal(result.mimeType, 'text/x-pi-file-reference');
  assert.deepEqual(result.source, { kind: 'file', workspace, path: relativePath });
  assert.ok(result.text.includes(JSON.stringify(workspace)));
  assert.ok(result.text.includes(JSON.stringify(relativePath)));
  assert.ok(result.text.includes('File contents have not been read'));
  assert.ok(result.text.length < 2000);
});

test('directory context only includes one level with an explicit 200-entry cap', async (t) => {
  const { workspace } = await fixture(t);
  await mkdir(join(workspace, 'children'));
  await writeFile(join(workspace, 'children/nested-secret.txt'), 'must not read');
  for (let index = 0; index < 205; index += 1) await writeFile(join(workspace, `文档-${index}.txt`), 'not included');
  const result = await readWorkspaceContext({ kind: 'directory', workspace, path: '' });
  assert.equal(result.name, '.');
  assert.equal(result.source.path, '.');
  assert.equal(result.source.truncated, true);
  assert.equal(result.mimeType, 'text/x-pi-directory-reference');
  assert.equal(result.text.split('\n').filter((line) => /^(file|directory):/.test(line)).length, 200);
  assert.match(result.text, /truncated after 200/);
  assert.doesNotMatch(result.text, /nested-secret|must not read|not included/);
});

test('context paths reject traversal, type confusion, absolute paths and symlink escapes', async (t) => {
  const { workspace, outside } = await fixture(t);
  await writeFile(join(outside, 'private.txt'), 'outside');
  await writeFile(join(workspace, 'file.txt'), 'inside');
  for (const path of ['../outside/private.txt', outside, 'C:private.txt', '\\private', 'file.txt\0oops']) {
    await assert.rejects(readWorkspaceContext({ kind: 'file', workspace, path }));
  }
  await assert.rejects(readWorkspaceContext({ kind: 'directory', workspace, path: 'file.txt' }), /类型不匹配/);
  await assert.rejects(readWorkspaceContext({ kind: 'file', workspace, path: '' }), /类型不匹配/);
  for (const value of [null, {}, { kind: 'bad', workspace, path: 'file.txt' }, { kind: 'file', workspace: 'relative', path: 'file.txt' }]) {
    assert.throws(() => validateContextRequest(value), /上下文参数/);
  }
  try { await symlink(outside, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM' || error.code === 'EACCES') { t.diagnostic('Symlink checks unavailable'); return; } throw error; }
  await assert.rejects(readWorkspaceContext({ kind: 'directory', workspace, path: 'escape' }), /不属于/);
  await assert.rejects(readWorkspaceContext({ kind: 'file', workspace, path: 'escape/private.txt' }), /不属于/);
});

test('session context reads only the visible user/assistant branch and excludes attachments and private tool/thinking data', async (t) => {
  const { workspace, sessionsRoot } = await fixture(t);
  const path = await history(sessionsRoot, workspace, [
    message('q', null, 'user', '可见问题\n\n<!-- pi-desktop:attachments-v1 -->\nattachment-private'),
    message('discarded', 'q', 'assistant', [{ type: 'text', text: 'discarded-private' + 'x'.repeat(110_001) }]),
    message('live', 'q', 'assistant', [{ type: 'thinking', thinking: 'thought-private' }, { type: 'text', text: '可见回答' }, { type: 'toolCall', name: 'bash', arguments: { value: 'argument-private' } }]),
    message('tool', 'live', 'toolResult', [{ type: 'text', text: 'result-private' }]),
    { type: 'session_info', id: 'title', parentId: 'tool', name: '产品 设计' },
  ]);
  const original = await readFile(path);
  const result = await readSessionContext(sessionsRoot, workspace, path);
  assert.equal(result.name, '产品 设计.txt');
  assert.equal(result.mimeType, 'text/x-pi-session-context');
  assert.deepEqual(result.source, { kind: 'session', workspace, path });
  assert.match(result.text, /\[User\]\n可见问题/);
  assert.match(result.text, /\[Assistant\]\n可见回答/);
  assert.doesNotMatch(result.text, /attachment-private|discarded-private|thought-private|argument-private|result-private/);
  assert.deepEqual(await readFile(path), original);
});

test('session context is capped at 100k characters and keeps latest visible turns even beyond search budgets', async (t) => {
  const { workspace, sessionsRoot } = await fixture(t);
  const path = await history(sessionsRoot, workspace, [
    message('old', null, 'user', 'old-only-prefix ' + 'a'.repeat(5 * 1024 * 1024)),
    message('new', 'old', 'assistant', [{ type: 'text', text: 'latest-visible-answer ' + 'z'.repeat(110_000) + ' tail-preserved' }]),
    message('last', 'new', 'user', 'latest-question-preserved'),
  ]);
  const result = await readSessionContext(sessionsRoot, workspace, path);
  assert.ok(result.text.length <= 100_000);
  assert.equal(result.source.truncated, true);
  assert.match(result.text, /Conversation truncated/);
  assert.match(result.text, /tail-preserved/);
  assert.match(result.text, /latest-question-preserved/);
  assert.doesNotMatch(result.text.split('context.\n\n')[1], /old-only-prefix/);
});

test('legacy session context is read without migration and sessions from other owners are rejected', async (t) => {
  const { workspace, outside, sessionsRoot } = await fixture(t);
  const path = await history(sessionsRoot, workspace, [
    { type: 'message', message: { role: 'user', content: 'Legacy question' } },
    { type: 'message', message: { role: 'assistant', content: 'Legacy answer' } },
  ], 1);
  const original = await readFile(path);
  assert.match((await readSessionContext(sessionsRoot, workspace, path)).text, /Legacy answer/);
  assert.deepEqual(await readFile(path), original);
  const wrong = await history(sessionsRoot, outside, [message('q', null, 'user', 'wrong-owner')]);
  await assert.rejects(readSessionContext(sessionsRoot, workspace, wrong), /不属于/);
  await writeFile(path, JSON.stringify({ type: 'session', version: 3, id: 'wrong', cwd: outside }) + '\n');
  await assert.rejects(readSessionContext(sessionsRoot, workspace, path), /无法读取/);
});
