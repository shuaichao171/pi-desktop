import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const hookModule = new URL('../packages/desktop/src/main/piExtensionCache.ts', import.meta.url).href;
const { shareExtensionCacheAcrossCwds } = await import('../packages/desktop/src/main/piExtensionCache.ts');

async function fixture(t, prefix) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('the shared extension cache patch matches the bundled SDK loader exactly and nothing else', async () => {
  const loaderUrl = new URL('./core/extensions/loader.js', import.meta.resolve('@earendil-works/pi-coding-agent'));
  const source = await readFile(loaderUrl, 'utf8');
  const patched = shareExtensionCacheAcrossCwds(source);
  assert.ok(patched, 'the bundled SDK version must receive the shared cache; update piExtensionCache.ts when the SDK changes');
  assert.doesNotMatch(patched, /pathsEqual\(extensionCacheCwd, resolvedCwd\)/, 'a cwd change no longer clears the cache');
  assert.doesNotMatch(patched, /extensionCacheCwd === cacheToken\.cwd/, 'cache tokens no longer expire on a cwd change');
  assert.match(patched, /export function clearExtensionCache\(\) \{/, 'explicit reloads still clear the cache');
  assert.match(patched, /extensionCacheGeneration === cacheToken\.generation/, 'reload generations still invalidate in-flight loads');
  assert.equal(patched.length < source.length, true);
  // Any other loader shape (another SDK version) is left untouched.
  assert.equal(shareExtensionCacheAcrossCwds(source.replace('clearExtensionCache();\n    }\n    extensionCacheCwd', 'resetCache();\n    }\n    extensionCacheCwd')), null);
  assert.equal(shareExtensionCacheAcrossCwds('export const unrelated = 1;\n'), null);
});

/** Loads one extension through Pi's resource loader for cwd A, B, A, then reloads, in a fresh process. */
function countExtensionEvaluations(root, withHook) {
  const script = `
    const [hook, agentDir, extension, ...cwds] = process.argv.slice(1);
    if (hook !== 'off') (await import(hook)).installSharedExtensionCache();
    const { DefaultResourceLoader } = await import('@earendil-works/pi-coding-agent');
    const load = async (cwd) => {
      const loader = new DefaultResourceLoader({ cwd, agentDir, additionalExtensionPaths: [extension],
        noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
      await loader.reload();
      if (loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors));
      return loader;
    };
    for (const cwd of cwds) await load(cwd);
    const acrossDirectories = globalThis.__piDesktopExtensionEvaluations;
    const loader = await load(cwds[1]);
    await loader.reload();
    console.log(JSON.stringify({ acrossDirectories, afterReload: globalThis.__piDesktopExtensionEvaluations }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script,
    withHook ? hookModule : 'off', join(root, 'agent'), join(root, 'extension.ts'), join(root, 'a'), join(root, 'b'), join(root, 'a')], {
    cwd: repoRoot, encoding: 'utf8', env: { ...process.env, PI_CODING_AGENT_DIR: join(root, 'agent') }, timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

test('extension modules load once for every project the host serves; explicit reloads still re-import', async (t) => {
  const root = await fixture(t, 'pi-extension-cache-');
  await Promise.all(['agent', 'a', 'b'].map((name) => mkdir(join(root, name))));
  // A TypeScript extension, like real ones: jiti evaluates it again on every uncached load.
  await writeFile(join(root, 'extension.ts'),
    'const scope = globalThis as { __piDesktopExtensionEvaluations?: number };\nscope.__piDesktopExtensionEvaluations = (scope.__piDesktopExtensionEvaluations ?? 0) + 1;\nexport default function (): void {}\n');
  // The SDK alone re-imports on every directory change (the cost this fix removes).
  assert.deepEqual(countExtensionEvaluations(root, false), { acrossDirectories: 3, afterReload: 5 });
  assert.deepEqual(countExtensionEvaluations(root, true), { acrossDirectories: 1, afterReload: 2 });
});

test('conversation runtime initialization reports durations per phase', async (t) => {
  const root = await fixture(t, 'pi-init-timing-');
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  t.after(() => { if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir; });
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const { AgentService } = await import('../packages/agent/src/index.ts');
  const service = new AgentService();
  t.after(() => service.dispose());
  const timings = [];
  service.onInitTiming((timing) => timings.push(timing));
  await service.init({ cwd: workspace, fresh: true });
  await service.newSession();
  assert.equal(timings.length, 2);
  for (const timing of timings) {
    assert.equal(timing.kind, 'fresh');
    assert.equal(timing.outcome, 'success');
    for (const phase of ['teardown', 'open', 'trust', 'services', 'shellTools', 'session', 'runtime', 'bind', 'ready']) {
      assert.equal(typeof timing.phases[phase], 'number', `phase ${phase} is reported`);
    }
    const sum = Object.values(timing.phases).reduce((total, value) => total + value, 0);
    assert.ok(Math.abs(sum - timing.totalMs) < 5, 'phases partition the initialization');
    assert.ok(timing.maxStallMs >= 0);
    assert.deepEqual(Object.keys(timing).sort(), ['kind', 'maxStallMs', 'outcome', 'phases', 'totalMs'], 'durations only, no paths or ids');
  }
});

test('diagnostics keep named phase durations and drop anything else', async (t) => {
  const root = await fixture(t, 'pi-init-diagnostics-');
  const { DiagnosticsService } = await import('../packages/desktop/src/main/diagnostics.ts');
  const service = new DiagnosticsService(root);
  service.record({ stage: 'host', action: 'session-init', outcome: 'success', durationMs: 640.4, code: 'fresh',
    phases: { services: 246.55, bind: 388, maxStall: 93.3, 'C:/private': 1, negative: -1, huge: 1e12, label: 'secret' } });
  await service.flush();
  const record = JSON.parse((await readFile(join(root, 'events.jsonl'), 'utf8')).trim());
  assert.deepEqual(record.phases, { services: 246.6, bind: 388, maxStall: 93.3 });
  assert.equal(record.code, 'fresh');
  assert.equal(record.durationMs, 640);
  const archive = join(root, 'export.zip');
  await service.archive(archive, 1, {});
  const { unzipSync, strFromU8 } = (await import('node:module')).createRequire(new URL('../packages/desktop/package.json', import.meta.url))('fflate');
  const exported = JSON.parse(strFromU8(unzipSync(await readFile(archive))['events.jsonl']).trim());
  assert.deepEqual(exported.phases, { services: 246.6, bind: 388, maxStall: 93.3 });
});
