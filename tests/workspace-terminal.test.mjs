import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceTerminalService } from '../packages/desktop/src/main/workspaceTerminal.ts';
const until=async(predicate,timeout=15000)=>{const start=Date.now();while(!predicate()){if(Date.now()-start>timeout)throw new Error('PTY condition timed out');await new Promise(resolve=>setTimeout(resolve,30));}};
test('real PTY handles interactive input, UTF-8, resize, Ctrl+C, retained output and explicit cleanup',{timeout:45000},async t=>{
  const cwd=await mkdtemp(join(tmpdir(),'pi-pty-'));let current=cwd,output='',ack=true;let service;
  service=new WorkspaceTerminalService(()=>current,event=>{if(event.type==='data')output+=event.data;if(ack)try{service.acknowledge({id:event.id,sequence:event.sequence});}catch{}});
  t.after(async()=>{await service.dispose();await rm(cwd,{recursive:true,force:true});});
  const opened=await service.open({cwd,cols:80,rows:24}),id=opened.id;const windows=process.platform==='win32';
  service.write({id,data:windows?"Write-Output ('PTY_'+'中文_OK')\r":"printf 'PTY_%s\\n' '中文_OK'\n"});await until(()=>output.includes('PTY_中文_OK'));
  service.resize({id,cols:100,rows:30});service.write({id,data:windows?"Write-Output ('SIZE_' + [Console]::WindowWidth + 'x' + [Console]::WindowHeight)\r":"printf 'SIZE_'; stty size\n"});await until(()=>output.includes(windows?'SIZE_100x30':'30 100'));
  service.write({id,data:windows?"$answer=Read-Host 'Input'; Write-Output ('INPUT_' + $answer)\r":"read answer; printf 'INPUT_%s\\n' \"$answer\"\n"});await new Promise(resolve=>setTimeout(resolve,200));service.write({id,data:'typed-value\r'});await until(()=>output.includes('INPUT_typed-value'));
  service.write({id,data:windows?'Start-Sleep -Seconds 30\r':'sleep 30\n'});await new Promise(resolve=>setTimeout(resolve,200));service.write({id,data:'\x03'});await new Promise(resolve=>setTimeout(resolve,300));service.write({id,data:windows?"Write-Output ('INTERRUPT_'+'OK')\r":"printf 'INTERRUPT_%s\\n' OK\n"});await until(()=>output.includes('INTERRUPT_OK'));
  assert.equal((await service.get(cwd)).id,id);current=cwd+'-other';await assert.rejects(service.open({cwd:current,cols:80,rows:24}),/已有终端/);current=cwd;
  ack=false;service.write({id,data:windows?"[Console]::Write(('z' * 300000))\r":"head -c 300000 /dev/zero | tr '\\0' z\n"});await until(()=>output.length>260000);
  const buffered=await service.get(cwd);assert(buffered.running);assert(buffered.truncated);assert(buffered.output.length<=256*1024);ack=true;service.acknowledge({id,sequence:buffered.sequence});
  service.write({id,data:windows?"$child=Start-Process powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 120' -WindowStyle Hidden -PassThru; [Console]::WriteLine('CHILD_'+'PID_'+$child.Id)\r":"sleep 120 & printf 'CHILD_PID_%s\\n' $!\n"});
  await until(()=>/CHILD_PID_\d+/.test(output));const childPid=Number(/CHILD_PID_(\d+)/.exec(output)[1]);
  t.after(()=>{try{process.kill(childPid);}catch{}});
  await service.close(id);assert.equal(await service.get(cwd),null);
  await until(()=>{try{process.kill(childPid,0);return false;}catch{return true;}},5000);
});

test('natural shell exit releases native output worker and remains restartable',{timeout:30000},async t=>{
  const cwd=await mkdtemp(join(tmpdir(),'pi-pty-exit-'));const service=new WorkspaceTerminalService(()=>cwd,()=>{});
  t.after(async()=>{await service.dispose();await rm(cwd,{recursive:true,force:true});});
  const first=await service.open({cwd,cols:80,rows:24});service.write({id:first.id,data:process.platform==='win32'?'exit\r':'exit\n'});
  for(let attempt=0;attempt<200 && (await service.get(cwd)).running;attempt++) await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal((await service.get(cwd)).running,false);const second=await service.open({cwd,cols:80,rows:24});assert.notEqual(second.id,first.id);await service.close(second.id);
});
