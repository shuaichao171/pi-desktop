import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';

test('colliding workspace directory encodings never share session ownership or restored history', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-session-owner-'));
  const firstWorkspace = join(tempRoot, 'project-one');
  const secondWorkspace = join(tempRoot, 'project', 'one');
  mkdirSync(firstWorkspace, { recursive: true });
  mkdirSync(secondWorkspace, { recursive: true });
  const previous = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map((key) => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, 'agent');
  process.env.PI_OFFLINE = '1';
  let service;
  try {
    const { AgentService } = await import('../packages/agent/src/index.ts');
    service = new AgentService();
    await service.init({ cwd: firstWorkspace });
    const first = service.getSnapshot();
    await service.renameSession(first.sessionPath, 'First workspace');
    const original = readFileSync(first.sessionPath, 'utf8');
    assert.deepEqual(await service.listSessions(secondWorkspace), []);
    await service.switchWorkspace(secondWorkspace);
    const second = service.getSnapshot();
    assert.notEqual(second.sessionPath, first.sessionPath);
    assert.notEqual(second.sessionId, first.sessionId);
    await service.renameSession(second.sessionPath, 'Second workspace');
    await assert.rejects(service.switchSession(first.sessionPath), /工作区/);
    await assert.rejects(service.init({ cwd: secondWorkspace, sessionPath: first.sessionPath }), /工作区/);
    await assert.rejects(service.renameSession(first.sessionPath, 'Wrong owner', secondWorkspace), /工作区/);
    assert.equal(readFileSync(first.sessionPath, 'utf8'), original);
    await service.dispose();
    service = new AgentService();
    await service.init({ cwd: firstWorkspace });
    assert.equal(service.getSnapshot().sessionPath, first.sessionPath);
    await service.switchWorkspace(secondWorkspace);
    assert.equal(service.getSnapshot().sessionPath, second.sessionPath);
    assert.deepEqual((await service.listSessions(firstWorkspace)).map((session) => session.path), [first.sessionPath]);
    assert.deepEqual((await service.listSessions(secondWorkspace)).map((session) => session.path), [second.sessionPath]);
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

test('cached unsaved sessions can be revisited within their workspace before Pi persists a transcript', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-unsaved-'));
  const workspace = join(tempRoot, 'workspace');
  const otherWorkspace = join(tempRoot, 'other');
  mkdirSync(workspace); mkdirSync(otherWorkspace);
  const previous = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map((key) => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, 'agent');
  process.env.PI_OFFLINE = '1';
  let service;
  try {
    const { AgentService } = await import('../packages/agent/src/index.ts');
    service = new AgentService();
    await service.init({ cwd: workspace });
    const first = service.getSnapshot();
    assert.ok(first.sessionPath);
    assert.equal(existsSync(first.sessionPath), false);
    await service.newSession();
    const second = service.getSnapshot();
    assert.notEqual(second.sessionId, first.sessionId);
    assert.equal(existsSync(second.sessionPath), false);
    await service.switchSession(first.sessionPath);
    assert.equal(service.getSnapshot().sessionId, first.sessionId);
    await service.switchSession(second.sessionPath);
    assert.equal(service.getSnapshot().sessionId, second.sessionId);
    await service.switchWorkspace(otherWorkspace);
    await assert.rejects(service.switchSession(first.sessionPath), /workspace|project|工作区/i);
    assert.equal(service.getSnapshot().cwd, otherWorkspace);
    assert.equal(existsSync(first.sessionPath), false, 'revisiting must not persist an otherwise empty session');
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
      import('@earendil-works/pi-coding-agent'),
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

test('workspace restoration reuses a busy cached runtime after its remembered unsaved session was evicted', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-busy-restore-'));
  const workspace = join(tempRoot, 'workspace');
  const otherWorkspace = join(tempRoot, 'other');
  const extensions = join(workspace, '.pi', 'extensions');
  mkdirSync(extensions, { recursive: true });
  mkdirSync(otherWorkspace);
  writeFileSync(join(extensions, 'hold.ts'), `
    export default function(pi) {
      pi.registerCommand('desktop-hold', {
        handler: async (_args, ctx) => { await ctx.ui.confirm('Hold runtime', 'Wait for the test'); },
      });
    }
  `);
  const previous = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map((key) => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, 'agent');
  process.env.PI_OFFLINE = '1';
  let service;
  let pending;
  let release;
  let started;
  const gate = new Promise((done) => { release = done; });
  const holding = new Promise((done) => { started = done; });
  try {
    const { AgentService } = await import('../packages/agent/src/index.ts');
    service = new AgentService(async () => ({ trusted: true, remember: false }), async () => { started(); return gate; });
    await service.init({ cwd: workspace });
    const original = service.active;
    const path = service.getSnapshot().sessionPath;
    await service.renameSession(path, 'Still running');
    pending = service.prompt('/desktop-hold');
    await holding;
    assert.equal(original.canEvict, false);
    await service.newSession();
    await service.switchWorkspace(otherWorkspace);
    for (let index = 0; index < 12; index += 1) await service.newSession();
    assert.equal(service.lastContextByCwd.has(workspace), false);
    assert.ok([...service.contexts.values()].includes(original));
    await service.switchWorkspace(workspace);
    assert.equal(service.active, original);
    assert.equal(service.getSnapshot().status, 'busy');
    assert.equal([...service.contexts.values()].filter((context) => context.getSnapshot().sessionPath === path).length, 1);
    assert.ok(service.contexts.size <= 12);
    release(true);
    await pending;
    assert.equal(service.getSnapshot().status, 'idle');
  } finally {
    release(true);
    await pending;
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
      pi.registerCommand('desktop-fail', {
        description: 'Failing command for error reporting test',
        handler: async () => { throw new Error('desktop-command-failed'); },
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
    await service.prompt('/desktop-fail');
    assert.match(service.getSnapshot().error ?? '', /desktop-command-failed/,
      'Pi reports extension failures through its error listener rather than rejecting prompt()');
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
