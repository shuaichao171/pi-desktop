import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { UiQueuedMessage } from '@pidesktop/shared';
import type { UiInputQueueItem } from '../../../shared/src/inputFeatures';
import { useT } from '../i18n';
import { useInputQueue } from '../useInputQueue';
import { Icon } from './Icons';
import { QueueComposerEditor } from './QueueComposerEditor';
import './composerQueue.css';
import './composerQueuePending.css';

function QueueDetails({ item, onClose, onRestoreFocus }: { item: UiQueuedMessage; onClose(): void; onRestoreFocus(): void }) {
  const { t } = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const restore = useRef(onRestoreFocus); restore.current = onRestoreFocus;
  useLayoutEffect(() => { const node = dialog.current; node?.showModal(); return () => { node?.close(); restore.current(); }; }, []);
  return createPortal(<dialog ref={dialog} className="pd-queue-details-dialog" aria-label={t('queue.itemContent')} onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <header><strong>{t('queue.itemTitle')}</strong><button type="button" className="pd-icon-button" onClick={onClose} aria-label={t('queue.close')} autoFocus><Icon name="close" width="16" height="16" /></button></header>
    <p>{item.text}</p>
    {item.attachments?.map((file, i) => <div className="pd-queue-detail-attachment" key={`${file.name}:${i}`}><Icon name={file.kind === 'image' ? 'image' : 'file'} width="16" height="16" /><span>{file.name}</span></div>)}
  </dialog>, document.body);
}

export const ComposerQueue = memo(function ComposerQueue({ items, scopeKey, editorTarget, onEditingChange, defaultBehavior, onToggleDefault }: {
  items: UiQueuedMessage[]; scopeKey: string; editorTarget: HTMLElement | null;
  onEditingChange(editing: boolean): void; defaultBehavior: 'followUp' | 'steer'; onToggleDefault(): void;
}) {
  const { t } = useT();
  const { queue, error, pending, pendingRows, pendingGlobal, activeRow, ready, refresh, mutate } = useInputQueue(items);
  const [editing, setEditing] = useState<UiInputQueueItem | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; left: number; bottom: number; trigger: HTMLElement } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const section = useRef<HTMLElement>(null), menuRef = useRef<HTMLDivElement>(null), mounted = useRef(true), ownedFocus = useRef(false);
  const disabled = !ready;
  const rowDisabled = (id: string) => disabled || pendingRows.has(id);
  const editingPending = [...pendingRows.values()].includes('beginEdit');
  const itemState = (id: string) => queue?.items.find(item => item.id === id)?.state;
  const siblings = (item: UiQueuedMessage) => items.filter(other => other.behavior === item.behavior && itemState(other.id) === 'accepted');
  const focusComposer = () => requestAnimationFrame(() => { if (mounted.current) document.querySelector<HTMLTextAreaElement>('.pd-composer-shell > textarea')?.focus({ preventScroll: true }); });
  const restoreQueueFocus = (id?: string) => requestAnimationFrame(() => {
    if (!mounted.current || document.activeElement !== document.body) return;
    const target = (id ? section.current?.querySelector<HTMLButtonElement>(`[data-queue-id="${CSS.escape(id)}"] .pd-composer-queue-text`) : null)
      ?? editorTarget?.querySelector<HTMLTextAreaElement>('textarea:not(:disabled)')
      ?? section.current?.querySelector<HTMLButtonElement>('.pd-composer-queue-text')
      ?? document.querySelector<HTMLTextAreaElement>('.pd-composer-shell > textarea');
    target?.focus({ preventScroll: true });
  });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => {
    if (ownedFocus.current && document.activeElement === document.body) {
      const button = section.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
      if (button) button.focus({ preventScroll: true }); else if (!editing) focusComposer();
    }
  }, [items, queue, editing]);
  const closeMenu = (restore = true) => {
    if (restore && menu?.trigger.isConnected) menu.trigger.focus({ preventScroll: true });
    setMenu(null);
  };
  useEffect(() => {
    if (!menu) return;
    if (!items.some(item => item.id === menu.id)) { setMenu(null); restoreQueueFocus(); return; }
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !menu.trigger.contains(event.target)) closeMenu(false); };
    const resize = () => closeMenu();
    document.addEventListener('pointerdown', outside); window.addEventListener('resize', resize);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', resize); };
  }, [menu, items]);
  useLayoutEffect(() => { if (menu) menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }, [menu?.id]);
  useEffect(() => { if (details && !items.some(item => item.id === details)) setDetails(null); }, [items, details]);

  async function beginEdit(item: UiQueuedMessage) {
    if (editing || editingPending || !editorTarget || rowDisabled(item.id)) return;
    const next = itemState(item.id) === 'editing' ? queue : await mutate('beginEdit', item.id);
    const current = next?.items.find(row => row.id === item.id);
    if (mounted.current && current?.state === 'editing') setEditing(current);
  }
  async function finishEdit(save: boolean, text?: string) {
    if (!editing) return false;
    const held = queue?.items.some(item => item.id === editing.id && item.state === 'editing');
    if (!held) { if (save) return false; setEditing(null); focusComposer(); return true; }
    const next = await mutate(save ? 'edit' : 'cancelEdit', editing.id, text);
    if (!next || !mounted.current) return false;
    setEditing(null); focusComposer(); return true;
  }
  function move(item: UiQueuedMessage, delta: -1 | 1) {
    if (rowDisabled(item.id)) return;
    const peers = siblings(item), index = peers.findIndex(peer => peer.id === item.id);
    if (index < 0 || index + delta < 0 || index + delta >= peers.length) return;
    void mutate('move', item.id, undefined, delta < 0 ? peers[index - 1]!.id : peers[index + 2]?.id ?? null);
  }
  function menuKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); event.stopPropagation(); closeMenu(); return; }
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : event.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null;
    if (next !== null) { event.preventDefault(); event.stopPropagation(); buttons[next]?.focus(); }
  }
  const menuItem = items.find(item => item.id === menu?.id);
  const selectedDetail = items.find(item => item.id === details);
  if (!items.length && !queue?.paused && !error && !editing) return null;

  return <>
    <section ref={section} className="pd-composer-queue" aria-label={t('composer.queuedInstructions')} onFocusCapture={() => { ownedFocus.current = true; }} onBlurCapture={event => { ownedFocus.current = event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget); }}>
      <span className="pd-queue-sr-only" role="status">{t('composer.queueCount', { count: items.length })}</span>
      {queue?.paused && <div className="pd-queue-paused" role="status"><Icon name="clock" width="14" height="14" /><span>{t('queue.paused')}</span><button type="button" disabled={disabled || pendingGlobal} onClick={() => void mutate('resume')}>{pendingGlobal ? t('queue.updating') : t('queue.resumeSend')}</button></div>}
      {error && <div className="pd-queue-error" role="alert"><span>{error}</span><button type="button" disabled={pending} onClick={() => void refresh()}>{t('queue.refresh')}</button></div>}
      <div className="pd-composer-queue-list">
        {items.map(item => {
          const state = itemState(item.id), recovered = state === 'recovered', held = state === 'editing', peers = siblings(item), sortable = state === 'accepted' && peers.length > 1;
          const rowPending = pendingRows.has(item.id), itemDisabled = rowDisabled(item.id);
          return <div key={item.id} className={`pd-composer-queue-item${held ? ' is-editing' : ''}${rowPending ? ' is-pending' : ''}${dragId === item.id ? ' is-dragging' : ''}${drop?.id === item.id ? drop.after ? ' drop-after' : ' drop-before' : ''}`} data-queue-id={item.id} data-behavior={item.behavior} data-state={state} aria-busy={rowPending} onDragOver={event => {
            const source = items.find(row => row.id === dragId);
            if (!source || itemDisabled || rowDisabled(source.id) || itemState(source.id) !== 'accepted' || state !== 'accepted' || source.behavior !== item.behavior || source.id === item.id) return;
            event.preventDefault(); event.dataTransfer.dropEffect = 'move'; const box = event.currentTarget.getBoundingClientRect(); setDrop({ id: item.id, after: event.clientY > box.top + box.height / 2 });
          }} onDrop={event => {
            event.preventDefault(); event.stopPropagation();
            const source = items.find(row => row.id === dragId);
            if (source && drop?.id === item.id && !itemDisabled && !rowDisabled(source.id) && state === 'accepted' && itemState(source.id) === 'accepted' && source.behavior === item.behavior) {
              const order = peers.filter(row => row.id !== source.id), index = order.findIndex(row => row.id === item.id);
              void mutate('move', source.id, undefined, drop.after ? order[index + 1]?.id ?? null : item.id);
            }
            setDragId(null); setDrop(null);
          }}>
            {items.length > 1 && <button type="button" className="pd-queue-drag" draggable={sortable && !itemDisabled} disabled={!sortable} aria-disabled={itemDisabled || !sortable} aria-label={t('queue.dragHint')} title={t('queue.dragHintShort')} onDragStart={event => { if (itemDisabled) { event.preventDefault(); return; } setDragId(item.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.id); }} onDragEnd={() => { setDragId(null); setDrop(null); }} onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); move(item, event.key === 'ArrowUp' ? -1 : 1); } }}><span aria-hidden="true">⠿</span></button>}
            <button type="button" className="pd-composer-queue-text" onClick={() => setDetails(item.id)} title={item.text} aria-label={t('queue.readItem', { text: item.text || t('queue.readItemAttachments', { count: item.attachments?.length ?? 0 }) })}>{item.text || t('composer.queueAttachments', { count: item.attachments?.length ?? 0 })}</button>
            {Boolean(item.attachments?.length) && <span className="pd-queue-attachment-count" title={item.attachments!.map(file => file.name).join('\n')}><Icon name={item.attachments!.every(file => file.kind === 'image') ? 'image' : 'file'} width="14" height="14" />{item.attachments!.length}</span>}
            {held && <span className="pd-queue-state">{t('queue.editing')}</span>}
            {recovered && <span className="pd-queue-state is-recovered">{t('queue.pendingConfirm')}</span>}
            {rowPending && <span className="pd-queue-pending" role="status">{activeRow === item.id ? t('queue.updating') : t('queue.waiting')}</span>}
            {item.behavior === 'steer' && !held && !recovered && <span className="pd-queue-state" title={t('composer.queuedSteerDescription')}>{t('composer.queuedSteer')}</span>}
            <div className="pd-composer-queue-actions">
              {recovered ? <button type="button" className="pd-composer-queue-action is-steer" disabled={itemDisabled} onClick={() => void mutate('confirm', item.id)}>{t('queue.confirmRestore')}</button>
                : item.behavior === 'followUp' && !held && <button type="button" className="pd-composer-queue-action is-steer" disabled={itemDisabled} title={t('composer.queueSteerHint')} aria-label={t('composer.queueSteer')} onClick={() => void mutate('steer', item.id)}><Icon name="steer" width="14" height="14" /><span>{t('queue.steer')}</span></button>}
              <button type="button" className="pd-composer-queue-action" disabled={itemDisabled || editing?.id === item.id} title={t('composer.queueDelete')} aria-label={t('composer.queueDelete')} onClick={() => void mutate('remove', item.id)}><Icon name="close" width="14" height="14" /></button>
              <button type="button" className="pd-composer-queue-action" aria-label={t('queue.moreActions')} aria-haspopup="menu" aria-expanded={menu?.id === item.id} onClick={event => {
                if (menu?.id === item.id) { closeMenu(); return; }
                const box = event.currentTarget.getBoundingClientRect();
                setMenu({ id: item.id, left: Math.max(8, Math.min(innerWidth - 232, box.right - 224)), bottom: Math.max(8, Math.min(innerHeight - 160, innerHeight - box.top + 5)), trigger: event.currentTarget });
              }}><Icon name="more" width="16" height="16" /></button>
            </div>
          </div>;
        })}
      </div>
    </section>
    {menu && menuItem && createPortal(<div ref={menuRef} className="pd-queue-menu" role="menu" aria-label={t('queue.itemActions')} style={{ left: menu.left, bottom: menu.bottom, maxHeight: Math.min(340, innerHeight - menu.bottom - 8) }} onKeyDown={menuKeys}>
      <button type="button" role="menuitem" disabled={rowDisabled(menuItem.id) || editingPending || Boolean(editing) || itemState(menuItem.id) === 'recovered' || queue?.items.some(row => row.state === 'editing' && row.id !== menuItem.id)} onClick={() => { closeMenu(false); void beginEdit(menuItem); }}><Icon name="pencil" width="15" height="15" />{t('queue.edit')}</button>
      <button type="button" role="menuitem" onClick={() => { closeMenu(false); setDetails(menuItem.id); }}><Icon name="message" width="15" height="15" />{t('queue.viewFull')}</button>
      {([-1, 1] as const).map(delta => { const peers = siblings(menuItem), index = peers.findIndex(row => row.id === menuItem.id); return <button key={delta} type="button" role="menuitem" disabled={rowDisabled(menuItem.id) || index < 0 || index + delta < 0 || index + delta >= peers.length} onClick={() => { closeMenu(); move(menuItem, delta); }}><Icon name={delta < 0 ? 'arrowUp' : 'arrowDown'} width="15" height="15" />{t(delta < 0 ? 'queue.moveUp' : 'queue.moveDown')}</button>; })}
      {itemState(menuItem.id) === 'editing' && !editing && <button type="button" role="menuitem" disabled={rowDisabled(menuItem.id)} onClick={() => { closeMenu(); void mutate('cancelEdit', menuItem.id); }}>{t('queue.cancelEdit')}</button>}
      <hr />
      <button type="button" role="menuitem" disabled={disabled || pendingGlobal} onClick={() => { closeMenu(); void mutate(queue?.paused ? 'resume' : 'pause'); }}><Icon name="clock" width="15" height="15" />{t(queue?.paused ? 'queue.resume' : 'queue.pause')}</button>
      <button type="button" role="menuitemcheckbox" aria-checked={defaultBehavior === 'followUp'} onClick={() => { closeMenu(); onToggleDefault(); }}><Icon name="queue" width="15" height="15" />{t(defaultBehavior === 'followUp' ? 'queue.defaultOff' : 'queue.defaultOn')}</button>
    </div>, document.body)}
    {selectedDetail && <QueueDetails key={selectedDetail.id} item={selectedDetail} onClose={() => setDetails(null)} onRestoreFocus={() => restoreQueueFocus(selectedDetail.id)} />}
    {editing && editorTarget && <QueueComposerEditor key={editing.id} item={editing} scopeKey={scopeKey} target={editorTarget} pending={pendingRows.has(editing.id)} present={Boolean(queue?.items.some(item => item.id === editing.id && item.state === 'editing'))} onSave={text => finishEdit(true, text)} onCancel={() => finishEdit(false)} onEditingChange={onEditingChange} />}
  </>;
});
