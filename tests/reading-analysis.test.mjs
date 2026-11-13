import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedWords, diffWordRanges } from '../packages/ui/src/wordDiff.ts';
import { analyzeReading, splitHighlightedLines } from '../packages/ui/src/readingHighlight.ts';

test('word diff marks changed identifiers and Unicode while preserving equal text', () => {
  const before = 'const color = "深色";', after = 'const color = "浅色";';
  const [a, b] = changedWords(before, after);
  assert.equal(a.map(range => before.slice(range.start, range.end)).join(''), '深');
  assert.equal(b.map(range => after.slice(range.start, range.end)).join(''), '浅');
  assert.deepEqual(changedWords('same', 'same'), [[], []]);
  assert.deepEqual(changedWords('a'.repeat(5000), 'b'), [[], []]);
});
test('diff word pairing stays within adjacent replacement groups and retains prefix offsets', () => {
  const rows = [{ kind: 'removed', text: '-old value' }, { kind: 'added', text: '+new value' }, { kind: 'context', text: ' equal' }, { kind: 'added', text: '+fresh' }];
  const ranges = diffWordRanges(rows, 1);
  assert.equal(rows[0].text.slice(ranges[0][0].start, ranges[0][0].end), 'old');
  assert.equal(rows[1].text.slice(ranges[1][0].start, ranges[1][0].end), 'new');
  assert.equal(ranges[3], undefined);
});
test('background highlighting retains multiline comment spans and escapes raw HTML', () => {
  const result = analyzeReading({ text: '/* first\nsecond */\nconst html = "<script>";', path: 'a.ts', mode: 'text' });
  assert.match(result.html[0], /hljs-comment/);
  assert.match(result.html[1], /hljs-comment/);
  assert.match(result.html[2], /&lt;script&gt;/);
  assert.doesNotMatch(result.html.join(''), /<script>/);
  assert.deepEqual(splitHighlightedLines('<span class="x">a\nb</span>'), ['<span class="x">a</span>', '<span class="x">b</span>']);
  assert.deepEqual(analyzeReading({ text: 'x'.repeat(1_000_001), path: 'a.ts', mode: 'text' }), { html: [], words: {} });
});
test('markdown reading highlights structure and colors fenced code by its info-string language', () => {
  const text = ['# 标题', '', 'Some **bold** and *ital* and `code` [link](http://x.y)', '- item', '> quote', '', '```ts', 'const html = "<script>";', '/* a', 'b */', '```', '~~~', 'raw <x>', '~~~', '```unclosed', 'tail'].join('\r\n');
  const { html } = analyzeReading({ text, path: 'notes/README.MD', mode: 'text' });
  assert.equal(html.length, text.split('\n').length, 'one fragment per source line');
  assert.match(html[0], /hljs-section/);
  assert.match(html[2], /hljs-strong/); assert.match(html[2], /hljs-emphasis/); assert.match(html[2], /hljs-code/); assert.match(html[2], /hljs-link/);
  assert.match(html[3], /hljs-bullet/);
  assert.match(html[4], /hljs-quote/);
  assert.match(html[6], /pd-md-fence-marker/);
  assert.match(html[7], /pd-md-fence/); assert.match(html[7], /hljs-keyword/); assert.match(html[7], /&lt;script&gt;/);
  assert.match(html[8], /hljs-comment/); assert.match(html[9], /hljs-comment/);
  assert.match(html[10], /pd-md-fence-marker/);
  assert.match(html[12], /class="hljs-code">raw &lt;x&gt;/, 'unknown fence language stays a flat code span');
  assert.match(html[15], /pd-md-fence/, 'an unclosed fence runs to the end of the file');
  assert.doesNotMatch(html.join(''), /<script>|\r/);
  for (const extension of ['markdown', 'mdx']) assert.match(analyzeReading({ text: '# x', path: `a.${extension}`, mode: 'text' }).html[0], /hljs-section/);
});
