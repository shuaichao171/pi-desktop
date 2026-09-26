import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { UiFileChange } from '@pidesktop/shared';
import { useT } from '../i18n';
import { Icon } from './Icons';
import { ChangeStats, FileLabel } from './FileChangePresentation';
import { ChangesDialog } from './ChangesDialog';
import './composerChanges.css';

const INITIAL_FILES = 3;

/** Conversation snapshots: live summary above the input, settled card below the transcript. */
export function ComposerChanges({ items, running = false, liveTarget }: { items: UiFileChange[]; running?: boolean; liveTarget?: HTMLElement | null }) {
  const { t, locale } = useT(), zh = locale === 'zh-CN';
  const [showAll, setShowAll] = useState(false);
  const [liveFilesOpen, setLiveFilesOpen] = useState(false);
  const [reviewPath, setReviewPath] = useState<string | null>(null);
  const reviewTrigger = useRef<HTMLElement | null>(null);
  const primary = useRef<HTMLButtonElement | null>(null);
  const popupToggle = useRef<HTMLButtonElement | null>(null);
  const liveRoot = useRef<HTMLElement | null>(null);
  const entryHasFocus = useRef(false);
  const listId = useId();
  const trackBlur = (event: FocusEvent<HTMLElement>) => {
    entryHasFocus.current = event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget);
  };
  useLayoutEffect(() => {
    // Switching entries or removing a file from a snapshot can remove its focused control.
    // Restore only focus we owned; an open review dialog or editor must keep its focus.
    if (entryHasFocus.current && document.activeElement === document.body) {
      entryHasFocus.current = false;
      (primary.current ?? document.querySelector<HTMLTextAreaElement>('.pd-composer-shell textarea'))?.focus({ preventScroll: true });
    }
  }, [running, items]);
  const openReview = (path: string, event: MouseEvent<HTMLButtonElement>) => {
    reviewTrigger.current = event.currentTarget;
    setReviewPath(path); setLiveFilesOpen(false);
  };
  useEffect(() => {
    if (!running) setLiveFilesOpen(false);
  }, [running]);
  useEffect(() => {
    if (items.length === 0) { setReviewPath(null); setLiveFilesOpen(false); setShowAll(false); }
  }, [items.length]);
  useEffect(() => {
    if (!liveFilesOpen) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !liveRoot.current?.contains(event.target)) setLiveFilesOpen(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); setLiveFilesOpen(false); popupToggle.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key, true); };
  }, [liveFilesOpen]);
  if (!items.length) return null;
  const single = items.length === 1 ? items[0]! : null;
  const title = single ? (zh ? `已修改 ${single.path.split(/[\\/]/).at(-1)}` : `Edited ${single.path.split(/[\\/]/).at(-1)}`) : t('changes.count', { count: items.length });
  const visible = showAll ? items : items.slice(0, INITIAL_FILES);
  const fileRows = (files: UiFileChange[]) => files.map(item => <button key={item.path} type="button" className="pd-composer-changes-file" data-change-path={item.path} title={item.path} aria-label={t('changes.diffFor', { path: item.path })} aria-haspopup="dialog" onClick={event => openReview(item.path, event)}>
    <FileLabel item={item} /><ChangeStats items={[item]} /><Icon name="chevronRight" width="12" height="12" />
  </button>);
  const liveSummary = <section ref={liveRoot} className="pd-composer-changes is-running" aria-label={t('changes.files')} onFocusCapture={() => { entryHasFocus.current = true; }} onBlurCapture={trackBlur}>
    <div className="pd-composer-changes-summary">
      <button ref={primary} type="button" className="pd-composer-changes-review pd-changes-live-main" aria-haspopup="dialog" title={t('changes.files')} onClick={event => openReview(items[0]!.path, event)}>
        <Icon name="file" width="15" height="15" /><span>{t('changes.count', { count: items.length })}</span><ChangeStats items={items} />
      </button>
      <button ref={popupToggle} type="button" className="pd-composer-changes-toggle" aria-expanded={liveFilesOpen} aria-controls={listId} aria-label={zh ? '查看已修改的文件列表' : 'Show changed files'} onClick={() => setLiveFilesOpen(value => !value)}><Icon name="chevronDown" width="14" height="14" /></button>
    </div>
    {liveFilesOpen && <div id={listId} className="pd-changes-live-popover" role="region" aria-label={t('changes.files')}><div className="pd-changes-live-scope">{zh ? '本次对话' : 'This conversation'}</div>{fileRows(items)}</div>}
  </section>;
  const completed = <section className="pd-composer-changes pd-conversation-changes" aria-label={t('changes.files')} onFocusCapture={() => { entryHasFocus.current = true; }} onBlurCapture={trackBlur}>
    <div className="pd-changes-card-header">
      <button ref={primary} type="button" className="pd-changes-card-main" aria-haspopup="dialog" onClick={event => openReview(items[0]!.path, event)}>
        <span className="pd-changes-card-icon"><Icon name="file" width="21" height="21" /></span>
        <span className="pd-changes-card-copy"><strong title={single?.path}>{title}</strong><span className="pd-changes-card-subtitle"><span>{zh ? '本次对话' : 'This conversation'}</span><ChangeStats items={items} /></span></span>
      </button>
      <button type="button" className="pd-composer-changes-review" aria-haspopup="dialog" onClick={event => openReview(items[0]!.path, event)}>{t('changes.review')}<Icon name="arrowRight" width="13" height="13" /></button>
    </div>
    {!single && <div id={listId} className="pd-composer-changes-files">{fileRows(visible)}
      {items.length > INITIAL_FILES && <button type="button" className="pd-changes-show-more" aria-expanded={showAll} aria-controls={listId} onClick={() => setShowAll(value => !value)}>{showAll ? (zh ? '收起文件列表' : 'Collapse files') : (zh ? `显示其余 ${items.length - INITIAL_FILES} 个文件` : `Show ${items.length - INITIAL_FILES} more files`)}<Icon name={showAll ? 'chevronUp' : 'chevronDown'} width="13" height="13" /></button>}
    </div>}
  </section>;
  return <>
    {running && liveTarget ? createPortal(liveSummary, liveTarget) : completed}
    {reviewPath !== null && <ChangesDialog items={items} initialPath={reviewPath} returnFocus={reviewTrigger.current} getReturnFocus={() => primary.current ?? document.querySelector<HTMLTextAreaElement>('.pd-composer-shell textarea')} onClose={() => setReviewPath(null)} />}
  </>;
}
