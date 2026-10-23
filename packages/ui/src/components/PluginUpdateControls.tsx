import { useEffect, useRef, useState } from 'react';
import type { PluginUpdatePreview, UiPluginPackage } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { formatDate } from '../dateFormat';
export function PluginUpdateControls({ item, cwd, canInstall, install }: { item: UiPluginPackage; cwd: string; canInstall: boolean; install(previewId: string): Promise<boolean> }) {
  const { t, locale } = useT(); const bridge = useChatStore(s => s.bridge);
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
  return <section className="pd-plugin-update-check"><div className="pd-plugin-update-head"><div><strong>{t('pluginUpdate.title')}</strong><span>{t('pluginUpdate.description')}</span></div><button type="button" className="pd-plugin-button" disabled={checking || installing || !bridge} onClick={() => void check()}>{checking ? t('pluginUpdate.checking') : t('pluginUpdate.check')}</button></div>{error && <p role="alert" className="pd-plugin-update-error">{error}</p>}{result && <div className="pd-plugin-update-preview"><dl><div><dt>{t('pluginUpdate.installed')}</dt><dd>{result.installed || '—'}</dd></div><div><dt>{t('pluginUpdate.constraint')}</dt><dd>{result.constraint}</dd></div><div><dt>{t('pluginUpdate.target')}</dt><dd>{result.target || '—'}</dd></div><div><dt>{t('pluginUpdate.checkedAt')}</dt><dd>{formatDate(result.checkedAt, locale, { time: true })}</dd></div></dl><p role="status" className="pd-plugin-update-message">{result.message}</p>{result.targetSource && <code>{result.targetSource}</code>}<div className="pd-management-actions">{result.latest && result.latest !== result.target && <button type="button" className="pd-plugin-button" disabled={checking || installing} onClick={() => void check(true)}>{t('pluginUpdate.previewLatest', { version: result.latest })}</button>}{(result.kind === 'upgrade' || result.kind === 'repair') && <button type="button" className="pd-plugin-button is-primary" disabled={!canInstall || checking || installing} onClick={() => void confirm()}>{result.kind === 'repair' ? t('pluginUpdate.repair', { version: result.target ?? '' }) : t('pluginUpdate.install', { version: result.target ?? '' })}</button>}</div></div>}</section>;
}
