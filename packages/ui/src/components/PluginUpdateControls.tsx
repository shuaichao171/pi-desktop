import { useEffect, useRef, useState } from 'react';
import type { PluginUpdatePreview, UiPluginPackage } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
export function PluginUpdateControls({ item, cwd, canInstall, install }: { item: UiPluginPackage; cwd: string; canInstall: boolean; install(previewId: string): Promise<boolean> }) {
  const { locale } = useT(), zh = locale === 'zh-CN'; const bridge = useChatStore(s => s.bridge);
  const [result, setResult] = useState<PluginUpdatePreview | null>(null), [checking, setChecking] = useState(false), [installing, setInstalling] = useState(false), [error, setError] = useState(''); const request = useRef(0);
  useEffect(() => { request.current++; setResult(null); setError(''); setChecking(false); setInstalling(false); return () => { request.current++; }; }, [cwd, item.source, item.version, item.scope]);
  async function check(latest = false) {
    if (!bridge || checking || installing) return; const id = ++request.current; setChecking(true); setError(''); setResult(null);
    try { const value = await bridge.checkPluginUpdate({ cwd, source: item.source, scope: item.scope, latest }); if (id === request.current) setResult(value); }
    catch (e) { if (id === request.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (id === request.current) setChecking(false); }
  }
  async function confirm() {
    if (!result || !canInstall || checking || installing) return;
    const id = request.current, previewId = result.id; setInstalling(true); setError('');
    try { if (await install(previewId) && id === request.current) setResult(current => current?.id === previewId ? null : current); }
    catch (cause) { if (id === request.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (id === request.current) setInstalling(false); }
  }
  return <section className="pd-plugin-update-check"><button type="button" className="pd-plugin-button" disabled={checking || installing || !bridge} onClick={() => void check()}>{checking ? zh ? '检查中…' : 'Checking…' : zh ? '检查更新版本' : 'Check versions'}</button>{error && <p role="alert">{error}</p>}{result && <div className="pd-plugin-update-preview"><dl><div><dt>{zh ? '已安装' : 'Installed'}</dt><dd>{result.installed || '—'}</dd></div><div><dt>{zh ? '当前约束' : 'Constraint'}</dt><dd>{result.constraint}</dd></div><div><dt>{zh ? '准确目标' : 'Exact target'}</dt><dd>{result.target || '—'}</dd></div><div><dt>{zh ? '检查时间' : 'Checked'}</dt><dd>{new Date(result.checkedAt).toLocaleString(locale)}</dd></div></dl><p role="status">{result.message}</p>{result.targetSource && <code>{result.targetSource}</code>}<div className="pd-management-actions">{result.latest && result.latest !== result.target && <button type="button" className="pd-plugin-button" disabled={checking || installing} onClick={() => void check(true)}>{zh ? `查看最新版本 ${result.latest}` : `Preview latest ${result.latest}`}</button>}{(result.kind === 'upgrade' || result.kind === 'repair') && <button type="button" className="pd-plugin-button is-primary" disabled={!canInstall || checking || installing} onClick={() => void confirm()}>{result.kind === 'repair' ? zh ? `确认修复 ${result.target}` : `Repair ${result.target}` : zh ? `确认安装 ${result.target}` : `Install ${result.target}`}</button>}</div></div>}</section>;
}
