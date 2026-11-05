import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestChangesFind, requestDiffParse } from '../packages/ui/src/diffWorkerPool.ts';
import { findPathMatches } from '../packages/ui/src/changesFind.ts';
import { parsePiEditDiff, parseUnifiedDiff } from '../packages/ui/src/unifiedDiff.ts';

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

test('diff parses run in the worker and reuse the same bounded workers', withFakeWorkers((t, workers) => {
  const received = [];
  requestDiffParse({ type: 'unified', text: '@@ -1 +1 @@\n-old\n+new' }, value => received.push(value));
  requestDiffParse({ type: 'pi-edit', text: '-1 old\n+1 new' }, value => received.push(value));
  requestDiffParse({ type: 'unified', text: '@@ -1 +1 @@\n+third' }, value => received.push(value));
  assert.equal(workers.length, 2, 'at most two concurrent workers');
  assert.deepEqual(workers.map(worker => worker.inputs[0]), [
    { type: 'unified', text: '@@ -1 +1 @@\n-old\n+new' },
    { type: 'pi-edit', text: '-1 old\n+1 new' },
  ]);
  workers[0].complete({ type: 'unified', lines: parseUnifiedDiff('@@ -1 +1 @@\n-old\n+new') });
  workers[1].complete({ type: 'pi-edit', lines: parsePiEditDiff('-1 old\n+1 new') });
  // The third queued job reuses the first freed worker instead of spawning one.
  assert.equal(workers[0].inputs.at(-1).text, '@@ -1 +1 @@\n+third');
  workers[0].complete({ type: 'unified', lines: parseUnifiedDiff('@@ -1 +1 @@\n+third') });
  assert.deepEqual(received.map(response => response.type), ['unified', 'pi-edit', 'unified']);
  assert.deepEqual(received[0].lines.map(({ kind }) => kind), ['hunk', 'deletion', 'addition']);
  assert.deepEqual(received[1].lines[1], { kind: 'addition', text: 'new', newLine: 1 });
  t.mock.timers.tick(5001);
  assert.ok(workers.every(worker => worker.terminated), 'idle workers are disposed');
}));

test('cancelling a running parse terminates its worker and drops the late answer', withFakeWorkers((t, workers) => {
  const received = [];
  const cancel = requestDiffParse({ type: 'unified', text: '@@ -1 +1 @@\n+big' }, value => received.push(value));
  assert.equal(workers.length, 1);
  cancel();
  assert.equal(workers[0].terminated, true);
  workers[0].complete({ type: 'unified', lines: parseUnifiedDiff('') });
  assert.equal(received.length, 0, 'a cancelled job must never answer');
}));

test('worker errors and timeouts fall back to the identical main-thread parse', withFakeWorkers((t, workers) => {
  const received = [];
  requestDiffParse({ type: 'unified', text: '--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b' }, value => received.push(value));
  requestDiffParse({ type: 'pi-edit', text: ' 1 keep\n+2 new' }, value => received.push(value));
  assert.equal(workers.length, 2);
  // Per-job timeout: both wedged workers are disposed and the fallback answers.
  t.mock.timers.tick(10_001);
  assert.ok(workers.every(worker => worker.terminated));
  assert.deepEqual(received[0].lines, parseUnifiedDiff('--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b'));
  assert.deepEqual(received[1].lines, parsePiEditDiff(' 1 keep\n+2 new'));
  // The error path answers the same way: no diff is ever lost or emptied.
  requestDiffParse({ type: 'unified', text: '@@ -1 +1 @@\n+retry' }, value => received.push(value));
  assert.equal(workers.length, 3, 'a fresh worker replaces the disposed ones');
  workers.at(-1).onerror();
  assert.equal(received.length, 3);
  assert.deepEqual(received[2].lines, parseUnifiedDiff('@@ -1 +1 @@\n+retry'));
}));

test('changes-find scans in the worker and its fallback counts identically', withFakeWorkers((t, workers) => {
  const request = { type: 'changes-find', paths: ['src/app.ts', 'lib/retry.ts'], query: 'RETRY', diffTexts: [['src/app.ts', '+const retryCount = 2;\n-const retryCount = 1;']] };
  const received = [];
  requestChangesFind(request, result => received.push(result));
  assert.deepEqual(workers[0].inputs[0], request);
  workers[0].complete({ type: 'changes-find', result: findPathMatches(request.paths, request.query, new Map(request.diffTexts)) });
  assert.equal(received[0].total, 3);
  // Worker failure answers with the main-thread scan of the very same inputs.
  requestChangesFind(request, result => received.push(result));
  assert.equal(workers.length, 1);
  workers[0].onerror();
  assert.deepEqual(received[1], received[0]);
  assert.deepEqual(received[1], findPathMatches(request.paths, 'RETRY', new Map(request.diffTexts)));
}));
