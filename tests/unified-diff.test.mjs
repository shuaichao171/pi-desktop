import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseUnifiedDiff } from '../packages/ui/src/unifiedDiff.ts';

test('diff lines preserve separate old and new numbers across hunks and file headers', () => {
  const lines = parseUnifiedDiff('--- a/a.txt\n+++ b/a.txt\n@@ -3,2 +3,3 @@\n unchanged\n-old\n+new\n+++literal\n@@ -20 +21 @@\n-before\n+after\n');
  assert.deepEqual(lines.map(({ kind }) => kind), ['meta', 'meta', 'hunk', 'context', 'deletion', 'addition', 'addition', 'hunk', 'deletion', 'addition']);
  assert.deepEqual(lines[3], { kind: 'context', text: ' unchanged', oldLine: 3, newLine: 3 });
  assert.deepEqual(lines[6], { kind: 'addition', text: '+++literal', newLine: 5 });
  assert.equal(lines[8].oldLine, 20);
  assert.equal(lines[9].newLine, 21);
});

test('zero-length hunks, newline notices, and trailing metadata do not fabricate line numbers', () => {
  const lines = parseUnifiedDiff('@@ -0,0 +1,1 @@\n+created\n\\ No newline at end of file\n--- a/deleted\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-deleted\n\\ No newline at end of file\n');
  assert.equal(lines[1].newLine, 1);
  assert.equal(lines[2].kind, 'meta');
  assert.equal(lines[3].kind, 'meta');
  assert.equal(lines[4].kind, 'meta');
  assert.equal(lines[6].oldLine, 1);
  assert.equal(lines[7].newLine, undefined);
  assert.deepEqual(parseUnifiedDiff(''), []);
});
