import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { UiSideQuestion } from '@pidesktop/shared';
import { useT } from '../i18n';
import { useChatStore } from '../store';
import { formatDate } from '../dateFormat';
import { groupModelsByProvider } from '../modelPicker';
import { operationFeedback } from '../operationFeedback';
import { HoverTooltip } from './HoverTooltip';
import { Icon } from './Icons';
import { ActivityLabel } from './ActivityDisclosure';
import { ConversationMarkdown } from './ConversationMarkdown';
import './sideQuestion.css';

/** Running cards tick their elapsed time like a turn header does. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  return <span className="pd-side-question-time">{seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}</span>;
}

const SideQuestionCard = memo(function SideQuestionCard({ record, anchorEntryId }: { record: UiSideQuestion; anchorEntryId: string }) {
  const { t, locale } = useT();
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const running = record.status === 'running';
  // A finished card auto-opens once, then folds; the explicit choice sticks afterwards.
  const settledRef = useRef(false);
  useEffect(() => {
    if (record.status === 'done' && !settledRef.current) { settledRef.current = true; setOpen(true); }
    if (record.status === 'error') setOpen(true);
  }, [record.status]);

  const copy = async () => {
    if (!record.answer) return;
    try { await navigator.clipboard.writeText(record.answer); } catch { operationFeedback.show({ id: `side-copy:${record.id}`, kind: 'error', title: t('sideQuestion.failed') }); return; }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  const reask = () => useChatStore.getState().openSideQuestion(anchorEntryId, { editOfId: record.id, initialText: record.question });
  const retry = () => { void useChatStore.getState().askSideQuestion(anchorEntryId, record.question, { id: record.id }); };
  const remove = () => { void useChatStore.getState().deleteSideQuestion(record.id); };

  const modelLabel = record.modelName?.trim() || record.modelId || '';
  return <details className={`pd-side-question is-${record.status}`} open={open || undefined} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>
      <Icon name={running ? 'loader' : record.status === 'error' ? 'alert' : 'message'} className={running ? 'pd-side-question-spinner' : undefined} width="13" height="13" />
      <span className="pd-side-question-q">{record.question}</span>
      {modelLabel && <span className="pd-side-question-model">{modelLabel}</span>}
      {running && <Elapsed since={record.createdAt} />}
      {record.contextTruncated && !running && <span className="pd-side-question-flag" title={t('sideQuestion.truncated')}>{t('sideQuestion.truncated')}</span>}
      <Icon name="chevronDown" className={`pd-chevron${open ? ' is-open' : ''}`} width="13" height="13" />
    </summary>
    <div className="pd-side-question-body">
      {running && <div className="pd-side-question-status" role="status"><ActivityLabel active>{t('sideQuestion.running')}</ActivityLabel></div>}
      {record.status === 'error' && <div className="pd-side-question-error" role="alert">
        <span>{record.error || t('sideQuestion.failed')}</span>
        <button type="button" onClick={retry}>{t('sideQuestion.retry')}</button>
      </div>}
      {record.answer && <div className="pd-side-question-answer pd-markdown" data-message-body><ConversationMarkdown>{record.answer}</ConversationMarkdown></div>}
      {!running && <div className="pd-side-question-actions">
        <span className="pd-side-question-meta">{formatDate(record.finishedAt ?? record.createdAt, locale, { time: true })}{modelLabel ? ` · ${modelLabel}` : ''}{record.contextTruncated ? ` · ${t('sideQuestion.truncated')}` : ''}</span>
        <HoverTooltip title={t(copied ? 'sideQuestion.copied' : 'sideQuestion.copy')}><button type="button" className="pd-side-question-action" onClick={() => void copy()} disabled={!record.answer} aria-label={t('sideQuestion.copy')}><Icon name={copied ? 'check' : 'copy'} width="14" height="14" /></button></HoverTooltip>
        <HoverTooltip title={t('sideQuestion.reask')}><button type="button" className="pd-side-question-action" onClick={reask} aria-label={t('sideQuestion.reask')}><Icon name="pencil" width="14" height="14" /></button></HoverTooltip>
        <HoverTooltip title={t('sideQuestion.delete')}><button type="button" className="pd-side-question-action" onClick={remove} aria-label={t('sideQuestion.delete')}><Icon name="trash" width="14" height="14" /></button></HoverTooltip>
      </div>}
    </div>
  </details>;
});

/** Inline (non-modal) aside input that opens under the anchored turn. */
export const SideQuestionComposer = memo(function SideQuestionComposer({ anchorEntryId, editOfId, initialText }: { anchorEntryId: string; editOfId?: string; initialText?: string }) {
  const { t, locale } = useT();
  const model = useChatStore((s) => s.model);
  const modelName = useChatStore((s) => s.modelName);
  const modelProvider = useChatStore((s) => s.modelProvider);
  const models = useChatStore((s) => s.models);
  const modelProviders = useChatStore((s) => s.modelProviders);
  const providerAuth = useChatStore((s) => s.providerAuth);
  const editTarget = useChatStore((s) => (editOfId ? s.sideQuestions.find((item) => item.id === editOfId) ?? null : null));
  const [draft, setDraft] = useState(initialText ?? '');
  const [selected, setSelected] = useState<string>('');
  const [asking, setAsking] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const configuredProviders = useMemo(() => {
    if (!modelProviders.length && !providerAuth.length) return undefined;
    const configured = new Map(providerAuth.map((item) => [item.provider, item.configured]));
    const allowed = new Set<string>();
    for (const item of modelProviders) if (configured.get(item.provider) ?? item.configured) allowed.add(item.provider);
    return allowed;
  }, [modelProviders, providerAuth]);
  const groups = useMemo(() => groupModelsByProvider(models, '', locale, configuredProviders), [models, locale, configuredProviders]);
  const value = selected || (model ? `${modelProvider}::${model}` : '');

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft]);

  const submit = async () => {
    if (asking || !draft.trim() || editTarget?.status === 'running') return;
    setAsking(true);
    try {
      const chosen = models.find((item) => `${item.provider}::${item.id}` === value);
      await useChatStore.getState().askSideQuestion(anchorEntryId, draft, {
        ...(editOfId ? { id: editOfId } : {}),
        ...(chosen && (chosen.provider !== modelProvider || chosen.id !== model) ? { model: { provider: chosen.provider, id: chosen.id, name: chosen.name } } : {}),
      });
      useChatStore.getState().closeSideQuestion();
    } catch (error) {
      // Bridge failures live on the record; only the anchor-missing rejection reaches the caller.
      operationFeedback.show({ id: 'side-question-submit', kind: 'error', title: error instanceof Error && error.message ? error.message : t('sideQuestion.anchorMissing') });
    } finally { setAsking(false); }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); }
    else if (event.key === 'Escape') { event.preventDefault(); useChatStore.getState().closeSideQuestion(); }
  };

  return <div className="pd-side-question-composer">
    <textarea ref={textareaRef} rows={2} value={draft} placeholder={t('sideQuestion.placeholder')} aria-label={t('sideQuestion.action')} disabled={asking} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} />
    <div className="pd-side-question-composer-row">
      <label className="pd-side-question-model-picker">
        <span className="pd-side-question-sr-only">{t('sideQuestion.model')}</span>
        <select value={value} onChange={(event) => setSelected(event.target.value)} disabled={asking}>
          <option value="">{`${t('sideQuestion.sessionModel')}${modelName?.trim() ? ` · ${modelName.trim()}` : model ? ` · ${model}` : ''}`}</option>
          {groups.map((group) => <optgroup key={group.provider} label={group.provider}>
            {group.models.map((item) => <option key={`${item.provider}::${item.id}`} value={`${item.provider}::${item.id}`}>{item.name || item.id}</option>)}
          </optgroup>)}
        </select>
      </label>
      <span className="pd-side-question-hint">{t('sideQuestion.hint')}</span>
      <button type="button" className="pd-side-question-cancel" onClick={() => useChatStore.getState().closeSideQuestion()} disabled={asking}>{t('sideQuestion.cancel')}</button>
      <button type="button" className="pd-side-question-submit" onClick={() => void submit()} disabled={asking || !draft.trim() || editTarget?.status === 'running'}>{t(editTarget?.status === 'running' ? 'sideQuestion.running' : 'sideQuestion.submit')}</button>
    </div>
  </div>;
});

/** Cards plus the open inline input of one anchored turn. */
export const SideQuestionRegion = memo(function SideQuestionRegion({ anchorEntryId }: { anchorEntryId: string }) {
  const records = useChatStore((s) => s.sideQuestions.filter((item) => item.anchorEntryId === anchorEntryId));
  const target = useChatStore((s) => s.sideQuestionTarget);
  const open = target?.anchorEntryId === anchorEntryId;
  if (!open && records.length === 0) return null;
  return <div className="pd-side-question-region">
    {records.map((record) => <SideQuestionCard key={record.id} record={record} anchorEntryId={anchorEntryId} />)}
    {open && <SideQuestionComposer anchorEntryId={anchorEntryId} editOfId={target?.editOfId} initialText={target?.initialText} />}
  </div>;
});
