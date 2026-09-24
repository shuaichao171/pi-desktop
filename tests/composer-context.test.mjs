import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextMentionAt, consumeContextMention, contextSourceKey, hasContextSource } from '../packages/ui/src/composerContext.ts';

test('context trigger follows the caret, including Chinese text, without interpreting email or code as mentions', () => {
  assert.deepEqual(contextMentionAt('参考@组件 后续正文', 5), { start: 2, end: 5, query: '组件' });
  assert.deepEqual(contextMentionAt('@src/file.ts', 12), { start: 0, end: 12, query: 'src/file.ts' });
  assert.deepEqual(contextMentionAt('See @my file.ts', 15), { start: 4, end: 15, query: 'my file.ts' });
  assert.equal(contextMentionAt('mail@example.com', 16), null);
  assert.equal(contextMentionAt('`@literal`', 9), null);
  assert.equal(contextMentionAt('\\@literal', 9), null);
  assert.equal(contextMentionAt('@file\nnext line', 15), null);
  assert.equal(contextMentionAt('@file', 0), null);
  assert.equal(contextMentionAt('@file', 2, 4), null);
});

test('choosing a context removes only the trigger query, preserves the suffix, and rejects stale ranges', () => {
  const value = '参考@组件 后续正文';
  const mention = contextMentionAt(value, 5);
  assert.deepEqual(consumeContextMention(value, mention), { text: '参考 后续正文', caret: 2 });
  assert.equal(consumeContextMention('已经编辑过的内容', mention), null);
  assert.deepEqual(consumeContextMention('@', { start: 0, end: 1, query: '' }), { text: '', caret: 0 });
});

test('context deduplication uses full source identity, preserving same-named files from different projects', () => {
  const source = { kind: 'file', workspace: 'C:\\project', path: 'src\\File.ts' };
  const attachments = [{ kind: 'text', name: 'src/File.ts', mimeType: 'text/x-pi-file-reference', text: 'reference', source }];
  assert.equal(hasContextSource(attachments, { kind: 'file', workspace: 'c:/PROJECT', path: 'src/file.ts' }), true);
  assert.equal(hasContextSource(attachments, { ...source, workspace: 'C:\\other-project' }), false);
  assert.equal(hasContextSource(attachments, { ...source, kind: 'directory' }), false);
  assert.notEqual(contextSourceKey({ ...source, workspace: '/project', path: 'File.ts' }), contextSourceKey({ ...source, workspace: '/project', path: 'file.ts' }));
});
