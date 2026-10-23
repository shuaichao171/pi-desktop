import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { GitDeliveryPreview, TaskWorktree, UiFileCheckpoint, WorkbenchFeaturesBridge } from '@pidesktop/shared/workbenchFeatures';
import { useChatStore } from '../store';
import { WorkbenchTextView } from './WorkbenchTextView';
import { Icon } from './Icons';
import './workbenchFeatures.css';
import { formatDate } from '../dateFormat';
import { useT } from '../i18n';
type View = 'checkpoint' | 'worktree' | 'delivery';
export function WorkbenchGitFeatures() {
  const { t, locale } = useT();
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
      await useChatStore.getState().newSession({ cwd: item.cwd }); if (useChatStore.getState().cwd !== item.cwd || useChatStore.getState().bridge !== bridge) return; const path = useChatStore.getState().sessionPath;
      try { if (!path) throw new Error(t('gitFeatures.noSessionPath')); await api.bindTaskWorktree({ id: item.id, sessionPath: path }); }
      catch (reason) { if (useChatStore.getState().cwd === item.cwd && useChatStore.getState().bridge === bridge) useChatStore.setState({ error: t('gitFeatures.bindFailed', { reason: String(reason) }) }); throw reason; }
    }
    setView(null);
  }
  return <>
    <div className="pd-feature-toolbar">{(['checkpoint', 'worktree', 'delivery'] as View[]).map(kind => <button type="button" key={kind} data-feature={kind} disabled={!cwd || busy} onClick={event => void open(kind, event.currentTarget)}><Icon name={kind === 'checkpoint' ? 'rotateCcw' : kind === 'worktree' ? 'gitBranch' : 'arrowUp'} width="13" height="13" /><span>{t(kind === 'checkpoint' ? 'gitFeatures.checkpoint' : kind === 'worktree' ? 'gitFeatures.worktreeTask' : 'gitFeatures.delivery')}</span></button>)}</div>
    {view && createPortal(<dialog className="pd-feature-dialog" ref={dialog} aria-modal="true" onCancel={event => { event.preventDefault(); if (!busy) setView(null); }} onKeyDown={event => event.stopPropagation()}>
      <header><h2>{t(view === 'checkpoint' ? 'gitFeatures.checkpointTitle' : view === 'worktree' ? 'gitFeatures.worktreeTask' : 'gitFeatures.deliveryTitle')}</h2><button type="button" disabled={busy} onClick={() => setView(null)}>{t('gitFeatures.close')}</button></header><p className="pd-feature-path">{cwd}</p>
      {error && <p role="alert" className="pd-workbench-error">{error}</p>}{notice && <p role="status">{notice}</p>}{busy && <p role="status">{t(view === 'checkpoint' && checkpoint ? 'gitFeatures.applyingRewind' : view === 'checkpoint' ? 'gitFeatures.previewingRewind' : 'gitFeatures.working')}</p>}
      {view === 'checkpoint' && <>{!busy && !checkpoint && <p>{t('gitFeatures.noCheckpoint')}</p>}{checkpoint && (() => {
        // zcode ConversationFileRewindDialog: files are grouped into what will
        // be reverted, what is left behind (each with its reason), and what is
        // already back; the confirm gate mirrors canApply.
        const safe = checkpoint.files.filter(file => file.status === 'ready');
        const skipped = checkpoint.files.filter(file => file.status === 'conflict' || file.status === 'uncovered');
        const done = checkpoint.files.filter(file => file.status === 'restored');
        const statusLabel = { ready: t('gitFeatures.statusReady'), conflict: t('gitFeatures.statusConflict'), uncovered: t('gitFeatures.statusUncovered'), restored: t('gitFeatures.statusRestored') };
        const kindLabel = { added: t('gitFeatures.kindAdded'), deleted: t('gitFeatures.kindDeleted'), modified: t('gitFeatures.kindModified') };
        const tier = (title: string, files: typeof checkpoint.files, tone: string) => files.length ? <div className={`pd-checkpoint-tier is-${tone}`}><h3>{t('gitFeatures.tierTitle', { title, count: files.length })}</h3>{files.map(file => <details key={file.path}><summary><span className="pd-checkpoint-file">{file.path}</span><span className={`pd-checkpoint-status is-${file.status}`}>{statusLabel[file.status]} · {kindLabel[file.kind]}</span></summary>{file.reason && <p className="pd-checkpoint-reason">{file.reason}</p>}{file.diff && <WorkbenchTextView diff text={file.diff} path={file.path} />}</details>)}</div> : null;
        return <><p>{formatDate(checkpoint.completedAt, locale, { time: true })} · {t(checkpoint.restored ? 'gitFeatures.undone' : 'gitFeatures.keepIndex')}</p>{checkpoint.warning && <p>{checkpoint.warning}</p>}{checkpoint.recovery && <p role="alert">{checkpoint.recovery}</p>}
        {tier(t('gitFeatures.tierSafe'), safe, 'safe')}
        {tier(t('gitFeatures.tierSkipped'), skipped, 'skipped')}
        {tier(t('gitFeatures.tierDone'), done, 'done')}
        {!checkpoint.files.length && <p>{t('gitFeatures.noFiles')}</p>}
        <button type="button" disabled={busy || status !== 'idle' || checkpoint.restored || !checkpoint.recovery && (!safe.length || checkpoint.files.some(file => file.status === 'conflict'))} onClick={() => void run(async current => { const result = await api!.rewindFileCheckpoint({ id: checkpoint.id, version: checkpoint.version }); if (!current()) return; setCheckpoint(result); setNotice(t(result.restored ? 'gitFeatures.restored' : 'gitFeatures.recovered')); })}>{t(checkpoint.recovery ? 'gitFeatures.resumeRecovery' : 'gitFeatures.confirmUndo')}</button></>;
      })()}</>}
      {view === 'worktree' && <><p>{t('gitFeatures.worktreeHint')}</p><form onSubmit={event => { event.preventDefault(); void run(async current => { const item = await api!.createTaskWorktree({ cwd, ref, branch }); if (!current()) return; setWorktrees(items => [...items, item]); await enter(item); }); }}><label>{t('gitFeatures.startRef')}<input value={ref} onChange={event => setRef(event.target.value)} disabled={busy} required /></label><label>{t('gitFeatures.newBranch')}<input value={branch} onChange={event => setBranch(event.target.value)} disabled={busy} required /></label><button type="submit" disabled={busy || !ref.trim() || !branch.trim()}>{t('gitFeatures.createTask')}</button></form><h3>{t('gitFeatures.worktrees')}</h3>{worktrees.length ? worktrees.map(item => <div className="pd-feature-worktree" key={item.id}><strong>{item.branch}</strong><code>{item.cwd}</code><span>{t('gitFeatures.worktreeSource', { project: item.project, commit: item.commit.slice(0, 12) })}</span><button type="button" disabled={busy || item.missing} onClick={() => void run(() => enter(item))}>{t(item.missing ? 'gitFeatures.missingFolder' : 'gitFeatures.openTask')}</button></div>) : <p>{t('gitFeatures.noWorktrees')}</p>}</>}
      {view === 'delivery' && delivery && <><p><strong>{delivery.branch}</strong> · {delivery.head.slice(0, 12)}<br />{t('gitFeatures.upstream', { upstream: delivery.upstream || t('gitFeatures.noUpstream') })}</p><label>{t('gitFeatures.remote')}<select disabled={busy} value={remote} onChange={event => { setRemote(event.target.value); setDelivery({ ...delivery, savedPr: undefined }); }}>{delivery.remotes.map(item => <option key={item.name} value={item.name}>{item.name} · {item.url}</option>)}</select></label><button type="button" disabled={busy || !remote} onClick={() => void run(async current => { await api!.pushWorkspaceBranch({ id: delivery.id, remote }); if (!current()) return; setNotice(t('gitFeatures.pushed', { commit: delivery.head.slice(0, 12), remote, branch: delivery.branch })); })}>{t('gitFeatures.push')}</button><p>{t('gitFeatures.pushHint')}</p>{delivery.savedPr && <p><a href={delivery.savedPr} target="_blank" rel="noreferrer">{t('gitFeatures.openPr')}</a></p>}<form onSubmit={event => { event.preventDefault(); void run(async current => { const result = await api!.createWorkspaceDraftPr({ id: delivery.id, remote, base, title, body }); if (!current()) return; setDelivery({ ...delivery, savedPr: result.url }); setNotice(t(result.existing ? 'gitFeatures.prExisting' : 'gitFeatures.prCreated')); }); }}><label>{t('gitFeatures.base')}<input value={base} onChange={event => setBase(event.target.value)} disabled={busy} required /></label><label>{t('gitFeatures.prTitle')}<input value={title} onChange={event => setTitle(event.target.value)} disabled={busy} required /></label><label>{t('gitFeatures.prBody')}<textarea value={body} onChange={event => setBody(event.target.value)} disabled={busy} rows={5} /></label><button type="submit" disabled={busy || !delivery.ghAvailable || !delivery.remotes.find(item => item.name === remote)?.github || !title.trim()}>{t('gitFeatures.createPr')}</button>{!delivery.ghAvailable && <p>{t('gitFeatures.ghMissing')}</p>}</form></>}
    </dialog>, document.body)}
  </>;
}
