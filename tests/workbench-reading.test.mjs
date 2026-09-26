import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readingRows, literalMatches, groupGitEntries, clampWorkbenchWidth, appendCommandOutput, commandOutput } from '../packages/ui/src/workbenchReading.ts';

test('mixed patch sections, renames and truncation notices preserve correct old/new line numbers', () => {
  const text = '已暂存 / Staged\ndiff --git a/旧名 b/新名\nrename from 旧名\nrename to 新名\n--- a/旧名\n+++ b/新名\n@@ -3,2 +3,2 @@\n 相同\n-旧值\n+新值\n未暂存 / Unstaged\n@@ -7,0 +8,1 @@\n+追加\n… 仅显示前 1 MB 的差异 / Diff preview limited to the first 1 MB.\n';
  const rows = readingRows(text, true);
  assert.deepEqual(rows.filter(row => row.kind === 'context').map(row => [row.oldLine,row.newLine]), [[3,3]]);
  assert.deepEqual(rows.filter(row => row.kind === 'removed').map(row => [row.oldLine,row.newLine]), [[4,undefined]]);
  assert.deepEqual(rows.filter(row => row.kind === 'added').map(row => [row.oldLine,row.newLine]), [[undefined,4],[undefined,8]]);
  assert.equal(rows.find(row => row.text.includes('Diff preview')).kind, 'meta');
  for(const row of rows) assert.equal(text.slice(row.offset, row.offset + row.text.length),row.text);
});

test('literal lookup counts each occurrence and handles regex symbols, Unicode and CRLF offsets', () => {
  const text = '中文 [a].\r\n[a]. 中文';
  assert.deepEqual(literalMatches(text, '[a].').map(match => text.slice(match.start,match.end)), ['[a].','[a].']);
  assert.equal(literalMatches(text, '中文').length, 2);
  assert.deepEqual(literalMatches(text, ''), []);
});

test('Git XY groups allow mixed changes to act on each source independently', () => {
  const entries = ['M ',' M','MM','??'].map((status,index)=>({path:String(index),status}));
  assert.deepEqual(groupGitEntries(entries).staged.map(entry=>entry.path), ['0','2']);
  assert.deepEqual(groupGitEntries(entries).unstaged.map(entry=>entry.path), ['1','2','3']);
  assert.equal(clampWorkbenchWidth(800, 680),656);
  assert.equal(clampWorkbenchWidth(420, 1280),420);
  assert.equal(clampWorkbenchWidth(100, 1440),320);
  assert.equal(clampWorkbenchWidth(1000, 1000),800);
});

test('command buffer accurately reports omission and keeps stderr and completion separate', () => {
  let result = appendCommandOutput([], {id:'run',type:'stdout',data:'start\n'});
  result = appendCommandOutput(result.events, {id:'run',type:'stderr',data:'failure\n'}, result.length);
  assert.deepEqual(commandOutput(result.events), {text:'start\nfailure\n',errorRanges:[{start:6,end:14}]});
  result = appendCommandOutput(result.events, {id:'run',type:'stdout',data:'x'.repeat(130000)},result.length);
  assert.equal(result.omitted,true); assert.equal(result.length,120000);
  result = appendCommandOutput(result.events,{id:'run',type:'exit',code:1},result.length);
  assert.equal(result.events.at(-1).type,'exit');
  assert.equal(commandOutput(result.events).text.length,120000);
});
