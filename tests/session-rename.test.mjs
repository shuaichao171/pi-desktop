import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test('manual titles persist empty sessions and remain bound to their original workspace and runtime', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-session-rename-'));
  const workspace = join(root, 'workspace');
  const otherWorkspace = join(root, 'other');
  const extensionDir = join(workspace, '.pi', 'extensions');
  mkdirSync(extensionDir, { recursive: true }); mkdirSync(otherWorkspace);
  writeFileSync(join(extensionDir, 'rename-race.ts'), `
    export default function (pi) {
      pi.registerCommand('replace-during-rename', {
        handler: async (_args, ctx) => {
          await ctx.newSession({ setup: async () => {
            globalThis.__piRenameSetup.entered();
            await globalThis.__piRenameSetup.wait;
          } });
        },
      });
    }
  `);
  const previous = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map((key) => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent'); process.env.PI_OFFLINE = '1';
  let service;
  let reopened;
  const replacementStarted = deferred(); const releaseReplacement = deferred();
  globalThis.__piRenameSetup = { entered: replacementStarted.resolve, wait: releaseReplacement.promise };
  try {
    const { AgentService } = await import('../packages/agent/src/index.ts');
    service = new AgentService(async () => ({ trusted: true, remember: false }));
    await service.init({ cwd: workspace });
    const first = service.getSnapshot();

    await t.test('a named empty conversation is visible in lists and survives SDK reopening without fake messages', async () => {
      assert.equal(existsSync(first.sessionPath), false);
      await service.renameSession(first.sessionPath, '  中文标题\n第二行  ', workspace);
      const entry = (await service.listSessions(workspace)).find((item) => item.path === first.sessionPath);
      assert.equal(entry.name, '中文标题 第二行');
      assert.equal(entry.messageCount, 0);
      const lines = readFileSync(first.sessionPath, 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(lines.filter((item) => item.type === 'session').length, 1);
      assert.equal(lines.filter((item) => item.type === 'message').length, 0);
      assert.equal(lines.at(-1).type, 'session_info');
      await service.renameSession(first.sessionPath, 'Second title', workspace);
      assert.equal(service.active.runtime.session.sessionName, 'Second title');
      reopened = new AgentService(async () => ({ trusted: true, remember: false }));
      await reopened.init({ cwd: workspace, sessionPath: first.sessionPath });
      assert.equal(reopened.active.runtime.session.sessionName, 'Second title');
      assert.equal(reopened.getSnapshot().sessionId, first.sessionId);
      await reopened.dispose(); reopened = null;
      // A subsequent first assistant append must use the SDK's append path,
      // not its exclusive-create path, which would now fail with EEXIST.
      const manager = service.active.runtime.session.sessionManager;
      manager.appendMessage({ role: 'user', content: 'First message', timestamp: Date.now() });
      manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'First reply' }],
        api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', timestamp: Date.now() });
      assert.equal((await service.listSessions(workspace))[0].messageCount, 2);
      assert.equal(readFileSync(first.sessionPath, 'utf8').trim().split('\n').map(JSON.parse).filter((item) => item.type === 'session').length, 1);
    });

    await t.test('an old path never renames another project or replacement session', async () => {
      await assert.rejects(service.renameSession(first.sessionPath, 'Wrong project', otherWorkspace), /工作区/);
      assert.equal(service.active.runtime.session.sessionName, 'Second title');
      const replacement = service.prompt('/replace-during-rename');
      await replacementStarted.promise;
      assert.notEqual(service.active.runtime.session.sessionId, first.sessionId, 'the SDK has replaced the runtime before setup finishes');
      assert.equal(service.getSnapshot().sessionPath, first.sessionPath, 'the public snapshot is still the outgoing session during setup');
      await assert.rejects(service.renameSession(first.sessionPath, 'Must not leak', workspace), /切换/);
      releaseReplacement.resolve(true); await replacement;
      assert.equal(service.active.runtime.session.sessionName, undefined);
      assert.equal((await service.listSessions(workspace)).find((item) => item.path === first.sessionPath).name, 'Second title');
      await service.renameSession(first.sessionPath, 'Background title', workspace);
      assert.equal((await service.listSessions(workspace)).find((item) => item.path === first.sessionPath).name, 'Background title');
      assert.equal(service.active.runtime.session.sessionName, undefined);
    });
  } finally {
    releaseReplacement.resolve(true);
    await reopened?.dispose(); await service?.dispose();
    delete globalThis.__piRenameSetup;
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const resolvedRoot = resolve(root);
    if (!resolvedRoot.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('Unsafe temporary path');
    rmSync(resolvedRoot, { recursive: true, force: true });
  }
});
