import { useEffect, useMemo, useRef, useState } from 'react';
import type { UiAgentError, UiDiagnosticEvent } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { createErrorReport } from '../errorReport';
import './errorRecovery.css';

export function ErrorDetails({ error, scope = 'conversation', kind = 'operation-error', status, info }: { error: string; scope?: UiDiagnosticEvent['scope']; kind?: 'render-error' | 'operation-error'; status?: string; info?: UiAgentError | null }) {
  const { locale } = useT();
  const label = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
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
    try { await navigator.clipboard.writeText(report.text); if (current.current === report.id) setNotice(label('已复制脱敏错误', 'Redacted error copied')); }
    catch { if (current.current === report.id) setNotice(label('复制失败，请展开详情手动复制', 'Copy failed; select the details to copy')); }
  };
  const exportLogs = async () => {
    if (!bridge?.exportDiagnostics || exporting) return;
    setExporting(true);
    try {
      await bridge.recordUiDiagnostic?.(report.diagnostic);
      const result = await bridge.exportDiagnostics(1);
      if (current.current === report.id) setNotice(result.path ? label('已导出关联诊断', 'Related diagnostics exported') : label('已取消导出', 'Export cancelled'));
    } catch { if (current.current === report.id) setNotice(label('诊断导出失败，请重试', 'Diagnostics export failed; try again')); }
    finally { setExporting(false); }
  };
  return <div className="pd-error-details">
    <details><summary>{label('错误详情', 'Error details')}</summary><pre>{report.text}</pre></details>
    <div className="pd-error-tools"><button type="button" onClick={() => void copy()}>{label('复制完整错误', 'Copy full error')}</button>{typeof bridge?.exportDiagnostics === 'function' && <button type="button" disabled={exporting} onClick={() => void exportLogs()}>{exporting ? label('正在导出…', 'Exporting…') : label('导出关联诊断', 'Export related diagnostics')}</button>}</div>
    <small>{label('诊断编号', 'Diagnostic ID')}：{report.id}</small>{notice && <span role="status">{notice}</span>}
  </div>;
}
