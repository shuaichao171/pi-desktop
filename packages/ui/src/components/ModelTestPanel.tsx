import { useEffect, useRef, useState } from 'react';
import type { ModelTestResult, UiModelSummary } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import './managementFeatures.css';
export function ModelTestPanel() {
  const { locale } = useT(), zh = locale === 'zh-CN'; const bridge = useChatStore(s => s.bridge), cwd = useChatStore(s => s.cwd);
  const [models, setModels] = useState<UiModelSummary[]>([]), [selected, setSelected] = useState(''), [result, setResult] = useState<ModelTestResult | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const active = useRef<string | null>(null);
  useEffect(() => { let alive = true; if (bridge) void bridge.listModels().then(value => { if (alive) { setModels(value); setSelected(value[0] ? JSON.stringify([value[0].provider, value[0].id]) : ''); } }).catch(e => alive && setError(String(e))); return () => { alive = false; if (active.current) void bridge?.cancelProviderModelTest(active.current); active.current = null; }; }, [bridge, cwd]);
  async function test() {
    if (!bridge || !selected || active.current) return;
    const requestId = crypto.randomUUID(), [provider, model] = JSON.parse(selected) as [string, string]; active.current = requestId; setBusy(true); setResult(null); setError('');
    try { const value = await bridge.testProviderModel({ requestId, provider, model }); if (active.current === requestId) setResult(value); }
    catch (e) { if (active.current === requestId) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (active.current === requestId) { active.current = null; setBusy(false); } }
  }
  return <section className="pd-management-feature pd-model-test" data-setting="model-test"><h3>{zh ? '测试实际推理' : 'Test model inference'}</h3><p>{zh ? '向已保存的模型发送一条最小请求，可能产生少量费用。20 秒超时，不写入聊天。' : 'Sends a minimal request to a saved model and may incur a small charge. Times out after 20 seconds; no chat history is created.'}</p><div className="pd-management-actions"><select aria-label={zh ? '选择测试模型' : 'Choose a model to test'} value={selected} onChange={e => { setSelected(e.target.value); setResult(null); }} disabled={busy}>{models.map(model => <option key={JSON.stringify([model.provider, model.id])} value={JSON.stringify([model.provider, model.id])}>{model.provider} / {model.name}</option>)}</select><button type="button" disabled={!selected || busy} onClick={() => void test()}>{busy ? zh ? '测试中…' : 'Testing…' : zh ? '发送测试请求' : 'Send test request'}</button>{busy && <button type="button" onClick={() => { if (active.current) void bridge?.cancelProviderModelTest(active.current); }}>{zh ? '取消' : 'Cancel'}</button>}</div>{result && <p role="status">{result.ok ? zh ? '推理成功' : 'Inference succeeded' : result.error} · {result.elapsedMs} ms</p>}{error && <p role="alert">{error}</p>}</section>;
}
