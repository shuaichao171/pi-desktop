import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { expandSlashPrompt } from '../packages/agent/src/slashCommands.ts';

const settle = () => new Promise((done) => setImmediate(done));

test('attachment-safe template expansion matches the installed Pi argument syntax', async () => {
  const modulePath = new URL('./core/prompt-templates.js', import.meta.resolve('@earendil-works/pi-coding-agent'));
  const { parseCommandArgs, substituteArgs } = await import(modulePath.href);
  const templates = [
    'No argument placeholder', '$1 / $2 / $12', '$@ | $ARGUMENTS',
    '${1:-first} ${4:-last} ${@:-all} ${ARGUMENTS:-fallback}',
    '${@:0} | ${@:2} | ${@:1:0} | ${@:2:2}',
    '${1:-$2} ${@:-$ARGUMENTS} $1 $@',
  ];
  for (const input of ['', 'one two three', '"quoted words" \'中文 路径\' plain', '"" spaced\nline', '"unfinished quote', '$1 $@ ${2:-value}']) {
    for (const template of templates) assert.equal(expandSlashPrompt(template, input), substituteArgs(template, parseCommandArgs(input)));
  }
});

test('desktop slash commands use current SDK resources, enforce session ownership and preserve prompt context', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-slash-commands-'));
  const workspace = join(root, 'workspace');
  const extensionDirectory = join(workspace, '.pi/extensions');
  const promptDirectory = join(workspace, '.pi/prompts');
  const skillDirectory = join(workspace, '.pi/skills/desktop-skill');
  const marker = join(root, 'command.json');
  const lifecycleMarker = join(root, 'lifecycle.json');
  for (const path of [extensionDirectory, promptDirectory, skillDirectory]) mkdirSync(path, { recursive: true });
  writeFileSync(join(extensionDirectory, 'desktop.ts'), `
    import { writeFileSync, existsSync, readFileSync } from 'node:fs';
    export default function(pi) {
      pi.registerCommand('desktop-probe', {
        description: 'Desktop extension probe',
        handler: async (args, ctx) => {
          const marker = ${JSON.stringify(marker)};
          const previous = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : { count: 0 };
          writeFileSync(marker, JSON.stringify({ count: previous.count + 1, args, cwd: ctx.cwd }));
          ctx.ui.notify('Desktop command completed');
        },
      });
      pi.registerCommand('desktop-session', {
        description: 'Exercise extension session replacement',
        handler: async (args, ctx) => {
          try {
            if (args === 'new') await ctx.newSession({ withSession: async (fresh) => { fresh.ui.notify('Fresh command context'); } });
            else if (args === 'fail-setup') await ctx.newSession({ setup: () => { throw new Error('replacement setup failed'); } });
            else if (args === 'reload') await ctx.reload();
            else await ctx.switchSession(args);
            writeFileSync(${JSON.stringify(lifecycleMarker)}, JSON.stringify({ success: true }));
          } catch (error) { writeFileSync(${JSON.stringify(lifecycleMarker)}, JSON.stringify({ error: error.message })); }
        },
      });
      pi.registerCommand('desktop-error', {
        description: 'Command failure preserves its own draft',
        handler: async (args) => {
          await new Promise((done) => setTimeout(done, args === 'fail' ? 20 : 40));
          if (args === 'fail') throw new Error('Only this command failed');
        },
      });
    }
  `);
  writeFileSync(join(promptDirectory, 'desktop-note.md'), '---\ndescription: Summarize an item\n---\nSummary: $1');
  writeFileSync(join(skillDirectory, 'SKILL.md'), '---\nname: desktop-skill\ndescription: Desktop skill probe\n---\nSkill instructions to preserve.');
  const environment = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map((name) => [name, process.env[name]]));
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  process.env.PI_OFFLINE = '1';
  let service;
  try {
    const { AgentService } = await import('../packages/agent/src/index.ts');
    const notices = [];
    service = new AgentService(async () => ({ trusted: true, remember: false }), async (request) => { notices.push(request); return null; });
    await service.init({ cwd: workspace });
    const target = () => ({ cwd: service.getSnapshot().cwd, sessionId: service.getSnapshot().sessionId });
    const run = (name, args, options = {}) => service.executeSlashCommand({ ...target(), name, args, ...options });
    const attachment = { kind: 'text', name: 'src/reference.ts', mimeType: 'text/x-pi-file-reference', text: 'Never drop this attached context.', source: { kind: 'file', workspace, path: 'src/reference.ts' } };

    await t.test('catalog reflects loaded extension, prompt and skill resources alongside supported built-ins', () => {
      const commands = service.listSlashCommands();
      assert.deepEqual(commands.filter((item) => item.source === 'builtin').map((item) => item.name), ['new', 'compact', 'name', 'reload']);
      for (const [name, source] of [['desktop-probe', 'extension'], ['desktop-note', 'prompt'], ['skill:desktop-skill', 'skill']]) {
        assert.equal(commands.find((item) => item.name === name)?.source, source);
      }
      assert.ok(!commands.some((item) => ['login', 'export', 'quit', 'model'].includes(item.name)), 'terminal-specific commands must not be advertised');
    });

    await t.test('extension executes through Pi exactly once, including during streaming, without requiring a model response', async () => {
      await run('desktop-probe', 'first call');
      await settle();
      assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), { count: 1, args: 'first call', cwd: workspace });
      const session = service.active.runtime.session;
      session._isAgentRunActive = true;
      try {
        await run('desktop-probe', 'busy call');
        await settle();
        assert.equal(JSON.parse(readFileSync(marker, 'utf8')).count, 2);
        assert.equal(session.pendingMessageCount, 0, 'extension command must execute, not enter the model queue');
        for (const name of ['new', 'compact', 'name', 'reload']) await assert.rejects(run(name, name === 'name' ? 'Name' : undefined), /仍在运行/);
      } finally { session._isAgentRunActive = false; }
      assert.equal(notices.filter((item) => item.title === 'Desktop command completed').length, 2);
    });

    await t.test('prompt templates and skills queue with full context even without argument placeholders', async () => {
      const session = service.active.runtime.session;
      session._isAgentRunActive = true;
      try {
        await run('desktop-note', '"quoted title"', { attachments: [attachment] });
        await settle();
        const template = session.getFollowUpMessages().at(-1);
        assert.match(template, /^Summary: quoted title\n\n<!-- pi-desktop:attachments-v1 -->/);
        assert.ok(template.includes(attachment.text));
        assert.ok(template.includes('source="'));
        await run('skill:desktop-skill', undefined, { behavior: 'steer', attachments: [attachment] });
        await settle();
        const skill = session.getSteeringMessages().at(-1);
        assert.match(skill, /^<skill name="desktop-skill"/);
        assert.match(skill, /Skill instructions to preserve/);
        assert.ok(skill.includes(attachment.text));
        assert.match(skill, /\n\n<!-- pi-desktop:attachments-v1 -->/);
        await run('desktop-note', 'normal');
        await settle();
        assert.equal(session.getFollowUpMessages().at(-1), 'Summary: normal');
      } finally { session._isAgentRunActive = false; session.clearQueue(); }
    });

    await t.test('real Pi command exceptions reject only the matching concurrent command', async () => {
      const session = service.active.runtime.session;
      session._isAgentRunActive = true;
      try {
        const failed = assert.rejects(run('desktop-error', 'fail'), /Only this command failed/);
        const successful = run('desktop-error', 'success');
        await Promise.all([failed, successful]);
        await settle();
        assert.equal(session.pendingMessageCount, 0);
      } finally { session._isAgentRunActive = false; }
    });

    await t.test('unknown, stale, malformed and incompatible commands fail before any prompt or mutation', async () => {
      const count = JSON.parse(readFileSync(marker, 'utf8')).count;
      await assert.rejects(run('not-a-real-command'), /未知或不可用/);
      await assert.rejects(run('desktop-probe', 'ignored', { attachments: [attachment] }), /不接受附件/);
      await assert.rejects(run('name', 'ignored', { attachments: [attachment] }), /不接受附件/);
      await assert.rejects(run('new', 'unexpected'), /不接受参数/);
      await assert.rejects(run('name', ''), /会话名称/);
      await assert.rejects(run('name', 'line\nbreak'), /会话名称/);
      await assert.rejects(service.executeSlashCommand({ ...target(), name: 'desktop-probe', sessionId: 'stale' }), /会话已变化/);
      await assert.rejects(service.executeSlashCommand({ ...target(), name: 'desktop-probe', cwd: root }), /会话已变化/);
      for (const request of [null, {}, { ...target(), name: '/new' }, { ...target(), name: 'desktop-probe', attachments: {} }, { ...target(), name: 'desktop-probe', behavior: 'invalid' }]) {
        await assert.rejects(service.executeSlashCommand(request), /指令参数无效/);
      }
      assert.equal(JSON.parse(readFileSync(marker, 'utf8')).count, count);
    });

    await t.test('rename targets the current session and compaction blocks concurrent configuration calls', async () => {
      const session = service.active.runtime.session;
      await run('name', '新的会话名');
      assert.equal(session.sessionName, '新的会话名');
      const original = session.compact;
      let release;
      let received;
      session.compact = async (instructions) => { received = instructions; await new Promise((done) => { release = done; }); return {}; };
      const compacting = run('compact', 'Keep decisions');
      try {
        assert.equal(received, 'Keep decisions');
        assert.equal(service.getSnapshot().status, 'busy');
        await assert.rejects(run('name', 'Must not rename'), /仍在运行/);
        await assert.rejects(run('desktop-probe'), /设置正在更新/);
      } finally { release(); await compacting; session.compact = original; }
      assert.equal(service.getSnapshot().status, 'idle');
      assert.equal(session.sessionName, '新的会话名');
    });

    await t.test('reload discovers new prompts and retains working desktop extension bindings', async () => {
      writeFileSync(join(promptDirectory, 'desktop-added.md'), '---\ndescription: Newly reloaded prompt\n---\nNew prompt');
      assert.ok(!service.listSlashCommands().some((item) => item.name === 'desktop-added'));
      await run('reload');
      assert.ok(service.listSlashCommands().some((item) => item.name === 'desktop-added'));
      await run('desktop-probe', 'after reload');
      await settle();
      assert.equal(JSON.parse(readFileSync(marker, 'utf8')).args, 'after reload');
      assert.equal(notices.filter((item) => item.title === 'Desktop command completed').length, 3);
    });

    await t.test('extension new/switch/reload rebind the runtime, snapshot and desktop UI; loaded targets cannot be duplicated', async () => {
      const { SessionManager } = await import('@earendil-works/pi-coding-agent');
      const firstId = target().sessionId;
      await run('desktop-session', 'new');
      await settle();
      assert.deepEqual(JSON.parse(readFileSync(lifecycleMarker, 'utf8')), { success: true });
      assert.notEqual(target().sessionId, firstId);
      assert.equal(service.getSnapshot().sessionId, service.active.runtime.session.sessionId);
      assert.ok(notices.some((item) => item.title === 'Fresh command context'));
      const manager = SessionManager.create(workspace);
      manager.appendMessage({ role: 'user', content: 'Target history', timestamp: Date.now() });
      manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Target reply' }], api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });
      const path = manager.getSessionFile();
      await run('desktop-session', path);
      await settle();
      assert.deepEqual(JSON.parse(readFileSync(lifecycleMarker, 'utf8')), { success: true });
      assert.equal(service.getSnapshot().sessionPath, path);
      assert.equal(service.getSnapshot().messages[0].text, 'Target history');
      writeFileSync(join(promptDirectory, 'desktop-extension-reload.md'), '---\ndescription: Extension reload result\n---\nReloaded');
      await run('desktop-session', 'reload');
      await settle();
      assert.ok(service.listSlashCommands().some((item) => item.name === 'desktop-extension-reload'));
      await run('desktop-probe', 'rebound probe');
      await settle();
      assert.equal(JSON.parse(readFileSync(marker, 'utf8')).args, 'rebound probe');
      await run('new');
      const currentId = target().sessionId;
      await run('desktop-session', path);
      await settle();
      assert.match(JSON.parse(readFileSync(lifecycleMarker, 'utf8')).error, /已在桌面端加载/);
      assert.equal(target().sessionId, currentId);
      assert.equal([...service.contexts.values()].filter((context) => context.getSnapshot().sessionPath === path).length, 1);
      await run('desktop-session', join(root, 'outside.jsonl'));
      await settle();
      assert.match(JSON.parse(readFileSync(lifecycleMarker, 'utf8')).error, /不属于当前工作区/);
      assert.equal(target().sessionId, currentId);
      await service.switchSession(path);
      assert.equal(service.getSnapshot().sessionPath, path, 'normal sidebar switching must remain available');
    });

    await t.test('desktop initialization cannot open a session reserved by an extension switch', async () => {
      const { SessionManager } = await import('@earendil-works/pi-coding-agent');
      const manager = SessionManager.create(workspace);
      manager.appendSessionInfo('Reserved extension target');
      const path = manager.getSessionFile();
      writeFileSync(path, [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
      const context = service.active;
      const originalList = context.listSessions;
      let release;
      let entered;
      const gate = new Promise((done) => { release = done; });
      const reserved = new Promise((done) => { entered = done; });
      context.listSessions = async function (...args) { entered(); await gate; return originalList.apply(this, args); };
      const switching = run('desktop-session', path);
      try {
        await reserved;
        assert.ok(service.reservedSessionPaths.has(path));
        await assert.rejects(service.init({ cwd: workspace, sessionPath: path }), /扩展正在切换/);
      } finally {
        release();
        await switching;
        await settle();
        context.listSessions = originalList;
      }
      assert.deepEqual(JSON.parse(readFileSync(lifecycleMarker, 'utf8')), { success: true });
      assert.equal(service.getSnapshot().sessionPath, path);
      assert.equal([...service.contexts.values()].filter((item) => item.getSnapshot().sessionPath === path).length, 1,
        'the reserved transcript must have exactly one live writer');
    });

    await t.test('a desktop transition rejects prompts and settings before its first asynchronous step', async () => {
      const count = JSON.parse(readFileSync(marker, 'utf8')).count;
      const switching = service.newSession();
      try {
        assert.throws(() => service.prompt('/desktop-probe must not run in the old session'), /会话正在切换/);
        assert.throws(() => service.setThinkingLevel('off'), /会话正在切换/);
      } finally { await switching; await settle(); }
      assert.equal(JSON.parse(readFileSync(marker, 'utf8')).count, count);
    });

    await t.test('new creates a fresh session and refuses commands captured for the previous conversation', async () => {
      const previous = target();
      await run('new');
      assert.equal(service.getSnapshot().cwd, workspace);
      assert.notEqual(service.getSnapshot().sessionId, previous.sessionId);
      await assert.rejects(service.executeSlashCommand({ ...previous, name: 'name', args: 'Wrong target' }), /会话已变化/);
    });

    await t.test('retry initializes a failed cached runtime and restores usable extension bindings', async () => {
      await run('name', 'Recover this session');
      const previousPath = service.getSnapshot().sessionPath;
      const contextCount = service.contexts.size;
      await run('desktop-session', 'fail-setup');
      await settle();
      assert.match(JSON.parse(readFileSync(lifecycleMarker, 'utf8')).error, /replacement setup failed/);
      assert.equal(service.hasSession, false);
      assert.equal(service.getSnapshot().status, 'error');
      await service.init({ cwd: workspace });
      assert.equal(service.hasSession, true);
      assert.equal(service.getSnapshot().status, 'idle');
      assert.equal(service.getSnapshot().sessionPath, previousPath);
      assert.equal(service.contexts.size, contextCount);
      await run('desktop-probe', 'recovered');
      await settle();
      assert.equal(JSON.parse(readFileSync(marker, 'utf8')).args, 'recovered');
    });

    await t.test('retry of an unsaved failed session reuses an already loaded persisted runtime', async () => {
      const savedContext = service.active;
      const savedPath = service.getSnapshot().sessionPath;
      await run('new');
      const failedContext = service.active, runtime = failedContext.runtime, unsavedPath = service.getSnapshot().sessionPath;
      assert.equal(existsSync(unsavedPath), false, 'this recovery case must begin with a genuinely unpersisted session');
      // Exercise the real SDK replacement failure without first submitting a
      // user command, which now intentionally persists its lifecycle start.
      await assert.rejects(failedContext.runExtensionSessionAction(runtime, () => runtime.newSession({ setup: () => { throw new Error('replacement setup failed'); } })), /replacement setup failed/);
      await settle();
      assert.equal(service.hasSession, false);
      assert.equal(existsSync(unsavedPath), false, 'no request was started, so there is no newer persisted run to restore');
      assert.equal((await service.listSessions(workspace))[0].path, savedPath);
      await service.init({ cwd: workspace });
      assert.equal(service.getSnapshot().sessionPath, savedPath);
      assert.equal([...service.contexts.values()].filter((context) => context.hasSession && context.getSnapshot().sessionPath === savedPath).length, 1);
      assert.equal(service.active, savedContext, 'recovery must preserve the loaded runtime rather than create a second writer');
      await run('desktop-probe', 'reused');
      await settle();
      assert.equal(JSON.parse(readFileSync(marker, 'utf8')).args, 'reused');
    });

    await t.test('retry preserves the newest failed command run and keeps one writer for its recorded session', async () => {
      await run('new');
      const failedContext = service.active, failedPath = service.getSnapshot().sessionPath, failedSessionId = service.getSnapshot().sessionId;
      assert.equal(existsSync(failedPath), false);
      await run('desktop-session', 'fail-setup'); await settle();
      assert.equal(service.hasSession, false);
      assert.equal(existsSync(failedPath), true, 'request start must survive even before the first assistant message');
      const records = readFileSync(failedPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.customType === 'pi-desktop:conversation-run-v1');
      assert.equal(records.length, 2); assert.equal(records[0].data.run.status, 'running'); assert.equal(records[1].data.run.status, 'failed');
      assert.equal(records[0].data.run.id, records[1].data.run.id);
      assert.equal((await service.listSessions(workspace))[0].path, failedPath);
      await service.init({ cwd: workspace });
      const recovered = service.getSnapshot();
      assert.equal(recovered.sessionPath, failedPath); assert.equal(recovered.sessionId, failedSessionId);
      assert.deepEqual(recovered.runs, [records[1].data.run]);
      assert.equal(service.active, failedContext, 'the failed cached slot is rebound to its own persisted session');
      assert.equal([...service.contexts.values()].filter(context => context.hasSession && context.getSnapshot().sessionPath === failedPath).length, 1);
      await run('desktop-probe', 'recorded run recovered'); await settle();
      assert.equal(JSON.parse(readFileSync(marker, 'utf8')).args, 'recorded run recovered');
    });
  } finally {
    await service?.dispose();
    for (const [name, value] of environment) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    const target = resolve(root);
    if (!target.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('Unsafe temporary path');
    rmSync(target, { recursive: true, force: true });
  }
});
