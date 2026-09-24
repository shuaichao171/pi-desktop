import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

test('real offline foreground sessions exclude a worker transcript and preserve their own unsaved draft', async () => {
  const temporaryParent = realpathSync(tmpdir());
  const root = mkdtempSync(join(temporaryParent, 'pi-automation-isolation-'));
  const workspace = join(root, 'project');
  const otherWorkspace = join(root, 'other-project');
  mkdirSync(workspace);
  mkdirSync(otherWorkspace);
  const previous = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map((key) => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = join(root, 'isolated-agent');
  process.env.PI_OFFLINE = '1';
  let worker;
  let foreground;
  try {
    const { AgentService } = await import('../packages/agent/src/index.ts');
    worker = new AgentService();
    await worker.init({ cwd: workspace, fresh: true });
    const background = worker.getSnapshot();
    assert.ok(background.sessionPath);
    // Renaming materializes an actual SDK session file without sending any
    // prompt or invoking a provider, tool, or user automation plan.
    await worker.renameSession(background.sessionPath, 'Running background fixture', workspace);
    const originalWorkerFile = readFileSync(background.sessionPath, 'utf8');

    foreground = new AgentService();
    await foreground.init({ cwd: workspace, excludeSessionPaths: [background.sessionPath] });
    const draft = foreground.getSnapshot();
    assert.notEqual(draft.sessionId, background.sessionId);
    assert.notEqual(draft.sessionPath, background.sessionPath);
    assert.deepEqual(draft.messages, []);
    assert.equal(existsSync(draft.sessionPath), false, 'skipping the only stored transcript must create a separate unsaved draft');

    await foreground.switchWorkspace(otherWorkspace);
    await foreground.switchWorkspace(workspace, [background.sessionPath]);
    assert.equal(foreground.getSnapshot().sessionId, draft.sessionId, 'returning to the workspace must reuse its foreground draft');
    assert.equal(foreground.getSnapshot().sessionPath, draft.sessionPath);
    assert.equal(existsSync(draft.sessionPath), false);
    assert.equal(readFileSync(background.sessionPath, 'utf8'), originalWorkerFile, 'workspace navigation cannot change the worker transcript');

    await foreground.renameSession(draft.sessionPath, 'Saved foreground fixture', workspace);
    await foreground.dispose();
    foreground = new AgentService();
    await foreground.init({ cwd: workspace, excludeSessionPaths: [background.sessionPath] });
    assert.equal(foreground.getSnapshot().sessionPath, draft.sessionPath, 'a fresh foreground host restores a permitted saved session');
    assert.equal(worker.getSnapshot().sessionPath, background.sessionPath, 'the independent worker keeps its own session');
  } finally {
    await Promise.allSettled([foreground?.dispose(), worker?.dispose()]);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    assert.equal(dirname(root), temporaryParent, 'only the test-owned temporary directory may be removed');
    rmSync(root, { recursive: true, force: true });
  }
});

test('automation model and thinking overrides preserve the saved defaults while manual changes still persist', async () => {
  const temporaryParent = realpathSync(tmpdir());
  const root = mkdtempSync(join(temporaryParent, 'pi-automation-defaults-'));
  const workspace = join(root, 'project');
  const agentDirectory = join(root, 'isolated-agent');
  mkdirSync(workspace);
  const previous = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map((key) => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  process.env.PI_OFFLINE = '1';
  let worker;
  let subsequent;
  try {
    const { AgentService } = await import('../packages/agent/src/index.ts');
    worker = new AgentService();
    await worker.init({ cwd: workspace, fresh: true });
    // The SDK validates availability locally. This isolated dummy credential
    // enables a catalog selection; the test never submits a model request.
    await worker.setProviderApiKey('anthropic', 'offline-automation-fixture-not-a-real-key');
    const models = worker.listModels().filter((model) => model.provider === 'anthropic' && model.reasoning);
    assert.ok(models.length >= 2);
    const [baselineModel, overrideModel] = models;
    await worker.setModel(baselineModel.provider, baselineModel.id);
    await worker.setThinkingLevel('low');
    const settings = worker.active.runtime.session.settingsManager;
    await settings.flush();
    const settingsPath = join(agentDirectory, 'settings.json');
    const baselineBytes = readFileSync(settingsPath, 'utf8');

    await worker.setModel(overrideModel.provider, overrideModel.id, false);
    await worker.setThinkingLevel('high', false);
    await settings.flush();
    assert.equal(worker.getSnapshot().model, overrideModel.id);
    assert.equal(worker.getSnapshot().thinkingLevel, 'high');
    assert.equal(readFileSync(settingsPath, 'utf8'), baselineBytes, 'a run-specific override must not rewrite global defaults');

    subsequent = new AgentService();
    await subsequent.init({ cwd: workspace, fresh: true });
    assert.equal(subsequent.getSnapshot().model, baselineModel.id, 'later sessions must retain the saved default model');
    assert.equal(subsequent.getSnapshot().thinkingLevel, 'low', 'later sessions must retain the saved thinking level');

    await worker.setModel(overrideModel.provider, overrideModel.id);
    await worker.setThinkingLevel('high');
    await settings.flush();
    const manualDefaults = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(manualDefaults.defaultModel, overrideModel.id);
    assert.equal(manualDefaults.defaultProvider, overrideModel.provider);
    assert.equal(manualDefaults.defaultThinkingLevel, 'high');
  } finally {
    await Promise.allSettled([worker?.dispose(), subsequent?.dispose()]);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    assert.equal(dirname(root), temporaryParent);
    rmSync(root, { recursive: true, force: true });
  }
});
