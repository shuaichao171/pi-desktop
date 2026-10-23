import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { UiInputQueueItem } from '../../../shared/src/inputFeatures';
import { useT } from '../i18n';
import { Icon } from './Icons';

// Kept separately from the ordinary composer draft when visiting another conversation.
const editDrafts = new Map<string, string>();

export function QueueComposerEditor({ item, scopeKey, target, pending, present, onSave, onCancel, onEditingChange }: {
  item: UiInputQueueItem; scopeKey: string; target: HTMLElement; pending: boolean; present: boolean;
  onSave(text: string): Promise<boolean>; onCancel(): Promise<boolean>; onEditingChange(editing: boolean): void;
}) {
  const { t } = useT();
  // A new edit hold has a new row version. Cancelled or previously saved text must not return.
  const key = `${scopeKey}\0${item.id}\0${item.version}`;
  const [text, setText] = useState(() => editDrafts.get(key) ?? item.text);
  const textarea = useRef<HTMLTextAreaElement>(null), saving = useRef(false);
  const canSave = present && !pending && Boolean(text.trim() || item.attachments?.length);
  useLayoutEffect(() => {
    onEditingChange(true); textarea.current?.focus();
    textarea.current?.setSelectionRange(text.length, text.length);
    return () => { onEditingChange(false); };
  }, []);
  useLayoutEffect(() => { if (textarea.current) { textarea.current.style.height = 'auto'; textarea.current.style.height = `${textarea.current.scrollHeight}px`; } }, [text]);
  useLayoutEffect(() => { if (!pending && document.activeElement === document.body) textarea.current?.focus({ preventScroll: true }); }, [pending]);
  async function finish(save: boolean) {
    if (saving.current || pending || (save && !canSave)) return;
    saving.current = true;
    const ok = await (save ? onSave(text.trim()) : onCancel());
    if (ok) {
      editDrafts.delete(key);
    }
    saving.current = false;
  }
  return createPortal(<div className="pd-queue-composer-edit" onKeyDown={event => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation();
    if (!event.nativeEvent.isComposing && event.keyCode !== 229) void finish(false);
  }}>
    <div className="pd-queue-edit-heading"><Icon name="pencil" width="14" height="14" /><span>{t('queueEditor.title')}</span><small>{t('queueEditor.description')}</small></div>
    {Boolean(item.attachments?.length) && <div className="pd-queue-edit-attachments" aria-label={t('queueEditor.attachments')}>{item.attachments!.map((file, i) => <span key={`${file.name}:${i}`} title={file.name}><Icon name={file.kind === 'image' ? 'image' : 'file'} width="14" height="14" />{file.name}</span>)}</div>}
    <textarea ref={textarea} value={text} rows={2} maxLength={200000} aria-label={t('queueEditor.textLabel')} disabled={pending} onChange={event => {
      setText(event.target.value); editDrafts.delete(key); editDrafts.set(key, event.target.value);
      if (editDrafts.size > 50) editDrafts.delete(editDrafts.keys().next().value!);
    }} onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); void finish(true); }
    }} />
    {!present && <p role="status">{t('queueEditor.released')}</p>}
    <div className="pd-queue-edit-toolbar"><span>{t('queueEditor.shortcuts')}</span><button type="button" disabled={pending} onClick={() => void finish(false)}>{t('queueEditor.cancel')}</button><button type="button" className="is-primary" disabled={!canSave} onClick={() => void finish(true)}>{t('queueEditor.save')}</button></div>
  </div>, target);
}
