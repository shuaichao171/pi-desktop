import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { UiFileChange } from '@pidesktop/shared';
import { useT } from '../i18n';
import { parseUnifiedDiff } from '../unifiedDiff';
import { ChangeStats, FileLabel } from './FileChangePresentation';
import { Icon } from './Icons';
import './changesDialog.css';

function DiffPreview({ item, wrap }: { item: UiFileChange; wrap: boolean }) {
  const { t } = useT();
  const lines = useMemo(() => parseUnifiedDiff(item.diff ?? ''), [item.diff]);
  return <>
    {item.preview && <p className="pd-changes-notice" role="status">{t(`changes.preview.${item.preview}`)}</p>}
    {lines.length > 0 ? <div className={`pd-changes-code${wrap ? ' is-wrapped' : ''}`} tabIndex={0} role="region" aria-label={t('changes.diffFor', { path: item.path })}>
      <pre>{lines.map((line, index) => <span className={`pd-diff-line is-${line.kind}`} key={index}>
        <span className="pd-diff-number" aria-hidden="true">{line.oldLine}</span><span className="pd-diff-number" aria-hidden="true">{line.newLine}</span><span className="pd-diff-text">{line.text || ' '}</span>
      </span>)}</pre>
    </div> : !item.preview && <p className="pd-changes-notice">{t('changes.emptyFile')}</p>}
  </>;
}

function canRestoreFocus(element: HTMLElement | null | undefined): element is HTMLElement {
  return Boolean(element?.isConnected && element.getClientRects().length && !element.closest('[inert],[hidden],[aria-hidden="true"]')
    && !element.matches(':disabled') && getComputedStyle(element).visibility !== 'hidden');
}

export interface ChangesDialogProps {
  items: UiFileChange[];
  initialPath: string;
  returnFocus: HTMLElement | null;
  getReturnFocus?(): HTMLElement | null;
  onClose(): void;
}

/** The diff is the recorded conversation snapshot, never a fresh workspace/Git read. */
export function ChangesDialog({ items, initialPath, returnFocus, getReturnFocus, onClose }: ChangesDialogProps) {
  const { t, locale } = useT(), zh = locale === 'zh-CN';
  const dialogRef = useRef<HTMLDialogElement>(null), closeRef = useRef<HTMLButtonElement>(null);
  const fileButtons = useRef(new Map<string, HTMLButtonElement>());
  const focusedFile = useRef<HTMLButtonElement | null>(null);
  const focusReturn = useRef({ returnFocus, getReturnFocus });
  focusReturn.current = { returnFocus, getReturnFocus };
  const titleId = useId(), diffId = useId();
  const [path, setPath] = useState<string | null>(initialPath);
  const [wrap, setWrap] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const copyRequest = useRef(0);
  const selected = items.find(item => item.path === path) ?? items[0];
  const selectedPath = selected?.path ?? null;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => {
      copyRequest.current++;
      dialog?.close();
      // Wait until removed file buttons and their parent card have left the DOM.
      requestAnimationFrame(() => {
        const anotherDialog = [...document.querySelectorAll<HTMLElement>('dialog[open],[role="dialog"][aria-modal="true"]')]
          .some(element => element !== dialog && element.getClientRects().length > 0 && !element.closest('[inert],[hidden]'));
        if (anotherDialog) return;
        const { returnFocus: trigger, getReturnFocus: fallback } = focusReturn.current;
        const target = canRestoreFocus(trigger) ? trigger : fallback?.();
        if (canRestoreFocus(target)) target.focus({ preventScroll: true });
      });
    };
  }, []);

  useLayoutEffect(() => {
    // Commit the fallback selection. A removed path must not steal selection if it returns later.
    if (path !== selectedPath) setPath(selectedPath);
    const lostRow = focusedFile.current;
    if (lostRow && !lostRow.isConnected && (document.activeElement === document.body || document.activeElement === dialogRef.current)) {
      (selectedPath ? fileButtons.current.get(selectedPath) : closeRef.current)?.focus({ preventScroll: true });
    }
  }, [items, path, selectedPath]);
  useLayoutEffect(() => {
    if (selectedPath) fileButtons.current.get(selectedPath)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    copyRequest.current++; setNotice(null);
  }, [selectedPath]);

  function navigateFiles(event: KeyboardEvent<HTMLElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || !items.length) return;
    const index = Math.max(0, items.findIndex(item => item.path === selectedPath));
    const next = event.key === 'ArrowDown' ? Math.min(items.length - 1, index + 1)
      : event.key === 'ArrowUp' ? Math.max(0, index - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null;
    if (next === null) return;
    event.preventDefault(); event.stopPropagation();
    const nextPath = items[next]!.path;
    setPath(nextPath);
    const button = fileButtons.current.get(nextPath);
    button?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  async function copy(value: string, kind: 'path' | 'diff') {
    const request = ++copyRequest.current;
    try {
      await navigator.clipboard.writeText(value);
      if (request === copyRequest.current) setNotice({ error: false, text: zh ? kind === 'path' ? '路径已复制' : '原始差异已复制' : kind === 'path' ? 'Path copied' : 'Raw diff copied' });
    } catch {
      if (request === copyRequest.current) setNotice({ error: true, text: zh ? '复制失败，请选择文本复制。' : 'Copy failed. Select the text to copy it.' });
    }
  }

  return createPortal(<dialog ref={dialogRef} className="pd-changes-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <header className="pd-changes-dialog-header"><div><h2 id={titleId}>{t('changes.title')}</h2><span>{t('changes.count', { count: items.length })}</span><ChangeStats items={items} /></div>
      <button ref={closeRef} type="button" className="pd-icon-button" aria-label={t('changes.close')} onClick={onClose} autoFocus><Icon name="close" width="18" height="18" /></button>
    </header>
    <p className="pd-changes-description">{t('changes.description')}</p>
    <div className="pd-changes-review">
      <nav className="pd-changes-file-list" aria-label={t('changes.files')} onKeyDown={navigateFiles}>
        {items.map(item => <button type="button" key={item.path} ref={node => { if (node) fileButtons.current.set(item.path, node); else fileButtons.current.delete(item.path); }}
          className={`pd-changes-file${selectedPath === item.path ? ' is-selected' : ''}`} data-change-path={item.path} title={item.path}
          tabIndex={selectedPath === item.path ? 0 : -1} aria-current={selectedPath === item.path ? 'true' : undefined} aria-controls={diffId}
          onFocus={event => { focusedFile.current = event.currentTarget; }} onClick={() => setPath(item.path)}>
          <FileLabel item={item} /><ChangeStats items={[item]} />
        </button>)}
      </nav>
      {selected ? <section id={diffId} className="pd-changes-diff" aria-label={t('changes.diffFor', { path: selected.path })}>
        <div className="pd-changes-diff-header"><span title={selected.path}>{selected.path}</span><ChangeStats items={[selected]} /></div>
        <div className="pd-changes-diff-tools">
          <button type="button" onClick={() => void copy(selected.path, 'path')}><Icon name="copy" width="13" height="13" />{zh ? '复制路径' : 'Copy path'}</button>
          <button type="button" disabled={!selected.diff} onClick={() => void copy(selected.diff!, 'diff')}><Icon name="copy" width="13" height="13" />{zh ? '复制差异' : 'Copy diff'}</button>
          <button type="button" aria-pressed={wrap} onClick={() => setWrap(value => !value)}>{zh ? '自动换行' : 'Wrap lines'}</button>
        </div>
        {notice && <p className={`pd-changes-feedback${notice.error ? ' is-error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
        <DiffPreview key={selected.path} item={selected} wrap={wrap} />
      </section> : <p className="pd-changes-notice" role="status">{zh ? '当前没有记录到文件更改。' : 'No file changes are currently recorded.'}</p>}
    </div>
  </dialog>, document.body);
}
