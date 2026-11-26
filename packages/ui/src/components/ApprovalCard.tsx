import { useState } from 'react';
import type { UiAgentApprovalDecision, UiAgentApprovalOption, UiApprovalDecision, UiApprovalDetails, UiApprovalScope } from '@pidesktop/shared';
import { useT } from '../i18n';
import './approvalCard.css';

export function ApprovalCard({ approval, pending, onRespond }: { approval: UiApprovalDetails; pending: boolean; onRespond: (decision: UiApprovalDecision | UiAgentApprovalDecision | null) => void }) {
  const { t } = useT();
  const [scope, setScope] = useState<UiApprovalScope>(() => approval.scopes?.[0] ?? 'once');
  const [feedback, setFeedback] = useState('');
  const agentOptions = approval.agentOptions ?? [];
  const scopes = approval.scopes ?? ['once'];
  const native = agentOptions.length > 0;
  // Every native option is its own one-click answer: declines first, the usual "allow once" last as the primary action.
  const rank = (kind: UiAgentApprovalOption['kind']) => kind === 'reject_once' || kind === 'reject_always' ? 0 : kind === 'allow_once' ? 2 : 1;
  const ordered = agentOptions.map((option, index) => ({ option, index })).sort((a, b) => rank(a.option.kind) - rank(b.option.kind) || a.index - b.index).map(({ option }) => option);
  const hasReject = agentOptions.some((option) => rank(option.kind) === 0);
  const lastDecline = ordered.filter((option) => rank(option.kind) === 0).at(-1)?.id;
  const kindHint = (kind: UiAgentApprovalOption['kind']) => kind === 'allow_once' ? t('approval.kindAllowOnce') : kind === 'allow_always' ? t('approval.kindAllowAlways')
    : kind === 'reject_once' ? t('approval.kindRejectOnce') : kind === 'reject_always' ? t('approval.kindRejectAlways') : undefined;
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
    {native ? <>
      {scopes.includes('workspace') && <p className="pd-approval-source">{t('approval.rememberCommandHint')}</p>}
      <div className="pd-extension-request-actions pd-agent-approval-options" role="group" aria-label={t('approval.agentOptions')}>
        {/* Declining answers with the agent's reject option; cancelling would read as stopping the turn. */}
        {!hasReject && <button type="button" className="pd-btn is-sm pd-agent-approval-decline is-last-decline" disabled={pending} onClick={() => onRespond(null)}>{t('extension.cancel')}</button>}
        {ordered.map((option) => {
          const declines = rank(option.kind) === 0;
          const button = <button key={option.id} type="button" data-kind={option.kind}
            className={`pd-btn is-sm${option.kind === 'allow_once' ? ' is-primary' : ''}${declines ? ' pd-agent-approval-decline' : ''}${option.id === lastDecline ? ' is-last-decline' : ''}`}
            title={kindHint(option.kind)} disabled={pending} onClick={() => onRespond({ optionId: option.id })}>{option.label}</button>;
          // The desktop-side "remember this command" grant sits beside the agent's own lasting grants.
          return option.kind === 'allow_once' && scopes.includes('workspace')
            ? [<button key="workspace" type="button" className="pd-btn is-sm" disabled={pending} onClick={() => onRespond({ approved: true, scope: 'workspace' })}>{t('approval.rememberCommand')}</button>, button]
            : button;
        })}
      </div>
    </> : <>
      <label className="pd-approval-scope">{t('approval.scope')}<select value={scope} disabled={pending} onChange={event => setScope(event.target.value as UiApprovalScope)}>{scopes.map(value => <option key={value} value={value}>{names[value]}</option>)}</select></label>
      <label className="pd-approval-feedback">{t('approval.feedback')}<textarea maxLength={4000} rows={2} value={feedback} disabled={pending} onChange={event => setFeedback(event.target.value)} placeholder={t('approval.feedbackPlaceholder')} /></label>
      <div className="pd-extension-request-actions"><button type="button" className="pd-btn is-sm" disabled={pending} onClick={() => onRespond({ approved: false, scope: 'once', ...(feedback.trim() ? { feedback: feedback.trim() } : {}) })}>{t('approval.decline')}</button><button type="button" className="pd-btn is-sm is-primary" disabled={pending} onClick={() => onRespond({ approved: true, scope })}>{t('approval.allow')}</button></div>
    </>}
  </div>;
}
