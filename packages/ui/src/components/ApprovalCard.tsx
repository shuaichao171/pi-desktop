import { useState } from 'react';
import type { UiAgentApprovalDecision, UiApprovalDecision, UiApprovalDetails, UiApprovalScope } from '@pidesktop/shared';
import { useT } from '../i18n';
import './approvalCard.css';

export function ApprovalCard({ approval, pending, onRespond }: { approval: UiApprovalDetails; pending: boolean; onRespond: (decision: UiApprovalDecision | UiAgentApprovalDecision | null) => void }) {
  const { t } = useT();
  const [scope, setScope] = useState<UiApprovalScope>(() => approval.scopes?.[0] ?? 'once');
  const [feedback, setFeedback] = useState('');
  const agentOptions = approval.agentOptions ?? [];
  const reject = agentOptions.find((option) => option.kind === 'reject_once') ?? agentOptions.find((option) => option.kind === 'reject_always');
  // "Allow once" starts selected, so the common answer stays a single click.
  const [optionId, setOptionId] = useState(() => agentOptions.find((option) => option.kind === 'allow_once')?.id ?? '');
  const scopes = approval.scopes ?? ['once'];
  const selected = approval.agentOptions?.find((option) => option.id === optionId);
  const native = Boolean(approval.agentOptions?.length);
  const command = approval.command && <div><strong>{t('approval.command')}</strong><pre className="pd-approval-command">{approval.command}</pre></div>;
  const names: Record<UiApprovalScope, string> = { once: t('approval.scopeOnce'), session: t('approval.scopeSession'), workspace: t('approval.scopeWorkspace') };
  return <div className="pd-approval-card">
    {!native && approval.source && <p className="pd-approval-source">{t('approval.requestedBy')}：{approval.source}</p>}
    {native && command}
    {approval.cwd && <p>{t('approval.workingDirectory')}：<code>{approval.cwd}</code></p>}
    {!native && command}
    {approval.files?.map((file, index) => <details key={`${index}-${file.path}`} open={approval.files?.length === 1} className="pd-approval-file">
      <summary>{file.path}</summary>{file.diff !== undefined ? <pre className="pd-approval-diff">{file.diff.split('\n').map((line, lineIndex) => <span key={lineIndex} className={line.startsWith('+') ? 'is-addition' : line.startsWith('-') ? 'is-deletion' : undefined}>{line}{'\n'}</span>)}</pre> : <p>{t('approval.noPreview')}</p>}
    </details>)}
    {approval.agentOptions?.length ? <>
      {scopes.includes('workspace') && <p className="pd-approval-source">{t('approval.rememberCommandHint')}</p>}
      <div className="pd-extension-request-actions pd-agent-approval-options">
        <select aria-label={t('approval.chooseAgentOption')} title={selected?.label} value={optionId} disabled={pending} onChange={event => setOptionId(event.target.value)}>
          <option value="" disabled>{t('approval.chooseAgentOption')}</option>
          {approval.agentOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
        {/* Declining answers with the agent's reject option; cancelling would read as stopping the turn. */}
        {reject
          ? <button type="button" className="pd-btn is-sm" disabled={pending} onClick={() => onRespond({ optionId: reject.id })}>{t('approval.decline')}</button>
          : <button type="button" className="pd-btn is-sm" disabled={pending} onClick={() => onRespond(null)}>{t('extension.cancel')}</button>}
        {scopes.includes('workspace') && <button type="button" className="pd-btn is-sm" disabled={pending} onClick={() => onRespond({ approved: true, scope: 'workspace' })}>{t('approval.rememberCommand')}</button>}
        <button type="button" className="pd-btn is-sm is-primary" disabled={pending || !selected} onClick={() => selected && onRespond({ optionId: selected.id })}>{t('extension.confirm')}</button>
      </div>
    </> : <>
      <label className="pd-approval-scope">{t('approval.scope')}<select value={scope} disabled={pending} onChange={event => setScope(event.target.value as UiApprovalScope)}>{scopes.map(value => <option key={value} value={value}>{names[value]}</option>)}</select></label>
      <label className="pd-approval-feedback">{t('approval.feedback')}<textarea maxLength={4000} rows={2} value={feedback} disabled={pending} onChange={event => setFeedback(event.target.value)} placeholder={t('approval.feedbackPlaceholder')} /></label>
      <div className="pd-extension-request-actions"><button type="button" className="pd-btn is-sm" disabled={pending} onClick={() => onRespond({ approved: false, scope: 'once', ...(feedback.trim() ? { feedback: feedback.trim() } : {}) })}>{t('approval.decline')}</button><button type="button" className="pd-btn is-sm is-primary" disabled={pending} onClick={() => onRespond({ approved: true, scope })}>{t('approval.allow')}</button></div>
    </>}
  </div>;
}
