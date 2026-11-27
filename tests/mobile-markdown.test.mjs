import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMarkdown } from '../apps/mobile/src/components/parseMarkdown.ts';

test('code blocks retain fence-like text until a matching standalone closing fence', () => {
  for (const marker of ['`', '~']) {
    const fence = marker.repeat(4);
    const body = [fence + 'js', 'hello', marker.repeat(3), '    ' + fence, marker === '~' ? '````' : '~~~~'];
    const code = { kind: 'code', lang: 'md', text: body.join('\n') };
    const streaming = [fence + 'md', ...body].join('\n');
    assert.deepEqual(parseMarkdown(streaming), [code]);
    assert.deepEqual(parseMarkdown(streaming + '\n  ' + fence + marker + ' \t\nafter'), [code, { kind: 'para', text: 'after' }]);
  }
  assert.deepEqual(parseMarkdown('```inline```\nnext'), [{ kind: 'para', text: '```inline```\nnext' }]);
});

test('only whitespace-separated closing hashes are removed from a heading', () => {
  for (const [source, text] of [['# C#', 'C#'], ['# C# ###  ', 'C#'], ['# ##', ''], ['# #tag', '#tag']]) {
    assert.deepEqual(parseMarkdown(source), [{ kind: 'heading', level: 1, text }]);
  }
  assert.deepEqual(parseMarkdown('#tag'), [{ kind: 'para', text: '#tag' }]);
});
