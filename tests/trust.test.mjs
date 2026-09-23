import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';

test('project extensions load only after Pi project trust is granted', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-trust-'));
  const workspace = join(tempRoot, 'workspace');
  const extensionDir = join(workspace, '.pi', 'extensions');
  const marker = join(tempRoot, 'extension-loaded');
  mkdirSync(extensionDir, { recursive: true });
  writeFileSync(join(extensionDir, 'marker.ts'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'loaded');\nexport default function () {}\n`);

  const previous = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map((name) => [name, process.env[name]]));
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, 'agent');
  process.env.PI_OFFLINE = '1';
  let service;
  try {
    const { AgentService } = await import('../packages/agent/src/index.ts');
    let prompts = 0;
    service = new AgentService(async () => { prompts += 1; return { trusted: false, remember: false }; });
    await service.init({ cwd: workspace });
    assert.equal(prompts, 1);
    assert.equal(existsSync(marker), false, 'project extension must not run before trust');
    await service.dispose();

    service = new AgentService(async () => { prompts += 1; return { trusted: true, remember: true }; });
    await service.init({ cwd: workspace });
    assert.equal(prompts, 2);
    assert.equal(existsSync(marker), true, 'trusted project extension should load');
    await service.dispose();

    service = new AgentService(async () => { throw new Error('remembered trust should skip the prompt'); });
    await service.init({ cwd: workspace });
    assert.equal(service.runtime.services.settingsManager.isProjectTrusted(), true,
      'remembered trust should survive a new service');
  } finally {
    await service?.dispose();
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    const resolvedTemp = resolve(tempRoot);
    const resolvedParent = realpathSync(tmpdir());
    if (!resolvedTemp.startsWith(resolvedParent + sep)) {
      throw new Error('Refusing to remove a test directory outside the temporary folder');
    }
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
});

test('overlapping session initialization is rejected before a second runtime is created', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-lifecycle-'));
  const workspace = join(tempRoot, 'workspace');
  mkdirSync(workspace);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, 'agent');
  let service;
  try {
    const { AgentService } = await import('../packages/agent/src/index.ts');
    service = new AgentService();
    const first = service.init({ cwd: workspace });
    await assert.rejects(service.init({ cwd: join(tempRoot, 'other') }), /会话正在切换/);
    await first;
    assert.equal(service.getSnapshot().cwd, workspace);
    assert.equal(service.getSnapshot().status, 'idle');
  } finally {
    await service?.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    const resolvedTemp = resolve(tempRoot);
    const resolvedParent = realpathSync(tmpdir());
    if (!resolvedTemp.startsWith(resolvedParent + sep)) {
      throw new Error('Refusing to remove a test directory outside the temporary folder');
    }
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
});
