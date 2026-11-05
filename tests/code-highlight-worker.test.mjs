import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { workerHighlight } from '../packages/ui/src/codeHighlightWorker.ts';
import { requestHighlight, WORKER_HIGHLIGHT_LINE_LIMIT } from '../packages/ui/src/codeHighlightWorkerPool.ts';

const uiRequire = createRequire(new URL('../packages/ui/package.json', import.meta.url));

test('the worker emits exactly the markup the synchronous path emits', async () => {
  const hljs = (await import(pathToFileURL(uiRequire.resolve('highlight.js/lib/common')).href)).default;
  const source = 'const answer = compute(input); // note\nreturn answer;\n';
  const sync = hljs.highlight(source, { language: 'typescript', ignoreIllegals: true }).value;
  const async = workerHighlight(source, 'typescript');
  assert.equal(async, sync);
  assert.match(async, /<span/);
  assert.equal(workerHighlight(source, 'not-a-language'), '', 'unknown languages stay plain text');
});

function withFakeWorkers(run) {
  return async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const previous = globalThis.Worker;
    const workers = [];
    class FakeWorker {
      constructor() { this.inputs = []; this.terminated = false; workers.push(this); }
      postMessage(value) { this.inputs.push(value); }
      terminate() { this.terminated = true; }
      complete(value) { this.onmessage({ data: value }); }
    }
    globalThis.Worker = FakeWorker;
    t.after(() => { t.mock.timers.tick(60_000); globalThis.Worker = previous; });
    return run(t, workers);
  };
}

test('long-block highlights answer, cancel, and fall back to plain text', withFakeWorkers((t, workers) => {
  const received = [];
  requestHighlight('let x = 1;', 'ts', value => received.push(value));
  assert.deepEqual(workers[0].inputs, [{ source: 'let x = 1;', language: 'ts' }]);
  workers[0].complete({ html: '<span class="hljs-keyword">let</span> x = 1;' });
  assert.equal(received[0].html, '<span class="hljs-keyword">let</span> x = 1;');
  // Cancelling a running job kills its worker; the late answer is dropped.
  const cancel = requestHighlight('let y = 2;', 'ts', value => received.push(value));
  assert.equal(workers.length, 1, 'the idle worker is reused before a second one spawns');
  assert.deepEqual(workers[0].inputs.at(-1), { source: 'let y = 2;', language: 'ts' });
  cancel();
  assert.equal(workers[0].terminated, true);
  workers[0].complete({ html: '<span>late</span>' });
  // Timeout and error both answer with '' — the escaped plain text stays put.
  requestHighlight('let z = 3;', 'ts', value => received.push(value));
  t.mock.timers.tick(20_001);
  requestHighlight('let w = 4;', 'ts', value => received.push(value));
  workers.at(-1).onerror();
  assert.deepEqual(received.slice(1).map(value => value.html), ['', '']);
  assert.ok(WORKER_HIGHLIGHT_LINE_LIMIT > 2000, 'the worker ceiling sits above the synchronous one');
  t.mock.timers.tick(5001);
  assert.ok(workers.every(worker => worker.terminated), 'idle workers are disposed');
}));
