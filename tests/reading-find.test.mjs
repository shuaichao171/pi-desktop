import assert from 'node:assert/strict';
import { test } from 'node:test';
import { READING_FIND_CHAR_LIMIT, requestReadingFind } from '../packages/ui/src/diffWorkerPool.ts';
import { expandMatchRanges, literalMatchRanges, literalMatches } from '../packages/ui/src/workbenchReading.ts';

// The previous implementation, kept as the oracle the packed scan must match.
function reference(text, query) {
  if (!query) return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...text.matchAll(new RegExp(escaped, 'giu'))].map(match => ({ start: match.index, end: match.index + match[0].length }));
}

test('packed literal ranges match the object-per-match scan exactly', () => {
  const text = 'Value value VALUE\n(a+b)*[c] \\ path\\to\\file\n😀 emoji 😀 ÄÖ äö\r\nend';
  for (const query of ['', 'value', 'V', '(a+b)*', '[c]', '\\', '\\to', '😀', 'äö', '\n', 'missing']) {
    assert.deepEqual(literalMatches(text, query), reference(text, query), `query ${JSON.stringify(query)}`);
    assert.deepEqual(expandMatchRanges(literalMatchRanges(text, query)), reference(text, query));
  }
});

test('the packed buffer grows past its initial capacity', () => {
  const text = 'ab'.repeat(5000);
  const ranges = literalMatchRanges(text, 'a');
  assert.equal(ranges.length, 10_000);
  assert.ok(ranges instanceof Int32Array);
  assert.deepEqual([...ranges.slice(0, 4)], [0, 1, 2, 3]);
  assert.deepEqual(literalMatches(text, 'a'), reference(text, 'a'));
});

test('large-preview find runs in the worker and answers with packed ranges', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const previous = globalThis.Worker;
  const workers = [];
  globalThis.Worker = class { constructor() { this.inputs = []; workers.push(this); } postMessage(value) { this.inputs.push(value); } terminate() { this.terminated = true; } };
  t.after(() => { t.mock.timers.tick(60_000); globalThis.Worker = previous; });
  const text = 'x'.repeat(READING_FIND_CHAR_LIMIT) + 'needle';
  const received = [];
  requestReadingFind({ type: 'reading-find', text, query: 'needle' }, ranges => received.push(ranges));
  assert.equal(workers.length, 1);
  assert.deepEqual(workers[0].inputs[0], { type: 'reading-find', text, query: 'needle' });
  workers[0].onmessage({ data: { type: 'reading-find', ranges: literalMatchRanges(text, 'needle') } });
  assert.deepEqual(received.map(ranges => [...ranges]), [[READING_FIND_CHAR_LIMIT, READING_FIND_CHAR_LIMIT + 6]]);
});

test('a failed worker falls back to the identical main-thread scan', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const previous = globalThis.Worker;
  const workers = [];
  globalThis.Worker = class { constructor() { workers.push(this); } postMessage() {} terminate() {} };
  t.after(() => { t.mock.timers.tick(60_000); globalThis.Worker = previous; });
  const received = [];
  requestReadingFind({ type: 'reading-find', text: 'a A a', query: 'a' }, ranges => received.push([...ranges]));
  workers[0].onerror(new Event('error'));
  assert.deepEqual(received, [[0, 1, 2, 3, 4, 5]]);
});

test('without Worker support the scan answers synchronously', () => {
  const previous = globalThis.Worker;
  delete globalThis.Worker;
  try {
    const received = [];
    requestReadingFind({ type: 'reading-find', text: 'abc abc', query: 'bc' }, ranges => received.push([...ranges]));
    assert.deepEqual(received, [[1, 3, 5, 7]]);
  } finally {
    if (previous) globalThis.Worker = previous;
  }
});
