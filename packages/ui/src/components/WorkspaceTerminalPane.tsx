import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { WorkbenchFeaturesBridge, WorkspaceTerminalEvent, WorkspaceTerminalSnapshot } from '@pidesktop/shared/workbenchFeatures';
import { useChatStore } from '../store';
import '@xterm/xterm/css/xterm.css';
import './workbenchFeatures.css';
export function WorkspaceTerminalPane({ active }: { active: boolean }) {
  const cwd = useChatStore(state => state.cwd), bridge = useChatStore(state => state.bridge);
  const api = bridge as (typeof bridge & WorkbenchFeaturesBridge);
  const host = useRef<HTMLDivElement>(null), term = useRef<Terminal | null>(null), fit = useRef<FitAddon | null>(null), snapshot = useRef<WorkspaceTerminalSnapshot | null>(null);
  const [terminal, setTerminal] = useState<WorkspaceTerminalSnapshot | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const operation = useRef<symbol | null>(null), generation = useRef(0);
  useEffect(() => { generation.current++; operation.current = null; setBusy(false); return () => { generation.current++; }; }, [cwd, api]);
  useEffect(() => {
    if (!host.current || !api) return;
    let alive = true, initialized = false; const waiting: WorkspaceTerminalEvent[] = [];
    const xterm = new Terminal({ cursorBlink: true, scrollback: 1500, fontSize: 13, convertEol: false, allowProposedApi: false, theme: { background: '#14161b', foreground: '#e3e5eb' } });
    const addon = new FitAddon(); xterm.loadAddon(addon); xterm.open(host.current); term.current = xterm; fit.current = addon; snapshot.current = null; setTerminal(null); setError('');
    const ack = (id: string, sequence: number) => { if (alive) void api.acknowledgeWorkspaceTerminal({ id, sequence }).catch(() => {}); };
    const receive = (event: WorkspaceTerminalEvent) => {
      const current = snapshot.current; if (!alive || !current || event.id !== current.id || event.sequence <= current.sequence) return;
      current.sequence = event.sequence;
      if (event.type === 'data') xterm.write(event.data ?? '', () => ack(event.id, event.sequence));
      else { current.running = false; current.exitCode = event.exitCode; setTerminal({ ...current }); }
    };
    const unsubscribe = api.onWorkspaceTerminalEvent(event => { if (event.cwd !== cwd) return; if (initialized) receive(event); else waiting.push(event); });
    void api.getWorkspaceTerminal(cwd).then(value => {
      if (!alive) return; snapshot.current = value; setTerminal(value);
      if (value) xterm.write(value.output, () => ack(value.id, value.sequence));
      initialized = true; waiting.forEach(receive);
    }).catch(reason => { if (alive) setError(String(reason)); });
    let input = Promise.resolve();
    const data = xterm.onData(value => {
      const current = snapshot.current; if (!current?.running) return;
      for (let offset = 0; offset < value.length; offset += 16 * 1024) { const chunk = value.slice(offset, offset + 16 * 1024); input = input.then(() => api.writeWorkspaceTerminal({ id: current.id, data: chunk })).catch(reason => { if (alive) setError(String(reason)); }); }
    });
    const resize = () => { if (!host.current?.clientWidth || !host.current?.clientHeight) return; addon.fit(); const current = snapshot.current; if (current?.running && xterm.cols >= 10 && xterm.rows >= 2) void api.resizeWorkspaceTerminal({ id: current.id, cols: Math.min(xterm.cols, 500), rows: Math.min(xterm.rows, 300) }).catch(reason => { if (alive) setError(String(reason)); }); };
    const observer = new ResizeObserver(resize); observer.observe(host.current); resize();
    return () => { alive = false; unsubscribe(); observer.disconnect(); data.dispose(); xterm.dispose(); term.current = null; fit.current = null; };
  }, [cwd, api, revision]);
  useEffect(() => { if (active) { fit.current?.fit(); term.current?.focus(); } }, [active]);
  async function start() {
    if (!api || busy || operation.current) return; const token = generation.current; operation.current = Symbol(); const current = () => generation.current === token && useChatStore.getState().cwd === cwd && useChatStore.getState().bridge === bridge; setBusy(true); setError('');
    try { fit.current?.fit(); await api.openWorkspaceTerminal({ cwd, cols: Math.max(10, Math.min(term.current?.cols ?? 80, 500)), rows: Math.max(2, Math.min(term.current?.rows ?? 24, 300)) }); if (current()) setRevision(value => value + 1); }
    catch (reason) { if (current()) setError(String(reason)); } finally { if (current()) { operation.current = null; setBusy(false); } }
  }
  async function close() { if (!api || !terminal || busy || operation.current) return; const token = generation.current; operation.current = Symbol(); const current = () => generation.current === token && useChatStore.getState().cwd === cwd && useChatStore.getState().bridge === bridge; setBusy(true); try { await api.closeWorkspaceTerminal(terminal.id); if (current()) setRevision(value => value + 1); } catch (reason) { if (current()) setError(String(reason)); } finally { if (current()) { operation.current = null; setBusy(false); } } }
  return <section className="pd-terminal-pane" hidden={!active} aria-label="交互终端">
    <div className="pd-feature-toolbar"><strong>交互终端</strong>{terminal?.running ? <button type="button" disabled={busy} onClick={() => void close()}>终止终端</button> : <button type="button" disabled={busy || !cwd} onClick={() => void start()}>启动终端</button>}<button type="button" onClick={() => term.current?.clear()}>清空显示</button></div>
    <p className="pd-feature-note">{terminal ? `${terminal.shell} · ${terminal.running ? '运行中；Ctrl+C 中断前台命令' : `已结束 (${terminal.exitCode ?? '—'})`}` : '在当前工作区启动一个交互 Shell。切换面板保持运行，关闭应用会终止它。'}</p>
    {terminal?.truncated && <p role="status">较早显示已裁剪；进程仍在运行。</p>}{error && <p role="alert" className="pd-workbench-error">{error}</p>}
    <div className="pd-terminal-screen" ref={host} />
  </section>;
}
