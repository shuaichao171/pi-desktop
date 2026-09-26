import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('deletion evicts idle cached writers and reserves loaded and unloaded session paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-agent-deletion-'));
  const workspace = join(root, 'workspace');
  const other = join(root, 'other');
  mkdirSync(workspace); mkdirSync(other);
  const environment = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map((name) => [name, process.env[name]]));
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  process.env.PI_OFFLINE = '1';
  let service;
  try {
    const { AgentService } = await import('../packages/agent/src/index.ts');
    service = new AgentService();
    await service.init({ cwd: workspace });
    const path = service.getSnapshot().sessionPath;
    const original = service.active;
    await service.renameSession(path, 'Saved conversation');
    await assert.rejects(service.prepareSessionDeletion(path, workspace), /先切换/);
    await service.newSession();
    await assert.rejects(service.prepareSessionDeletion(path, other), /不属于/);
    assert.ok([...service.contexts.values()].includes(original));
    await service.prepareSessionDeletion(path, workspace);
    assert.ok(![...service.contexts.values()].includes(original));
    assert.equal(original.hasSession, false, 'all writers are disposed before the file can move');
    await assert.rejects(service.switchSession(path), /删除/);
    await assert.rejects(service.init({ cwd: workspace, sessionPath: path }), /删除/);
    await assert.rejects(service.renameSession(path, 'Must not write', workspace), /删除/);
    assert.throws(() => service.active.reserveSessionSwitch(path), /删除/);
    if (process.platform === 'win32') await assert.rejects(service.switchSession(path.toUpperCase()), /删除/, 'Windows aliases share the deletion reservation');
    service.releaseSessionDeletion(path);

    // No cached runtime remains, but this path must still be reserved while
    // a cross-device trash copy is in progress.
    await service.prepareSessionDeletion(path, workspace);
    await assert.rejects(service.switchSession(path), /删除/);
    unlinkSync(path);
    service.releaseSessionDeletion(path);
    await assert.rejects(service.switchSession(path), /不属于/);
    assert.equal(existsSync(path), false);

    const activePath = service.getSnapshot().sessionPath;
    await service.renameSession(activePath, 'Second conversation');
    await service.switchWorkspace(other);
    await service.prepareSessionDeletion(activePath, workspace);
    await assert.rejects(service.switchWorkspace(workspace), /删除/);
    service.releaseSessionDeletion(activePath);
    await service.switchWorkspace(workspace);
    assert.equal(service.getSnapshot().sessionPath, activePath, 'a failed move can release the reservation and reopen safely');
  } finally {
    await service?.dispose().catch(() => {});
    rmSync(root, { recursive: true, force: true });
    for (const [name, value] of environment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
