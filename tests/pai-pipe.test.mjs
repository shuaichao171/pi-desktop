import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paiPipeName, parsePaiPipeRequest } from '../packages/desktop/src/main/paiPipe.ts';

test('the pai pipe name is derived from a stable user-name hash', () => {
  // The C# launcher (pai-launcher.cs) computes the same SHA-256 prefix; both
  // sides must keep this derivation in sync.
  assert.equal(paiPipeName('shuaichao'), paiPipeName('shuaichao'));
  assert.equal(paiPipeName('shuaichao').length, 'pi-desktop-pai-'.length + 16);
  assert.match(paiPipeName('shuaichao'), /^pi-desktop-pai-[0-9a-f]{16}$/);
  assert.notEqual(paiPipeName('shuaichao'), paiPipeName('other-user'));
});

test('pipe requests parse one cwd and an optional session path', () => {
  assert.deepEqual(parsePaiPipeRequest('{"cwd":"D:\\\\project"}'), { cwd: 'D:\\project' });
  assert.deepEqual(parsePaiPipeRequest('{"cwd":"D:\\\\p","sessionPath":"D:\\\\s.jsonl"}'), { cwd: 'D:\\p', sessionPath: 'D:\\s.jsonl' });
  assert.deepEqual(parsePaiPipeRequest('{"cwd":"D:\\\\p","sessionPath":null}'), { cwd: 'D:\\p' });
});

test('pipe requests reject malformed or oversized payloads', () => {
  for (const line of [
    'not json',
    '[]',
    '{"cwd":""}',
    '{"cwd":42}',
    `{"cwd":"${'a'.repeat(5000)}"}`,
    '{"cwd":"D:\\\\p","sessionPath":7}',
    '{"sessionPath":"D:\\\\s.jsonl"}',
  ]) assert.equal(parsePaiPipeRequest(line), null, line);
});
