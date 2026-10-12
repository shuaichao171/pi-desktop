import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('./') && context.parentURL && new URL(context.parentURL).pathname.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

test('error attribution classifies the three actionable families (4.4)', async () => {
  const { classifyAgentError } = await import('../packages/ui/src/errorAttribution.ts');

  await t('auth failures', () => {
    assert.equal(classifyAgentError('Request failed with 401 Unauthorized'), 'auth');
    assert.equal(classifyAgentError('invalid API key provided'), 'auth');
    assert.equal(classifyAgentError('鉴权失败：密钥无效'), 'auth');
  });

  await t('rate limiting', () => {
    assert.equal(classifyAgentError('429 Too Many Requests'), 'rate-limit');
    assert.equal(classifyAgentError('rate limit exceeded for provider'), 'rate-limit');
    assert.equal(classifyAgentError('请求被限流，请稍后再试'), 'rate-limit');
  });

  await t('context overflow', () => {
    assert.equal(classifyAgentError('context window exceeded'), 'context');
    assert.equal(classifyAgentError('prompt is too long: 200000 token limit'), 'context');
    assert.equal(classifyAgentError('上下文长度超限'), 'context');
  });

  await t('network errors and unknown text', () => {
    assert.equal(classifyAgentError('fetch failed: socket hang up'), 'network');
    assert.equal(classifyAgentError('请求超时'), 'network');
    assert.equal(classifyAgentError('something unexpected happened'), 'unknown');
    assert.equal(classifyAgentError(''), 'unknown');
  });

  await t('auth outranks later network words in the same message', () => {
    assert.equal(classifyAgentError('401 after network retry'), 'auth');
  });
});

test('structured evidence outranks message heuristics only when it matches (structured errors)', async () => {
  const { attributeAgentError } = await import('../packages/ui/src/errorAttribution.ts');
  const { normalizeAgentError } = await import('../packages/shared/src/agentErrors.ts');

  await t('structured kind wins over contradicting text', () => {
    const info = { message: 'provider rejected the request', kind: 'auth', source: 'provider' };
    assert.equal(attributeAgentError('provider rejected the request', info), 'auth');
    assert.equal(attributeAgentError('provider rejected the request', null), 'unknown');
  });

  await t('stale structured evidence falls back to text classification', () => {
    const info = { message: 'older network failure', kind: 'network', source: 'transport' };
    assert.equal(attributeAgentError('429 Too Many Requests', info), 'rate-limit');
  });

  await t('prefix messages still accept structured evidence', () => {
    const info = { message: 'model call failed', kind: 'model-unavailable', source: 'provider' };
    assert.equal(attributeAgentError('前缀说明：model call failed，请重试', info), 'model-unavailable');
  });

  await t('normalizeAgentError prefers code/status evidence and safe defaults', () => {
    const auth = normalizeAgentError({ message: 'request denied', code: 'invalid_api_key', status: 401 });
    assert.equal(auth.kind, 'auth');
    assert.equal(auth.source, 'provider');
    assert.equal(auth.status, 401);

    const throttled = normalizeAgentError({ message: 'slow down', status: 429 });
    assert.equal(throttled.kind, 'rate-limit');
    assert.equal(throttled.retryable, true);

    const nested = normalizeAgentError(new Error('outer message', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) }));
    assert.equal(nested.detail, 'socket hang up');
    assert.equal(nested.code, 'ECONNRESET');
    assert.equal(nested.source, 'transport');
  });

  await t('explicit structured kind survives normalization (model send gate)', async () => {
    const { createAgentError } = await import('../packages/shared/src/agentErrors.ts');
    const gate = normalizeAgentError(createAgentError({ message: '当前模型 X 不支持图片输入，请移除图片或切换模型。', kind: 'model-unavailable' }));
    assert.equal(gate.kind, 'model-unavailable');
    assert.equal(gate.source, 'provider');
    const textOnly = normalizeAgentError({ message: 'provider crashed unexpectedly' });
    assert.equal(textOnly.kind, 'unknown');
    assert.equal(textOnly.source, 'runtime');
  });
});

async function t(name, run) { await test(name, run); }
