import type { ModelTestRequest, ModelTestResult } from '../../shared/src/managementFeatures.ts';
import type { createAgentSessionRuntime } from '@earendil-works/pi-coding-agent';
type ModelRuntime = Awaited<ReturnType<typeof createAgentSessionRuntime>>['session']['modelRuntime'];

export class ModelTestService {
  private active = new Map<string, AbortController>();
  async test(runtime: ModelRuntime, request: ModelTestRequest): Promise<ModelTestResult> {
    if (!request || !/^[\w-]{1,100}$/.test(request.requestId) || typeof request.provider !== 'string' || typeof request.model !== 'string' || request.provider.length > 200 || request.model.length > 400) throw new Error('模型测试参数无效');
    if (this.active.has(request.requestId)) throw new Error('此模型测试仍在运行');
    if (this.active.size >= 3) throw new Error('最多同时测试三个模型');
    const controller = new AbortController(); this.active.set(request.requestId, controller);
    const started = Date.now(); let timeout = false;
    const timer = setTimeout(() => { timeout = true; controller.abort(); }, 20000);
    const result = (ok: boolean, error: string | null): ModelTestResult => ({ requestId: request.requestId, provider: request.provider, model: request.model, ok, elapsedMs: Date.now() - started, error });
    try {
      const model = runtime.getModel(request.provider, request.model);
      if (!model) return result(false, '指定模型不存在；请先保存供应商和模型');
      const message = await runtime.completeSimple(model, { messages: [{ role: 'user', content: 'Reply with OK.', timestamp: Date.now() }] }, { maxTokens: 16, maxRetries: 0, timeoutMs: 20_000, signal: controller.signal });
      if (controller.signal.aborted) return result(false, timeout ? '模型测试超过 20 秒' : '已取消模型测试');
      if (message.stopReason !== 'stop' && message.stopReason !== 'length') return result(false, classify(message.errorMessage ?? message.stopReason));
      if (!message.content.some(block => block.type === 'text' && block.text.trim())) return result(false, '模型未返回完整文本响应');
      return result(true, null);
    } catch (error) {
      return result(false, controller.signal.aborted ? timeout ? '模型测试超过 20 秒' : '已取消模型测试' : classify(error instanceof Error ? error.message : String(error)));
    } finally { clearTimeout(timer); this.active.delete(request.requestId); }
  }
  cancel(id: string): void { this.active.get(id)?.abort(); }
  dispose(): void { for (const controller of this.active.values()) controller.abort(); }
}
/** Deliberately never return provider response bodies, headers, URLs or credentials. */
function classify(text: string): string {
  if (/\b401\b|unauthorized|invalid.api.key/i.test(text)) return '推理鉴权失败（401），请检查凭据';
  if (/\b403\b|forbidden/i.test(text)) return '推理访问被拒绝（403）';
  if (/\b404\b|model.*not.found/i.test(text)) return '推理端点或模型不存在（404）';
  if (/\b429\b|rate.limit/i.test(text)) return '供应商限流（429），请稍后测试';
  if (/abort|timeout|timed.out/i.test(text)) return '推理请求超时或被取消';
  return '推理失败或响应不完整，请检查协议、代理及模型配置';
}
