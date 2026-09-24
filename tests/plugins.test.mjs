import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node:os' && context.parentURL?.endsWith('/core/package-manager.js')) {
      return { url: `data:text/javascript,${encodeURIComponent('export * from "node:os"; export const homedir = () => globalThis.__pluginTestHome;')}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { SettingsManager, DefaultPackageManager } = await import('@earendil-works/pi-coding-agent');
const { readPluginCatalog, applyPluginMutation, readPluginResourcePreview } = await import('../packages/agent/src/plugins.ts');
const emptyPaths = () => ({ extensions: [], skills: [], prompts: [], themes: [] });

async function fixture(t, trusted = true) {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, 'pi-plugins-'));
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  const plugin = join(root, 'local-plugin');
  globalThis.__pluginTestHome = root;
  for (const dir of [join(cwd, '.git'), agentDir, join(plugin, 'extensions'), join(plugin, 'skills', 'review'), join(plugin, 'skills', 'second'), join(plugin, 'prompts'), join(plugin, 'themes')]) await mkdir(dir, { recursive: true });
  const extension = join(plugin, 'extensions', 'example.ts');
  const skill = join(plugin, 'skills', 'review', 'SKILL.md');
  const secondSkill = join(plugin, 'skills', 'second', 'SKILL.md');
  const prompt = join(plugin, 'prompts', 'summary.md');
  await Promise.all([
    writeFile(join(plugin, 'package.json'), JSON.stringify({ name: 'local-review', description: '本地审查资源', version: '1.2.3', pi: { extensions: ['extensions/example.ts'], skills: ['skills'], prompts: ['prompts'], themes: ['themes'] } })),
    writeFile(extension, 'throw new Error("Catalog must never execute this extension");'),
    writeFile(skill, '---\nname: review\ndescription: 审查变更\n---\nRead the project changes.'),
    writeFile(secondSkill, '---\nname: second\ndescription: 第二项\n---\nAnother skill.'),
    writeFile(prompt, '---\ndescription: 总结工作\n---\nSummarize $ARGUMENTS.'),
    writeFile(join(plugin, 'themes', 'custom.json'), '{"name":"custom"}'),
  ]);
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
  const loaded = { extensions: [], errors: [], skills: [], skillDiagnostics: [], prompts: [], promptDiagnostics: [], themes: [], themeDiagnostics: [] };
  const resourceLoader = {
    getExtensions: () => ({ extensions: loaded.extensions, errors: loaded.errors }),
    getSkills: () => ({ skills: loaded.skills, diagnostics: loaded.skillDiagnostics }),
    getPrompts: () => ({ prompts: loaded.prompts, diagnostics: loaded.promptDiagnostics }),
    getThemes: () => ({ themes: loaded.themes, diagnostics: loaded.themeDiagnostics }),
    reload: async () => { throw new Error('Business helpers must not reload runtime code'); },
  };
  const services = { cwd, agentDir, settingsManager, resourceLoader };
  const change = (input, dependencies) => applyPluginMutation(services, { cwd, scope: 'user', ...input }, dependencies);
  t.after(async () => {
    await settingsManager.flush();
    assert.equal(dirname(root), temp);
    await rm(root, { recursive: true, force: true });
  });
  return { root, cwd, agentDir, plugin, extension, skill, secondSkill, prompt, settingsManager, loaded, services, change };
}

test('local package add/catalog/remove persists configuration without executing or deleting its source', async (t) => {
  const f = await fixture(t);
  await f.change({ action: 'install', source: f.plugin });
  const catalog = await readPluginCatalog(f.services);
  assert.equal(catalog.packages.length, 1);
  assert.deepEqual({ name: catalog.packages[0].name, version: catalog.packages[0].version, installed: catalog.packages[0].installed }, { name: 'local-review', version: '1.2.3', installed: true });
  assert.deepEqual([...new Set(catalog.resources.map((resource) => resource.kind))], ['extensions', 'skills', 'prompts', 'themes']);
  assert.ok(catalog.resources.every((resource) => resource.enabled && !resource.loaded && resource.canToggle));
  assert.equal(catalog.resources.find((resource) => resource.path === f.skill).description, '审查变更');
  const saved = JSON.parse(await readFile(join(f.agentDir, 'settings.json'), 'utf8'));
  assert.equal(saved.packages.length, 1);
  assert.equal(saved.packages[0], relative(f.agentDir, f.plugin));
  await f.change({ action: 'remove', source: catalog.packages[0].source });
  assert.deepEqual((await readPluginCatalog(f.services)).packages, []);
  assert.match(await readFile(f.extension, 'utf8'), /Catalog must never execute/);
  assert.match(await readFile(f.skill, 'utf8'), /Read the project/);
});

test('resource toggles persist per-resource choices and enabling one from [] does not enable its siblings', async (t) => {
  const f = await fixture(t);
  await f.change({ action: 'install', source: f.plugin });
  const source = f.settingsManager.getGlobalSettings().packages[0];
  f.settingsManager.setPackages([{ source, skills: [] }]);
  await f.settingsManager.flush();
  await f.change({ action: 'set-enabled', path: f.skill, kind: 'skills', enabled: true });
  let catalog = await readPluginCatalog(f.services);
  assert.equal(catalog.resources.find((item) => item.path === f.skill).enabled, true);
  assert.equal(catalog.resources.find((item) => item.path === f.secondSkill).enabled, false);
  await f.change({ action: 'set-enabled', path: f.skill, kind: 'skills', enabled: false });
  catalog = await readPluginCatalog(f.services);
  assert.ok(catalog.resources.filter((item) => item.kind === 'skills').every((item) => !item.enabled));
  assert.ok(catalog.resources.filter((item) => item.kind !== 'skills').every((item) => item.enabled));
  await assert.rejects(f.change({ action: 'set-enabled', path: f.skill, kind: 'prompts', enabled: true }), /未找到/);
  await assert.rejects(f.change({ action: 'set-enabled', path: f.skill, kind: 'skills', scope: 'project', enabled: true }), /未找到/);
  await assert.rejects(f.change({ action: 'set-enabled', path: 'relative.md', kind: 'skills', enabled: true }), /绝对路径/);
  f.settingsManager.setPackages([{ source, skills: ['skills/review/SKILL.md', '!+skills/review/SKILL.md'] }]);
  await f.settingsManager.flush();
  await f.change({ action: 'set-enabled', path: f.skill, kind: 'skills', enabled: false });
  assert.deepEqual(f.settingsManager.getGlobalSettings().packages[0].skills, ['skills/review/SKILL.md', '-skills/review/SKILL.md']);
  assert.ok((await readPluginCatalog(f.services)).resources.filter((item) => item.kind === 'skills').every((item) => !item.enabled), 'disabling an allowlisted resource must preserve the allowlist');
});

test('project scope respects trust and top-level resources use their own scope settings', async (t) => {
  const f = await fixture(t, false);
  await assert.rejects(f.change({ action: 'install', source: f.plugin, scope: 'project' }), /尚未受信任/);
  assert.equal((await readPluginCatalog(f.services)).projectTrusted, false);
  f.settingsManager.setProjectTrusted(true);
  const promptDir = join(f.cwd, '.pi', 'prompts');
  await mkdir(promptDir, { recursive: true });
  const path = join(promptDir, 'local.md');
  await writeFile(path, 'Project prompt.');
  await f.change({ action: 'set-enabled', path, kind: 'prompts', scope: 'project', enabled: false });
  assert.ok(f.settingsManager.getProjectSettings().prompts.some((entry) => entry.startsWith('-')));
  assert.equal(f.settingsManager.getGlobalSettings().prompts, undefined);
  assert.equal((await readPluginCatalog(f.services)).resources.find((item) => item.path === path).enabled, false);
  await f.change({ action: 'set-enabled', path, kind: 'prompts', scope: 'project', enabled: true });
  assert.equal((await readPluginCatalog(f.services)).resources.find((item) => item.path === path).enabled, true);
});

test('catalog merges actual loaded metadata and diagnostics, and never advertises unsupported single-file toggles', async (t) => {
  const f = await fixture(t);
  f.settingsManager.setPackages([f.extension]);
  await f.settingsManager.flush();
  f.loaded.errors.push({ path: f.extension, error: 'Extension loading failed' });
  const catalog = await readPluginCatalog(f.services);
  assert.equal(catalog.resources[0].canToggle, false);
  assert.equal(catalog.resources[0].error, 'Extension loading failed');
  assert.ok(catalog.warnings.some((warning) => warning.includes('Extension loading failed')));
  await assert.rejects(f.change({ action: 'set-enabled', path: f.extension, kind: 'extensions', enabled: false }), /不支持单独/);
  await assert.rejects(f.change({ action: 'install', source: f.extension }), /必须是目录/);
  f.settingsManager.setPackages([f.plugin]);
  await f.settingsManager.flush();
  f.loaded.skills.push({ filePath: f.skill, name: 'Runtime skill title', description: 'Runtime description' });
  const resource = (await readPluginCatalog(f.services)).resources.find((item) => item.path === f.skill);
  assert.equal(resource.name, 'Runtime skill title');
  assert.equal(resource.loaded, true);
});

test('preview is restricted to discovered text resources and bounds large UTF-8 content', async (t) => {
  const f = await fixture(t);
  await f.change({ action: 'install', source: f.plugin });
  const request = { cwd: f.cwd, path: f.prompt, kind: 'prompts', scope: 'user' };
  const preview = await readPluginResourcePreview(f.services, request);
  assert.match(preview.text, /Summarize/);
  assert.equal(preview.truncated, false);
  await assert.rejects(readPluginResourcePreview(f.services, { ...request, path: join(f.plugin, 'package.json') }), /未找到/);
  await assert.rejects(readPluginResourcePreview(f.services, { ...request, kind: 'extensions', path: f.extension }), /仅支持/);
  await assert.rejects(readPluginResourcePreview(f.services, { ...request, cwd: f.root }), /项目已改变/);
  await assert.rejects(readPluginResourcePreview(f.services, { ...request, scope: 'project' }), /未找到/);
  await writeFile(f.prompt, '中文'.repeat(20_000));
  const bounded = await readPluginResourcePreview(f.services, request);
  assert.equal(bounded.truncated, true);
  assert.ok(Buffer.byteLength(bounded.text) <= 65_536);
  assert.doesNotMatch(bounded.text, /�/);
});

test('remote source validation rejects options and credential URLs before any manager mutation', async (t) => {
  const f = await fixture(t);
  const calls = [];
  const dependencies = { createManager: () => ({ installAndPersist: async (...args) => calls.push(args), listConfiguredPackages: () => [] }) };
  for (const source of ['npm:--global', 'npm:../../escape', 'npm:valid@--prefix=x', 'npm:valid@file:./secret', 'git:https://user:password@example.com/org/repo', 'http://example.com/org/repo', 'git:github.com/org/repo', 'https://example.com/org/../repo', 'https://example.com/org/repo?token=x', 'https://example.com/org/repo@--bad']) {
    await assert.rejects(f.change({ action: 'install', source }, dependencies), undefined, source);
  }
  assert.equal(calls.length, 0);
  for (const source of ['npm:@example/pi-tools@1.2.3', 'npm:pi-tools@latest', 'git:https://example.com/org/repo@v1']) await f.change({ action: 'install', source }, dependencies);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(([, options]) => options.local === false));
});

test('catalog retains missing and version-mismatched packages without requesting installation', async (t) => {
  const f = await fixture(t);
  const seen = [];
  const dependencies = { createManager: () => ({
    listConfiguredPackages: () => [{ source: 'npm:missing', scope: 'user', filtered: false }, { source: 'npm:wrong@2.0.0', scope: 'user', filtered: false, installedPath: f.plugin }],
    resolve: async (onMissing) => { seen.push(await onMissing('npm:missing'), await onMissing('npm:wrong@2.0.0')); return emptyPaths(); },
  }) };
  const catalog = await readPluginCatalog(f.services, dependencies);
  assert.deepEqual(seen, ['skip', 'skip']);
  assert.ok(catalog.packages.every((item) => !item.installed));
  assert.equal(catalog.packages[1].path, f.plugin);
  assert.equal(catalog.warnings.length, 2);
});

test('malformed or unwritable settings produce errors instead of false mutation success', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.agentDir, 'settings.json'), '{ invalid');
  await assert.rejects(f.change({ action: 'install', source: f.plugin }), /配置读取失败/);
  assert.equal(await readFile(join(f.agentDir, 'settings.json'), 'utf8'), '{ invalid');
  const g = await fixture(t);
  const calls = [];
  const dependencies = { createManager: () => ({
    installAndPersist: async () => {
      calls.push('install');
      await mkdir(join(g.agentDir, 'settings.json'));
      g.settingsManager.setPackages([g.plugin]);
    },
  }) };
  await assert.rejects(g.change({ action: 'install', source: g.plugin }, dependencies), /配置保存失败/);
  assert.deepEqual(calls, ['install']);
});

test('update and remove reject sources outside the selected registered scope', async (t) => {
  const f = await fixture(t);
  const calls = [];
  const dependencies = { createManager: () => ({
    listConfiguredPackages: () => [{ source: 'npm:known', scope: 'user', filtered: false }],
    update: async (source) => calls.push(source),
    removeAndPersist: async () => { throw new Error('must not be called'); },
  }) };
  await assert.rejects(f.change({ action: 'update', source: 'npm:unknown' }, dependencies), /未找到/);
  await assert.rejects(f.change({ action: 'remove', source: 'npm:known', scope: 'project' }, dependencies), /未找到/);
  await f.change({ action: 'update', source: 'npm:known' }, dependencies);
  assert.deepEqual(calls, ['npm:known']);
});
