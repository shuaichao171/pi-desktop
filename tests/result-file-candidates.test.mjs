import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resultFileCandidates } from '../packages/ui/src/resultFileCandidates.ts';

const message = (order, text) => ({ id: String(order), order, role: 'assistant', text, status: 'done' });
const activity = (order, title, detail) => ({ id: String(order), order, tool: 'bash', title, status: 'done', ...(detail ? { detail } : {}) });

test('file-level mentions outrank directory joins and keep newest-first order', () => {
  const messages = [
    message(1, '都在 `D:\\steam\\steamapps\\common\\Don\'t Starve Together\\data\\anim\\` 下（注意不是 anim\\anim\\）'),
    message(2, '完整文件在 `D:\\logs\\sheepington_basic.zip`，还有个旧的 D:\\old\\sheepington_basic.zip'),
  ];
  assert.deepEqual(resultFileCandidates('sheepington_basic.zip', messages, []), [
    'D:\\old\\sheepington_basic.zip',
    'D:\\logs\\sheepington_basic.zip',
    'D:\\steam\\steamapps\\common\\Don\'t Starve Together\\data\\anim\\sheepington_basic.zip',
  ]);
});

test('quoted tool commands and tool output provide directory candidates for relative links', () => {
  const activities = [activity(1, 'ls "D:\\steam\\steamapps\\common\\Don\'t Starve Together\\data\\anim"', 'sheepington_basic.zip\nsheepington_build.zip')];
  const candidates = resultFileCandidates('sheepington_build.zip', [], activities);
  assert.deepEqual(candidates, ['D:\\steam\\steamapps\\common\\Don\'t Starve Together\\data\\anim\\sheepington_build.zip']);
  const nested = resultFileCandidates('scripts\\prefabs\\critters.lua', [message(2, '见 `D:\\games\\dst\\data\\` 目录')], []);
  assert.deepEqual(nested, ['D:\\games\\dst\\data\\scripts\\prefabs\\critters.lua']);
});

test('absolute links, bare names without mentions and POSIX roots produce nothing', () => {
  assert.deepEqual(resultFileCandidates('D:\\logs\\a.zip', [message(1, '`D:\\other\\a.zip`')], []), []);
  assert.deepEqual(resultFileCandidates('/usr/local/a.zip', [], []), []);
  assert.deepEqual(resultFileCandidates('a.zip', [message(1, '没有路径的纯文本')], []), []);
  assert.deepEqual(resultFileCandidates('..', [], []), []);
});

test('candidates are deduplicated, capped at eight and computed newest first', () => {
  const messages = Array.from({ length: 12 }, (_, index) => message(index, `复制于 D:\\dir${index}\\`));
  const candidates = resultFileCandidates('run.cmd', messages, []);
  assert.equal(candidates.length, 8);
  assert.equal(new Set(candidates.map((candidate) => candidate.toLowerCase())).size, 8);
  assert.deepEqual(candidates[0], 'D:\\dir11\\run.cmd');
});

test('text without any drive path yields no candidates', () => {
  assert.deepEqual(resultFileCandidates('critters.lua', [message(1, '源码在 scripts/prefabs/ 下，见 critters.lua')], [activity(2, 'grep -r "critter" scripts/')]), []);
});
