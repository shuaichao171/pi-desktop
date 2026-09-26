import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCheckpoint } from '../packages/agent/src/fileCheckpoint.ts';
import { SessionFileChanges } from '../packages/agent/src/fileChanges.ts';
import { runFeatureProcess } from '../packages/desktop/src/main/gitFeatureProcess.ts';
const state = text => text === null ? { exists:false,fingerprint:'missing',text:'' } : { exists:true,fingerprint:createHash('sha256').update(text).digest('hex'),text };
async function setup(t) { const root=await mkdtemp(join(tmpdir(),'pi-checkpoint-')),cwd=join(root,'project'); await mkdir(cwd); t.after(()=>rm(root,{recursive:true,force:true})); const git=(...args)=>runFeatureProcess('git',['-C',cwd,...args]); await git('init'); const manager={getSessionDir:()=>join(root,'sessions'),getSessionId:()=> 'session-a',getBranch:()=>[],appendCustomEntry:()=>{}}; return {root,cwd,git,manager}; }
test('real tool lifecycle checkpoint restores add/delete/modify and leaves Git index untouched',async t=>{
  const {cwd,git,manager}=await setup(t); await writeFile(join(cwd,'edit.txt'),'before\n'); await writeFile(join(cwd,'delete.txt'),'deleted\n'); await git('add','.'); const index=(await git('write-tree')).stdout;
  const tracker=new SessionFileChanges(cwd,manager,()=>{}),hooks=new Map(); tracker.extension({on:(name,fn)=>hooks.set(name,fn)});
  await hooks.get('agent_start')(); await tracker.beforeTool('shell','bash',{});
  await writeFile(join(cwd,'edit.txt'),'after\n'); await rm(join(cwd,'delete.txt')); await writeFile(join(cwd,'add.txt'),'new\n'); await tracker.afterTool('shell'); await hooks.get('agent_end')();
  const preview=await tracker.getCheckpoint(); assert.equal(preview.files.length,3); assert(preview.files.every(file=>file.status==='ready'));
  const restored=await tracker.rewindCheckpoint(preview); assert.equal(restored.restored,true); assert.equal(await readFile(join(cwd,'edit.txt'),'utf8'),'before\n'); assert.equal(await readFile(join(cwd,'delete.txt'),'utf8'),'deleted\n'); await assert.rejects(readFile(join(cwd,'add.txt'))); assert.equal((await git('write-tree')).stdout,index);
});
test('external edits and binary or oversized captures are never overwritten',async t=>{
  const {cwd,manager}=await setup(t),checkpoint=new FileCheckpoint(cwd,manager); await writeFile(join(cwd,'a'),'after'); await checkpoint.begin(); checkpoint.record('a',state('before'),state('after')); checkpoint.record('binary',{exists:true,fingerprint:'binary',text:null},{exists:true,fingerprint:'other',text:null}); await checkpoint.complete();
  await writeFile(join(cwd,'a'),'manual'); const preview=await checkpoint.preview(); assert.equal(preview.files.find(file=>file.path==='a').status,'conflict'); assert.equal(preview.files.find(file=>file.path==='binary').status,'uncovered'); await assert.rejects(checkpoint.rewind(preview),/冲突/); assert.equal(await readFile(join(cwd,'a'),'utf8'),'manual');
});
test('midway write failure restores earlier files and a persisted checkpoint remains recoverable',async t=>{
  const {cwd,manager}=await setup(t),checkpoint=new FileCheckpoint(cwd,manager); await checkpoint.begin();
  for(const path of ['a','b']){await writeFile(join(cwd,path),'after');checkpoint.record(path,state('before'),state('after'));} await checkpoint.complete();
  const realPut=checkpoint.put.bind(checkpoint);let calls=0;checkpoint.put=async(...args)=>{if(++calls===2)throw new Error('injected disk failure');return realPut(...args);};const preview=await checkpoint.preview();
  await assert.rejects(checkpoint.rewind(preview),/已恢复撤销前内容/); assert.equal(await readFile(join(cwd,'a'),'utf8'),'after'); assert.equal(await readFile(join(cwd,'b'),'utf8'),'after');
  const restarted=new FileCheckpoint(cwd,manager);const ready=await restarted.preview();assert(ready.files.every(file=>file.status==='ready'));await restarted.rewind(ready);assert.equal(await readFile(join(cwd,'b'),'utf8'),'before');
});

test('BOM text that cannot be roundtripped is uncovered without losing other files',async t=>{
  const {cwd,manager}=await setup(t),checkpoint=new FileCheckpoint(cwd,manager);await checkpoint.begin();
  const bom=Buffer.from('\ufeffafter');await writeFile(join(cwd,'bom.txt'),bom);checkpoint.record('bom.txt',state('before'),{exists:true,fingerprint:createHash('sha256').update(bom).digest('hex'),text:'after'});
  await writeFile(join(cwd,'safe.txt'),'after');checkpoint.record('safe.txt',state('before'),state('after'));await checkpoint.complete();
  const view=await new FileCheckpoint(cwd,manager).preview();assert.equal(view.files.find(file=>file.path==='bom.txt').status,'uncovered');await checkpoint.rewind(view);assert.deepEqual(await readFile(join(cwd,'bom.txt')),bom);assert.equal(await readFile(join(cwd,'safe.txt'),'utf8'),'before');
});

test('failed rollback journal survives restart and newer rounds until explicit recovery',async t=>{
  const {cwd,manager}=await setup(t),checkpoint=new FileCheckpoint(cwd,manager);await checkpoint.begin();
  for(const path of ['a','b']){await writeFile(join(cwd,path),'after');checkpoint.record(path,state('before'),state('after'));}await checkpoint.complete();
  const realPut=checkpoint.put.bind(checkpoint);let calls=0;checkpoint.put=async(...args)=>{if(++calls>=2)throw new Error('injected persistent write failure');return realPut(...args);};
  await assert.rejects(checkpoint.rewind(await checkpoint.preview()),/保留恢复记录/);assert.equal(await readFile(join(cwd,'a'),'utf8'),'before');
  const restarted=new FileCheckpoint(cwd,manager),original=await restarted.preview();assert(original.recovery);await restarted.begin();restarted.record('new',state(null),state('new'));await restarted.complete();assert.equal((await restarted.preview()).id,original.id);
  const recovered=await restarted.rewind(original);assert(!recovered.restored);assert(!recovered.recovery);assert.equal(await readFile(join(cwd,'a'),'utf8'),'after');await restarted.rewind(recovered);assert.equal(await readFile(join(cwd,'b'),'utf8'),'before');
});
