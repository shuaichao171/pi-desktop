import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { GitDeliveryPreview, TaskWorktree, UiFileCheckpoint, WorkbenchFeaturesBridge } from '@pidesktop/shared/workbenchFeatures';
import { useChatStore } from '../store';
import { WorkbenchTextView } from './WorkbenchTextView';
import './workbenchFeatures.css';
type View = 'checkpoint' | 'worktree' | 'delivery';
export function WorkbenchGitFeatures() {
  const bridge = useChatStore(state => state.bridge), cwd = useChatStore(state => state.cwd), status = useChatStore(state => state.status), sessionId = useChatStore(state => state.sessionId);
  const api = bridge as (typeof bridge & WorkbenchFeaturesBridge), dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLElement | null>(null), lock = useRef(false), generation = useRef(0);
  const [view, setView] = useState<View | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [checkpoint, setCheckpoint] = useState<UiFileCheckpoint | null>(null), [worktrees, setWorktrees] = useState<TaskWorktree[]>([]), [delivery, setDelivery] = useState<GitDeliveryPreview | null>(null);
  const [ref, setRef] = useState('HEAD'), [branch, setBranch] = useState(''), [remote, setRemote] = useState(''), [base, setBase] = useState('main'), [title, setTitle] = useState(''), [body, setBody] = useState('');
  useEffect(() => { generation.current++; setView(null); setBusy(false); lock.current = false; return () => { generation.current++; }; }, [cwd, bridge, sessionId]);
  useEffect(() => { const element = dialog.current; if (!view || !element) return; element.showModal(); return () => { element.close(); if (trigger.current?.isConnected && !trigger.current.closest('[inert]')) trigger.current.focus(); }; }, [view]);
  const run = async (work: (current: () => boolean) => Promise<void>) => { if (lock.current) return; lock.current = true; setBusy(true); setError(''); const token = generation.current, current = () => token === generation.current && useChatStore.getState().cwd === cwd && useChatStore.getState().bridge === bridge && useChatStore.getState().sessionId === sessionId; try { await work(current); } catch (reason) { if (current()) setError(String(reason)); } finally { if (current()) { lock.current = false; setBusy(false); } } };
  async function open(next: View, element: HTMLElement) {
    if (!api || lock.current) return; trigger.current = element; setView(next); setError(''); setNotice(''); setCheckpoint(null); setDelivery(null);
    await run(async current => {
      if (next === 'checkpoint') { const result = await api.getFileCheckpoint(); if (current()) setCheckpoint(result); }
      if (next === 'worktree') { const result = await api.listTaskWorktrees(); if (current()) { setWorktrees(result); setBranch(`codex/task-${Date.now().toString(36)}`); } }
      if (next === 'delivery') { const result = await api.getGitDeliveryPreview(cwd); if (current()) { setDelivery(result); setRemote(result.remotes.find(item => item.name === 'origin')?.name ?? result.remotes[0]?.name ?? ''); } }
    });
  }
  async function enter(item: TaskWorktree) {
    if (!api) return;
    await useChatStore.getState().switchWorkspace(item.cwd);
    if (useChatStore.getState().cwd !== item.cwd || useChatStore.getState().bridge !== bridge) return;
    if (item.sessionPath && !item.sessionMissing) await useChatStore.getState().switchSession(item.sessionPath); else {
      await useChatStore.getState().newSession(); if (useChatStore.getState().cwd !== item.cwd || useChatStore.getState().bridge !== bridge) return; const path = useChatStore.getState().sessionPath;
      try { if (!path) throw new Error('会话尚未获得持久路径；可从工作树列表再次打开'); await api.bindTaskWorktree({ id: item.id, sessionPath: path }); }
      catch (reason) { if (useChatStore.getState().cwd === item.cwd && useChatStore.getState().bridge === bridge) useChatStore.setState({ error: `工作树已打开，但会话关联失败：${String(reason)}` }); throw reason; }
    }
    setView(null);
  }
  return <>
    <div className="pd-feature-toolbar">{(['checkpoint', 'worktree', 'delivery'] as View[]).map(kind => <button type="button" key={kind} data-feature={kind} disabled={!cwd || busy} onClick={event => void open(kind, event.currentTarget)}>{kind === 'checkpoint' ? '回合检查点' : kind === 'worktree' ? '独立工作树任务' : '推送 / 草稿 PR'}</button>)}</div>
    {view && createPortal(<dialog className="pd-feature-dialog" ref={dialog} aria-modal="true" onCancel={event => { event.preventDefault(); if (!busy) setView(null); }} onKeyDown={event => event.stopPropagation()}>
      <header><h2>{view === 'checkpoint' ? '撤销最近完成回合' : view === 'worktree' ? '独立工作树任务' : '交付当前分支'}</h2><button type="button" disabled={busy} onClick={() => setView(null)}>关闭</button></header><p className="pd-feature-path">{cwd}</p>
      {error && <p role="alert" className="pd-workbench-error">{error}</p>}{notice && <p role="status">{notice}</p>}{busy && <p role="status">正在处理…</p>}
      {view === 'checkpoint' && <>{!busy && !checkpoint && <p>当前会话没有已完成回合的 Git 文本检查点。</p>}{checkpoint && <><p>{new Date(checkpoint.completedAt).toLocaleString()} · {checkpoint.restored ? '已撤销' : '保持暂存区；只处理下列完整覆盖的文件'}</p>{checkpoint.warning && <p>{checkpoint.warning}</p>}{checkpoint.recovery && <p role="alert">{checkpoint.recovery}</p>}{checkpoint.files.map(file => <details key={file.path}><summary>{file.path} · {file.status === 'ready' ? '可撤销' : file.status === 'conflict' ? '外部修改冲突' : file.status === 'uncovered' ? '未覆盖' : '已恢复'}</summary>{file.reason && <p>{file.reason}</p>}{file.diff && <WorkbenchTextView diff text={file.diff} path={file.path} />}</details>)}<button type="button" disabled={busy || status !== 'idle' || checkpoint.restored || !checkpoint.recovery && (!checkpoint.files.some(file => file.status === 'ready') || checkpoint.files.some(file => file.status === 'conflict'))} onClick={() => void run(async current => { const result = await api!.rewindFileCheckpoint({ id: checkpoint.id, version: checkpoint.version }); if (!current()) return; setCheckpoint(result); setNotice(result.restored ? '已恢复回合前文件，暂存区保持原样。' : '已完成故障恢复，请再次检查预览。'); })}>{checkpoint.recovery ? '恢复未完成操作' : '确认撤销覆盖文件'}</button></>}</>}
      {view === 'worktree' && <><p>从已提交 ref 创建独立工作目录。不会复制当前未提交改动，也不会自动删除工作树。</p><form onSubmit={event => { event.preventDefault(); void run(async current => { const item = await api!.createTaskWorktree({ cwd, ref, branch }); if (!current()) return; setWorktrees(items => [...items, item]); await enter(item); }); }}><label>起始 ref<input value={ref} onChange={event => setRef(event.target.value)} disabled={busy} required /></label><label>新分支<input value={branch} onChange={event => setBranch(event.target.value)} disabled={busy} required /></label><button type="submit" disabled={busy || !ref.trim() || !branch.trim()}>创建并进入新任务</button></form><h3>已创建工作树</h3>{worktrees.length ? worktrees.map(item => <div className="pd-feature-worktree" key={item.id}><strong>{item.branch}</strong><code>{item.cwd}</code><span>来源 {item.project} · {item.commit.slice(0, 12)}</span><button type="button" disabled={busy || item.missing} onClick={() => void run(() => enter(item))}>{item.missing ? '目录不存在' : '打开任务'}</button></div>) : <p>暂无工作树</p>}</>}
      {view === 'delivery' && delivery && <><p><strong>{delivery.branch}</strong> · {delivery.head.slice(0, 12)}<br />上游：{delivery.upstream || '未设置，推送时首次关联'}</p><label>目标远端<select disabled={busy} value={remote} onChange={event => { setRemote(event.target.value); setDelivery({ ...delivery, savedPr: undefined }); }}>{delivery.remotes.map(item => <option key={item.name} value={item.name}>{item.name} · {item.url}</option>)}</select></label><button type="button" disabled={busy || !remote} onClick={() => void run(async current => { await api!.pushWorkspaceBranch({ id: delivery.id, remote }); if (!current()) return; setNotice(`已将 ${delivery.head.slice(0, 12)} 推送至 ${remote}/${delivery.branch}`); })}>普通推送并设置上游</button><p>不会强制推送；创建 PR 不会自动推送未交付提交。</p>{delivery.savedPr && <p><a href={delivery.savedPr} target="_blank" rel="noreferrer">打开已关联 PR</a></p>}<form onSubmit={event => { event.preventDefault(); void run(async current => { const result = await api!.createWorkspaceDraftPr({ id: delivery.id, remote, base, title, body }); if (!current()) return; setDelivery({ ...delivery, savedPr: result.url }); setNotice(result.existing ? '已找到当前分支的现有 PR。' : '草稿 PR 已创建。'); }); }}><label>合入分支<input value={base} onChange={event => setBase(event.target.value)} disabled={busy} required /></label><label>PR 标题<input value={title} onChange={event => setTitle(event.target.value)} disabled={busy} required /></label><label>说明<textarea value={body} onChange={event => setBody(event.target.value)} disabled={busy} rows={5} /></label><button type="submit" disabled={busy || !delivery.ghAvailable || !delivery.remotes.find(item => item.name === remote)?.github || !title.trim()}>创建或打开草稿 PR</button>{!delivery.ghAvailable && <p>请安装并登录 GitHub CLI（gh）。</p>}</form></>}
    </dialog>, document.body)}
  </>;
}
