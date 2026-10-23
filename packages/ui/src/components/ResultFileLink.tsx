import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ResultFileTarget } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { parseResultFileReference } from '../resultFileReferences';
import { resultFileSessionSnapshot, sameResultFileSession, type ResultFileSessionSnapshot } from '../resultFileContext';
import { useResultFilePreviewStore } from '../resultFilePreviewStore';
import { runWithFeedback } from '../operationFeedback';
import type { ContextMenuPoint } from '../contextMenuPosition';
import { SidebarPopover } from './SidebarPopover';
import { Icon } from './Icons';
import './resultFileLink.css';

export function ResultFileLink({ href, children, title }: { href?: string; children?: ReactNode; title?: string }) {
  const { t } = useT();
  const reference = href ? parseResultFileReference(href) : null;
  const bridge = useChatStore(state => state.bridge);
  const cwd = useChatStore(state => state.cwd);
  const sessionPath = useChatStore(state => state.sessionPath);
  const navigationPending = useChatStore(state => state.navigationPending);
  const openPreview = useResultFilePreviewStore(state => state.open);
  const anchor = useRef<HTMLAnchorElement>(null);
  const [menu, setMenu] = useState(false);
  const [menuPoint, setMenuPoint] = useState<ContextMenuPoint>();
  const context = useRef<ResultFileSessionSnapshot>(resultFileSessionSnapshot(useChatStore.getState()));
  // A real context switch (workspace, conversation, navigation) closes the menu.
  // The first settle of a new conversation only assigns its session file path;
  // sameResultFileSession keeps that upgrade from counting as a switch. The
  // preview dialog itself is owned app-wide and survives link remounts.
  useEffect(() => {
    const previous = context.current;
    context.current = resultFileSessionSnapshot(useChatStore.getState());
    if (sameResultFileSession(previous, context.current)) return;
    setMenu(false);
  }, [cwd, sessionPath, navigationPending]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    window.addEventListener('scroll', close, true);
    return () => window.removeEventListener('scroll', close, true);
  }, [menu]);
  if (!reference) return <a href={href} title={title}>{children}</a>;
  const target: ResultFileTarget = { ...reference, cwd };
  const available = Boolean(bridge && cwd && !navigationPending);
  const act = (action: 'open' | 'reveal') => {
    setMenu(false);
    if (!bridge || !available) return;
    void runWithFeedback({
      id: `result-file:${action}:${cwd}:${reference.path}`,
      title: action === 'open' ? t('resultFile.open') : t('resultFile.reveal'),
      run: () => action === 'open' ? bridge.openResultFile(target) : bridge.revealResultFile(target),
      canRetry: () => !useChatStore.getState().navigationPending && sameResultFileSession(context.current, resultFileSessionSnapshot(useChatStore.getState())),
    });
  };
  return <>
    <a ref={anchor} href={href} className="pd-result-file-link" data-result-file={reference.path} title={title ?? reference.path}
      aria-haspopup="menu" aria-expanded={menu} aria-disabled={!available || undefined}
      onClick={event => { event.preventDefault(); if (available) openPreview(target); }} onAuxClick={event => event.preventDefault()}
      onContextMenu={event => { event.preventDefault(); if (available) { setMenuPoint({ x: event.clientX, y: event.clientY }); setMenu(true); } }}
      onKeyDown={event => {
        if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); if (available) { setMenuPoint(undefined); setMenu(true); } }
      }}>{children}</a>
    {menu && anchor.current && <SidebarPopover anchor={anchor.current} point={menuPoint} label={t('resultFile.actions')} onClose={() => setMenu(false)}>
      {/* The preview returns focus to whatever held it on open; hand it back to the
          link first so closing the preview does not strand focus on the removed menu. */}
      <button type="button" role="menuitem" onClick={() => { setMenu(false); anchor.current?.focus({ preventScroll: true }); openPreview(target); }}><span>{t('resultFile.preview')}</span><Icon name="panelRight" width="14" height="14" /></button>
      <button type="button" role="menuitem" onClick={() => act('open')}><span>{t('resultFile.openDefault')}</span><Icon name="file" width="14" height="14" /></button>
      <button type="button" role="menuitem" onClick={() => act('reveal')}><span>{t('resultFile.reveal')}</span><Icon name="folder" width="14" height="14" /></button>
    </SidebarPopover>}
  </>;
}
