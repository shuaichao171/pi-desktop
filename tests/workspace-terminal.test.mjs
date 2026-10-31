import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkspaceTerminalService } from '../packages/desktop/src/main/workspaceTerminal.ts';

const windows = process.platform === 'win32';
const prompt = 'PTY_PROMPT_READY>';

async function until(label, predicate, { timeout = 15000, interval = 30, details = () => '' } = {}) {
  const deadline = performance.now() + timeout;
  while (!await predicate()) {
    if (performance.now() >= deadline) throw new Error(`PTY timed out waiting for ${label}. ${details()}`);
    await delay(interval);
  }
}

async function removeTerminalDirectory(cwd) {
  // ConPTY can retain the shell's cwd briefly after taskkill reports success.
  await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

test('real PTY handles interactive input, UTF-8, resize, Ctrl+C, retained output and explicit cleanup', { timeout: 60000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-pty-'));
  let current = cwd, output = '', ack = true, childPid;
  const service = new WorkspaceTerminalService(() => current, event => {
    if (event.type === 'data') output += event.data;
    if (ack) try { service.acknowledge({ id: event.id, sequence: event.sequence }); } catch {}
  });
  t.after(async () => {
    try { await service.dispose(); }
    finally {
      if (childPid) try { process.kill(childPid); } catch {}
      await removeTerminalDirectory(cwd);
    }
  });
  const { id } = await service.open({ cwd, cols: 80, rows: 24 });
  // ConPTY inserts VT controls between output characters when it redraws. Keep
  // raw offsets, then strip the complete slice so chunked controls remain valid.
  const textSince = start => stripVTControlCharacters(output.slice(start));
  const waitFor = (label, predicate, options = {}) => until(label, predicate, {
    details: () => `Recent output: ${JSON.stringify(textSince(0).slice(-2000))}`,
    ...options,
  });
  const write = command => service.write({ id, data: command + (windows ? '\r' : '\n') });
  const waitForResult = (label, start, expected, options) => waitFor(label, () => {
    const text = textSince(start), result = expected.exec(text);
    // A redraw can repeat an old prompt while the command is still being typed.
    // Only a prompt after the command's actual result means it has completed.
    return result && text.indexOf(prompt, result.index + result[0].length) >= 0;
  }, options);
  const run = async (label, command, expected, options) => {
    const start = output.length;
    write(command);
    await waitForResult(label, start, expected, options);
    return textSince(start);
  };

  // Split markers in commands so their echoed source cannot satisfy a check.
  write(windows
    ? "function prompt { 'PTY_' + 'PROMPT_READY> ' }"
    : "export PS1='PTY_''PROMPT_READY> '");
  await waitFor('initial shell prompt', () => textSince(0).includes(prompt));
  assert.match(await run('UTF-8 output', windows
    ? "Write-Output ('PTY_' + '中文_OK')"
    : "printf 'PTY_%s\\n' '中文_OK'", /PTY_中文_OK/), /PTY_中文_OK/);

  service.resize({ id, cols: 100, rows: 30 });
  // Resize delivery and PowerShell's console-size observation are asynchronous.
  // Probe the real dimensions again until they match; never repeat the resize.
  let sizeOutput = '';
  await waitFor('resized terminal dimensions 100x30', async () => {
    sizeOutput = await run('terminal size probe', windows
      ? "Write-Output ('SIZE_' + [Console]::WindowWidth + 'x' + [Console]::WindowHeight)"
      : "printf 'SIZE_'; stty size", windows ? /SIZE_\d+x\d+/ : /SIZE_\s*\d+\s+\d+/);
    return windows ? /SIZE_100x30/.test(sizeOutput) : /SIZE_\s*30\s+100/.test(sizeOutput);
  }, { interval: 100, details: () => `Last size probe: ${JSON.stringify(sizeOutput)}` });

  const inputStart = output.length;
  write(windows
    ? "$answer=Read-Host ('PTY_INPUT_' + 'READY'); Write-Output ('INPUT_' + $answer)"
    : "printf 'PTY_INPUT_%s' 'READY'; read answer; printf 'INPUT_%s\\n' \"$answer\"");
  await waitFor('interactive input prompt', () => textSince(inputStart).includes('PTY_INPUT_READY'));
  service.write({ id, data: 'typed-value\r' });
  await waitForResult('interactive input completion', inputStart, /INPUT_typed-value/);
  assert.match(textSince(inputStart), /INPUT_typed-value/);

  const interruptStart = output.length;
  write(windows
    ? "Write-Output ('INTERRUPT_' + 'START'); Start-Sleep -Seconds 30; Write-Output ('INTERRUPT_' + 'FINISHED')"
    : "printf 'INTERRUPT_%s\\n' START; sleep 30; printf 'INTERRUPT_%s\\n' FINISHED");
  await waitFor('interruptible command startup', () => textSince(interruptStart).includes('INTERRUPT_START'));
  service.write({ id, data: '\x03' });
  await waitForResult('shell prompt after Ctrl+C', interruptStart, /INTERRUPT_START/);
  assert.doesNotMatch(textSince(interruptStart), /INTERRUPT_FINISHED/);
  assert.match(await run('command after Ctrl+C', windows
    ? "Write-Output ('INTERRUPT_' + 'OK')"
    : "printf 'INTERRUPT_%s\\n' OK", /INTERRUPT_OK/), /INTERRUPT_OK/);

  assert.equal((await service.get(cwd)).id, id);
  current = cwd + '-other';
  await assert.rejects(service.open({ cwd: current, cols: 80, rows: 24 }), /已有终端/);
  current = cwd;

  ack = false;
  const largeOutputStart = output.length;
  write(windows ? "[Console]::Write(('z' * 300000))" : "head -c 300000 /dev/zero | tr '\\0' z");
  await waitFor('large retained output', () => output.length - largeOutputStart > 260000);
  const buffered = await service.get(cwd);
  assert(buffered.running);
  assert(buffered.truncated);
  assert(buffered.output.length <= 256 * 1024);
  ack = true;
  service.acknowledge({ id, sequence: buffered.sequence });
  await waitForResult('shell prompt after resumed output', largeOutputStart, /z{50}/);

  const childOutput = await run('child process startup', windows
    ? "$child=Start-Process powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 120' -WindowStyle Hidden -PassThru; [Console]::WriteLine('CHILD_'+'PID_'+$child.Id)"
    : "sleep 120 & printf 'CHILD_PID_%s\\n' $!", /CHILD_PID_\d+/);
  const childMatch = /CHILD_PID_(\d+)/.exec(childOutput);
  assert(childMatch, `Missing child PID: ${JSON.stringify(childOutput)}`);
  childPid = Number(childMatch[1]);
  await service.close(id);
  assert.equal(await service.get(cwd), null);
  await waitFor('child process termination', () => {
    try { process.kill(childPid, 0); return false; } catch { return true; }
  }, { timeout: 5000 });
  childPid = undefined;
});

test('natural shell exit releases native output worker and remains restartable', { timeout: 30000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-pty-exit-'));
  const service = new WorkspaceTerminalService(() => cwd, () => {});
  t.after(async () => {
    try { await service.dispose(); }
    finally { await removeTerminalDirectory(cwd); }
  });
  const first = await service.open({ cwd, cols: 80, rows: 24 });
  service.write({ id: first.id, data: windows ? 'exit\r' : 'exit\n' });
  await until('natural shell exit', async () => !(await service.get(cwd)).running);
  assert.equal((await service.get(cwd)).running, false);
  const second = await service.open({ cwd, cols: 80, rows: 24 });
  assert.notEqual(second.id, first.id);
  await service.close(second.id);
});

test('removing a workspace releases its terminal so the next project can open one', { timeout: 60000 }, async t => {
  const removed = await mkdtemp(join(tmpdir(), 'pi-pty-removed-'));
  const active = await mkdtemp(join(tmpdir(), 'pi-pty-active-'));
  let current = removed;
  const service = new WorkspaceTerminalService(() => current, () => {});
  t.after(async () => {
    try { await service.dispose(); }
    finally { await removeTerminalDirectory(removed); await removeTerminalDirectory(active); }
  });
  const first = await service.open({ cwd: removed, cols: 80, rows: 24 });
  assert.equal(first.cwd, removed);
  current = active;
  // The pane is gone with the removed project, so close() can never reach this pty.
  await assert.rejects(service.close(first.id), /终端不属于当前工作区/);
  await assert.rejects(service.open({ cwd: active, cols: 80, rows: 24 }), /已有终端/);
  // Removal releases it instead, and the next project can start its own shell.
  assert.equal(await service.closeForWorkspace(removed), true);
  assert.equal(await service.closeForWorkspace(removed), false, 'a released terminal is not closed twice');
  await assert.rejects(service.close(first.id), /终端不属于当前工作区/);
  const second = await service.open({ cwd: active, cols: 80, rows: 24 });
  assert.equal(second.cwd, active);
  assert.notEqual(second.id, first.id);
  await service.close(second.id);
});
