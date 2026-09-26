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

async function t(name, run) { await test(name, run); }
