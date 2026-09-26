import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import type { IPty } from 'node-pty';
import type { WorkspaceTerminalEvent, WorkspaceTerminalSnapshot } from '@pidesktop/shared/workbenchFeatures';
type Terminal = { pty: IPty; snapshot: WorkspaceTerminalSnapshot; pending: Map<number, number>; pendingBytes: number; paused: boolean; buffer: string; released?: boolean; timer?: ReturnType<typeof setTimeout> };
export class WorkspaceTerminalService {
  private terminal: Terminal | null = null; private opening = false;
  private currentCwd: () => string; private emit: (event: WorkspaceTerminalEvent) => void;
  constructor(currentCwd: () => string, emit: (event: WorkspaceTerminalEvent) => void) { this.currentCwd = currentCwd; this.emit = emit; }
  private dimensions(cols: number, rows: number) { if (!Number.isInteger(cols) || cols < 10 || cols > 500 || !Number.isInteger(rows) || rows < 2 || rows > 300) throw new Error('终端尺寸无效'); }
  async get(cwd: string): Promise<WorkspaceTerminalSnapshot | null> { if (cwd !== this.currentCwd()) throw new Error('工作区已切换'); if (this.terminal?.snapshot.cwd !== cwd) return null; this.flush(this.terminal); return structuredClone(this.terminal.snapshot); }
  async open(request: { cwd: string; cols: number; rows: number }): Promise<WorkspaceTerminalSnapshot> {
    this.dimensions(request.cols, request.rows);
    if (request.cwd !== this.currentCwd() || this.opening) throw new Error('工作区已切换或终端正在启动');
    if (this.terminal?.snapshot.running) { if (this.terminal.snapshot.cwd !== request.cwd) throw new Error(`已有终端位于 ${this.terminal.snapshot.cwd}，请返回该项目关闭后再启动另一个终端`); return structuredClone(this.terminal.snapshot); }
    this.opening = true;
    try {
      const cwd = await realpath(request.cwd); if (!(await stat(cwd)).isDirectory()) throw new Error('工作区不是目录');
      const pty = await import('node-pty'); if (request.cwd !== this.currentCwd()) throw new Error('工作区已切换');
      const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
      const processPty = pty.spawn(shell, process.platform === 'win32' ? ['-NoLogo', '-NoProfile'] : [], { name: 'xterm-256color', cwd, cols: request.cols, rows: request.rows, env: { ...process.env, TERM: 'xterm-256color' }, useConpty: process.platform === 'win32' });
      const terminal: Terminal = { pty: processPty, snapshot: { id: randomUUID(), cwd: request.cwd, shell, running: true, output: '', sequence: 0, truncated: false }, pending: new Map(), pendingBytes: 0, paused: false, buffer: '' };
      this.terminal = terminal;
      processPty.onData(data => {
        terminal.snapshot.output += data; if (terminal.snapshot.output.length > 256 * 1024) { terminal.snapshot.output = terminal.snapshot.output.slice(-256 * 1024); terminal.snapshot.truncated = true; }
        terminal.buffer += data;
        if (terminal.buffer.length + terminal.pendingBytes > 256 * 1024 && !terminal.paused) { terminal.paused = true; processPty.pause(); }
        if (!terminal.timer) terminal.timer = setTimeout(() => this.flush(terminal), 16);
      });
      processPty.onExit(({ exitCode }) => { this.flush(terminal); terminal.snapshot.running = false; terminal.snapshot.exitCode = exitCode; this.release(terminal); terminal.snapshot.sequence++; this.emit({ id: terminal.snapshot.id, cwd: terminal.snapshot.cwd, sequence: terminal.snapshot.sequence, type: 'exit', exitCode }); });
      return structuredClone(terminal.snapshot);
    } finally { this.opening = false; }
  }
  private flush(terminal: Terminal) {
    if (terminal.timer) clearTimeout(terminal.timer); terminal.timer = undefined;
    while (terminal.buffer.length) { const data = terminal.buffer.slice(0, 64 * 1024); terminal.buffer = terminal.buffer.slice(data.length); const sequence = ++terminal.snapshot.sequence; terminal.pending.set(sequence, data.length); terminal.pendingBytes += data.length; this.emit({ id: terminal.snapshot.id, cwd: terminal.snapshot.cwd, sequence, type: 'data', data }); }
  }
  private owned(id: string) { if (typeof id !== 'string' || !this.terminal || this.terminal.snapshot.id !== id || this.terminal.snapshot.cwd !== this.currentCwd()) throw new Error('终端不属于当前工作区'); return this.terminal; }
  write(request: { id: string; data: string }) { const terminal = this.owned(request.id); if (!terminal.snapshot.running || typeof request.data !== 'string' || request.data.length > 64 * 1024) throw new Error('终端输入无效'); terminal.pty.write(request.data); }
  resize(request: { id: string; cols: number; rows: number }) { this.dimensions(request.cols, request.rows); const terminal = this.owned(request.id); if (terminal.snapshot.running) terminal.pty.resize(request.cols, request.rows); }
  acknowledge(request: { id: string; sequence: number }) { const terminal = this.owned(request.id); if (!Number.isSafeInteger(request.sequence) || request.sequence < 0 || request.sequence > terminal.snapshot.sequence) throw new Error('终端回执无效'); for (const [sequence, size] of terminal.pending) if (sequence <= request.sequence) { terminal.pending.delete(sequence); terminal.pendingBytes -= size; } if (terminal.paused && terminal.pendingBytes + terminal.buffer.length < 64 * 1024 && terminal.snapshot.running) { terminal.paused = false; terminal.pty.resume(); } }
  async close(id: string) { const terminal = this.owned(id); await this.stop(terminal); }
  private release(terminal: Terminal) {
    if (terminal.released) return;
    terminal.released = true;
    // node-pty's Windows natural-exit callback closes the pipe but does not dispose
    // its ConPTY output worker. Always invoke the public cleanup API exactly once.
    try { terminal.pty.kill(); } catch {}
  }
  private async stop(terminal: Terminal) {
    if (terminal.snapshot.running) {
      if (process.platform === 'win32') {
        await new Promise<void>(resolve => execFile('taskkill.exe', ['/PID', String(terminal.pty.pid), '/T', '/F'], { windowsHide: true, timeout: 8000 }, () => resolve()));
      } else { try { process.kill(-terminal.pty.pid, 'SIGTERM'); } catch {} }
    }
    this.release(terminal);
    if (terminal.timer) clearTimeout(terminal.timer); terminal.snapshot.running = false;
    if (this.terminal === terminal) this.terminal = null;
  }
  async dispose() { if (this.terminal) await this.stop(this.terminal); }
}
