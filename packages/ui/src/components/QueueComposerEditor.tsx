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
  const { locale } = useT(), zh = locale === 'zh-CN';
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
    <div className="pd-queue-edit-heading"><Icon name="pencil" width="14" height="14" /><span>{zh ? '编辑排队消息' : 'Edit queued message'}</span><small>{zh ? '保存后返回原队列位置' : 'Save to its original queue position'}</small></div>
    {Boolean(item.attachments?.length) && <div className="pd-queue-edit-attachments" aria-label={zh ? '原有附件，保存时保留' : 'Original attachments, kept on save'}>{item.attachments!.map((file, i) => <span key={`${file.name}:${i}`} title={file.name}><Icon name={file.kind === 'image' ? 'image' : 'file'} width="14" height="14" />{file.name}</span>)}</div>}
    <textarea ref={textarea} value={text} rows={2} maxLength={200000} aria-label={zh ? '编辑排队消息内容' : 'Edit queued message text'} disabled={pending} onChange={event => {
      setText(event.target.value); editDrafts.delete(key); editDrafts.set(key, event.target.value);
      if (editDrafts.size > 50) editDrafts.delete(editDrafts.keys().next().value!);
    }} onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); void finish(true); }
    }} />
    {!present && <p role="status">{zh ? '此消息已离开编辑状态，请核对队列。编辑内容仍保留，可复制后取消。' : 'This message is no longer held for editing. Check the queue; your edit is retained and can be copied before cancelling.'}</p>}
    <div className="pd-queue-edit-toolbar"><span>{zh ? 'Enter 保存 · Shift+Enter 换行 · Esc 取消' : 'Enter to save · Shift+Enter for newline · Esc to cancel'}</span><button type="button" disabled={pending} onClick={() => void finish(false)}>{zh ? '取消' : 'Cancel'}</button><button type="button" className="is-primary" disabled={!canSave} onClick={() => void finish(true)}>{zh ? '保存到队列' : 'Save to queue'}</button></div>
  </div>, target);
}
