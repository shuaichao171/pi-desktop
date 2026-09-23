import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';

test('inactive Pi runtimes are bounded and an evicted session can be reopened', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-cache-'));
  const workspace = join(tempRoot, 'workspace');
  mkdirSync(workspace);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, 'agent');
  let service;
  try {
    const [{ AgentService }, { SessionManager }] = await Promise.all([
      import('../packages/agent/src/index.ts'),
      import('../packages/agent/node_modules/@earendil-works/pi-coding-agent/dist/index.js'),
    ]);
    const paths = [];
    for (let index = 0; index < 14; index += 1) {
      const manager = SessionManager.create(workspace);
      manager.appendMessage({ role: 'user', content: `Session ${index}`, timestamp: Date.now() });
      manager.appendMessage({
        role: 'assistant', content: [{ type: 'text', text: `Reply ${index}` }],
        api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', timestamp: Date.now(),
      });
      paths.push(manager.getSessionFile());
    }
    service = new AgentService();
    await service.init({ cwd: workspace });
    for (const path of paths) await service.switchSession(path);
    assert.ok(service.contexts.size <= 12, 'idle runtime cache should stay bounded');
    await service.switchSession(paths[0]);
    assert.equal(service.getSnapshot().messages[0]?.text, 'Session 0', 'evicted transcript should load from Pi storage');
  } finally {
    await service?.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    const resolvedTemp = resolve(tempRoot);
    if (!resolvedTemp.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('Unsafe temporary path');
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
});

test('Pi extension dialogs reach the desktop callback and a background session keeps running', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-multi-'));
  const workspace = join(tempRoot, 'workspace');
  const extensionDir = join(workspace, '.pi', 'extensions');
  const dialogMarker = join(tempRoot, 'dialogs.json');
  const commandMarker = join(tempRoot, 'command-done');
  mkdirSync(extensionDir, { recursive: true });
  writeFileSync(join(extensionDir, 'desktop-ui.ts'), `
    import { writeFileSync } from 'node:fs';
    export default function (pi) {
      pi.on('session_start', async (_event, ctx) => {
        const selected = await ctx.ui.select('Select model', ['A', 'B']);
        const input = await ctx.ui.input('Enter name', 'placeholder');
        const confirmed = await ctx.ui.confirm('Proceed?', 'Continue');
        const edited = await ctx.ui.editor('Edit', 'initial');
        writeFileSync(${JSON.stringify(dialogMarker)}, JSON.stringify({ selected, input, confirmed, edited }));
      });
      pi.registerCommand('desktop-delay', {
        description: 'Delayed command for runtime continuity test',
        handler: async () => {
          await new Promise((resolve) => setTimeout(resolve, 180));
          writeFileSync(${JSON.stringify(commandMarker)}, 'done');
        },
      });
    }
  `);

  const previous = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map((key) => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, 'agent');
  process.env.PI_OFFLINE = '1';
  let service;
  try {
    const { AgentService } = await import('../packages/agent/src/index.ts');
    const seen = [];
    service = new AgentService(
      async () => ({ trusted: true, remember: false }),
      async (request) => {
        seen.push(request.kind);
        if (request.kind === 'select') return 'B';
        if (request.kind === 'input') return 'Alice';
        if (request.kind === 'confirm') return true;
        if (request.kind === 'editor') return `${request.defaultValue} changed`;
        return null;
      },
    );
    await service.init({ cwd: workspace });
    assert.deepEqual(seen, ['select', 'input', 'confirm', 'editor']);
    assert.deepEqual(JSON.parse(readFileSync(dialogMarker, 'utf8')),
      { selected: 'B', input: 'Alice', confirmed: true, edited: 'initial changed' });

    const firstSessionId = service.getSnapshot().sessionId;
    const pending = service.prompt('/desktop-delay');
    await service.newSession();
    const secondSessionId = service.getSnapshot().sessionId;
    assert.notEqual(secondSessionId, firstSessionId);
    await pending;
    assert.equal(existsSync(commandMarker), true, 'the background Pi runtime must finish its command');
    assert.equal(service.getSnapshot().sessionId, secondSessionId);
  } finally {
    await service?.dispose();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const resolvedTemp = resolve(tempRoot);
    if (!resolvedTemp.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('Unsafe temporary path');
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
});
