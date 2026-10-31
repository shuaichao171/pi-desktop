import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMagicContextStore, normalizeMagicContextConfig } from '../packages/agent/src/compaction/magicContext.ts';

/** 用临时 XDG_CONFIG_HOME 承载 cortexkit 配置，避免读写本机真实配置。 */
async function withCortexConfig(initial, run) {
  const root = mkdtempSync(join(tmpdir(), 'pi-magic-'));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
  try {
    const path = join(root, 'cortexkit', 'magic-context.jsonc');
    mkdirSync(join(root, 'cortexkit'), { recursive: true });
    if (initial !== null) writeFileSync(path, initial, 'utf8');
    // 探测最新版本会打网络，注入必失败的 fetcher 让快照走本地分支
    return await run({ path, store: createMagicContextStore(async () => { throw new Error('offline'); }) });
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test('读取 historian.pi 块，pi 缺失的键才回落到旧顶层字段', () => {
  const fromPi = normalizeMagicContextConfig({
    enabled: true,
    historian: {
      model: 'legacy/model',
      thinking_level: 'low',
      pi: {
        model: 'boer/primary',
        thinking_level: 'xhigh',
        fallback_models: ['boer/first', { model: 'boer/second', thinking_level: 'max' }],
      },
    },
  });
  assert.equal(fromPi.historian.model, 'boer/primary');
  assert.equal(fromPi.historian.thinkingLevel, 'xhigh');
  assert.deepEqual(fromPi.historian.fallbackModels, ['boer/first', 'boer/second']);

  // 老版本桌面版写下的顶层层级：插件不识别，但读取时作为回落展示出来
  const legacy = normalizeMagicContextConfig({ historian: { model: 'legacy/model', thinking_level: 'low' } });
  assert.equal(legacy.historian.model, 'legacy/model');
  assert.equal(legacy.historian.thinkingLevel, 'low');
  assert.deepEqual(legacy.historian.fallbackModels, []);

  // pi.model 的对象形态：模型与嵌套推理级别一并读出
  const nested = normalizeMagicContextConfig({ historian: { pi: { model: { model: 'boer/nested', thinking_level: 'minimal' } } } });
  assert.equal(nested.historian.model, 'boer/nested');
  assert.equal(nested.historian.thinkingLevel, 'minimal');

  // 未知档位与非法备选项被忽略，不污染配置
  const invalid = normalizeMagicContextConfig({ historian: { pi: { thinking_level: 'none', fallback_models: [42, { thinking_level: 'low' }, 'boer/ok'] } } });
  assert.equal(invalid.historian.thinkingLevel, null);
  assert.deepEqual(invalid.historian.fallbackModels, ['boer/ok']);
});

test('保存写入 historian.pi，迁移旧层级键并保持其他设置不动', async () => {
  const initial = JSON.stringify({
    enabled: true,
    dreamer: { pi: { model: 'boer/dreamer' } },
    memory: { enabled: true },
    historian: {
      model: 'legacy/model',
      thinking_level: 'low',
      omp: { model: 'boer/omp' },
      pi: {
        model: 'boer/primary',
        thinking_level: 'high',
        fallback_models: [{ model: 'boer/first', thinking_level: 'max' }, 'boer/second'],
      },
    },
    embedding: { provider: 'openai-compatible', api_key: 'sk-secret' },
    compaction: { enabled: false },
  }, null, 2);

  await withCortexConfig(initial, async ({ path, store }) => {
    const snapshot = await store.snapshot(null);
    assert.equal(snapshot.config.historian.model, 'boer/primary');
    assert.equal(snapshot.config.historian.thinkingLevel, 'high');
    assert.deepEqual(snapshot.config.historian.fallbackModels, ['boer/first', 'boer/second']);

    // 未编辑：对象项保持原结构，旧层级键被清掉（值已在 pi 块内）
    const untouched = await store.save({ expectedVersion: snapshot.configVersion, config: snapshot.config });
    const kept = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(kept.historian.pi.fallback_models, [{ model: 'boer/first', thinking_level: 'max' }, 'boer/second']);
    assert.equal(kept.historian.model, undefined);
    assert.equal(kept.historian.thinking_level, undefined);
    assert.deepEqual(kept.historian.omp, { model: 'boer/omp' });
    assert.deepEqual(kept.dreamer, { pi: { model: 'boer/dreamer' } });
    assert.deepEqual(kept.memory, { enabled: true });
    assert.equal(kept.embedding.api_key, 'sk-secret');
    assert.deepEqual(kept.compaction, { enabled: false });

    // 编辑：模型与备选链写进 pi 块，空行被丢弃
    const edited = {
      ...untouched.config,
      historian: { model: 'boer/next', fallbackModels: ['boer/second', ''], thinkingLevel: 'minimal' },
    };
    const saved = await store.save({ expectedVersion: untouched.configVersion, config: edited });
    const written = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(written.historian.pi, { model: 'boer/next', thinking_level: 'minimal', fallback_models: ['boer/second'] });
    assert.deepEqual(written.dreamer, { pi: { model: 'boer/dreamer' } });
    assert.deepEqual(saved.config.historian, { model: 'boer/next', fallbackModels: ['boer/second'], thinkingLevel: 'minimal' });
  });
});
