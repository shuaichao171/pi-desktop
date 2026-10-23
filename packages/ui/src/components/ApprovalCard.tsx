import { useState } from 'react';
import type { UiApprovalDecision, UiApprovalDetails, UiApprovalScope } from '@pidesktop/shared';
import { useT } from '../i18n';
import './approvalCard.css';

export function ApprovalCard({ approval, pending, onRespond }: { approval: UiApprovalDetails; pending: boolean; onRespond: (decision: UiApprovalDecision) => void }) {
  const { t } = useT();
  const [scope, setScope] = useState<UiApprovalScope>('once');
  const [feedback, setFeedback] = useState('');
  const scopes = approval.scopes ?? ['once'];
  const names: Record<UiApprovalScope, string> = { once: t('approval.scopeOnce'), session: t('approval.scopeSession'), workspace: t('approval.scopeWorkspace') };
  return <div className="pd-approval-card">
    {approval.source && <p className="pd-approval-source">{t('approval.requestedBy')}：{approval.source}</p>}
    {approval.cwd && <p>{t('approval.workingDirectory')}：<code>{approval.cwd}</code></p>}
    {approval.command && <div><strong>{t('approval.command')}</strong><pre className="pd-approval-command">{approval.command}</pre></div>}
    {approval.files?.map((file, index) => <details key={`${index}-${file.path}`} open={approval.files?.length === 1} className="pd-approval-file">
      <summary>{file.path}</summary>{file.diff !== undefined ? <pre className="pd-approval-diff">{file.diff.split('\n').map((line, lineIndex) => <span key={lineIndex} className={line.startsWith('+') ? 'is-addition' : line.startsWith('-') ? 'is-deletion' : undefined}>{line}{'\n'}</span>)}</pre> : <p>{t('approval.noPreview')}</p>}
    </details>)}
    <label className="pd-approval-scope">{t('approval.scope')}<select value={scope} disabled={pending} onChange={event => setScope(event.target.value as UiApprovalScope)}>{scopes.map(value => <option key={value} value={value}>{names[value]}</option>)}</select></label>
    <label className="pd-approval-feedback">{t('approval.feedback')}<textarea maxLength={4000} rows={2} value={feedback} disabled={pending} onChange={event => setFeedback(event.target.value)} placeholder={t('approval.feedbackPlaceholder')} /></label>
    <div className="pd-extension-request-actions"><button type="button" disabled={pending} onClick={() => onRespond({ approved: false, scope: 'once', ...(feedback.trim() ? { feedback: feedback.trim() } : {}) })}>{t('approval.decline')}</button><button type="button" className="is-primary" disabled={pending} onClick={() => onRespond({ approved: true, scope })}>{t('approval.allow')}</button></div>
  </div>;
}
