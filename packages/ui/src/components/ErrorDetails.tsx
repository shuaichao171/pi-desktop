import { useEffect, useMemo, useRef, useState } from 'react';
import type { UiAgentError, UiDiagnosticEvent } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { createErrorReport } from '../errorReport';
import './errorRecovery.css';

export function ErrorDetails({ error, scope = 'conversation', kind = 'operation-error', status, info }: { error: string; scope?: UiDiagnosticEvent['scope']; kind?: 'render-error' | 'operation-error'; status?: string; info?: UiAgentError | null }) {
  const { t } = useT();
  const bridge = useChatStore(state => state.bridge);
  const report = useMemo(() => createErrorReport(error, scope, kind, status, info), [error, scope, kind, status, info]);
  const current = useRef(report.id); current.current = report.id;
  const [notice, setNotice] = useState('');
  const [exporting, setExporting] = useState(false);
  useEffect(() => {
    setNotice('');
    if (typeof bridge?.recordUiDiagnostic === 'function') void Promise.resolve().then(() => bridge.recordUiDiagnostic(report.diagnostic)).catch(() => {});
  }, [bridge, report]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(report.text); if (current.current === report.id) setNotice(t('errorDetails.copied')); }
    catch { if (current.current === report.id) setNotice(t('errorDetails.copyFailed')); }
  };
  const exportLogs = async () => {
    if (!bridge?.exportDiagnostics || exporting) return;
    setExporting(true);
    try {
      await bridge.recordUiDiagnostic?.(report.diagnostic);
      const result = await bridge.exportDiagnostics(1);
      if (current.current === report.id) setNotice(result.path ? t('errorDetails.exported') : t('errorDetails.exportCancelled'));
    } catch { if (current.current === report.id) setNotice(t('errorDetails.exportFailed')); }
    finally { setExporting(false); }
  };
  return <div className="pd-error-details">
    <details><summary>{t('errorDetails.title')}</summary><pre>{report.text}</pre></details>
    <div className="pd-error-tools"><button type="button" onClick={() => void copy()}>{t('errorDetails.copyFull')}</button>{typeof bridge?.exportDiagnostics === 'function' && <button type="button" disabled={exporting} onClick={() => void exportLogs()}>{exporting ? t('errorDetails.exporting') : t('errorDetails.export')}</button>}</div>
    <small>{t('errorDetails.diagnosticId')}：{report.id}</small>{notice && <span role="status">{notice}</span>}
  </div>;
}
