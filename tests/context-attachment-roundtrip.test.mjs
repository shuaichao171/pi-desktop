import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';

const marker = '\n\n<!-- pi-desktop:attachments-v1 -->\n';
const settle = () => new Promise((done) => setImmediate(done));

test('context attachments survive prompt events and persisted Pi history', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-context-attachments-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const environment = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map((name) => [name, process.env[name]]));
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  process.env.PI_OFFLINE = '1';
  let service;
  try {
    const [{ AgentService }, { SessionManager }] = await Promise.all([
      import('../packages/agent/src/index.ts'), import('@earendil-works/pi-coding-agent'),
    ]);
    service = new AgentService();
    await service.init({ cwd: workspace });
    const active = service.active;
    let captured;
    let promptCalls = 0;
    active.runtime.session.prompt = async (text, options) => {
      promptCalls += 1;
      captured = text;
      options.preflightResult(true);
    };
    const decode = (content) => {
      active.onSessionEvent({ type: 'message_start', message: { role: 'user', content, timestamp: Date.now() } });
      return service.getSnapshot().messages.at(-1);
    };
    const roundTrip = async (attachments) => {
      await service.prompt('Review this context', undefined, attachments);
      await settle();
      return decode(captured);
    };

    await t.test('legacy attachments retain exactly the existing header format', async () => {
      const attachment = { kind: 'text', name: 'notes.md', mimeType: 'text/markdown', text: '# Notes' };
      const message = await roundTrip([attachment]);
      assert.equal(captured, `Review this context${marker}<attached-file name="notes.md" mime="text%2Fmarkdown" length="7">\n# Notes\n</attached-file>\n`);
      assert.equal(message.text, 'Review this context');
      assert.deepEqual(message.attachments, [attachment]);
    });

    await t.test('long Unicode names do not split a surrogate pair during serialization', async () => {
      const attachment = { kind: 'text', name: `${'a'.repeat(179)}🔎notes.md`, mimeType: 'text/plain', text: 'body' };
      const message = await roundTrip([attachment]);
      assert.equal(message.attachments[0].name, `${'a'.repeat(179)}🔎`);
      assert.equal(message.attachments[0].text, 'body');
    });

    const attachments = [
      { kind: 'text', name: 'file "][中文].ts', mimeType: 'text/x-pi-file-reference', text: 'Project file: src/file "][中文].ts',
        source: { kind: 'file', workspace, path: 'src/file "][中文].ts' } },
      { kind: 'text', name: 'src', mimeType: 'text/x-pi-directory-reference', text: 'Project directory: src/',
        source: { kind: 'directory', workspace, path: 'src' } },
      { kind: 'text', name: 'Earlier conversation', mimeType: 'text/x-pi-session-context',
        text: `User: nested attachment example${marker}<attached-file name="inner.txt" mime="text/plain" length="0">\n\n</attached-file>\nAssistant: preserved after delimiter 🔎`,
        source: { kind: 'session', workspace, path: join(root, 'history.jsonl'), truncated: true } },
      { kind: 'text', name: 'after.txt', mimeType: 'text/plain', text: 'This attachment follows the nested delimiter.' },
    ];

    await t.test('file, directory and conversation sources round trip without consuming embedded frames', async () => {
      const message = await roundTrip(attachments);
      assert.equal(message.text, 'Review this context');
      assert.deepEqual(message.attachments, attachments);
      assert.match(captured, / source="%7B/);
      const fromBlocks = decode([
        { type: 'thinking', thinking: 'private reasoning' },
        { type: 'text', text: captured },
        { type: 'toolCall', name: 'read', arguments: { secret: 'tool-only data' } },
      ]);
      assert.deepEqual(fromBlocks.attachments, attachments, 'only text blocks contribute attachment frames');
      assert.equal(fromBlocks.text, 'Review this context');
    });

    await t.test('invalid source metadata is rejected before invoking Pi', async () => {
      const before = promptCalls;
      for (const source of [
        null, [], {}, { ...attachments[0].source, kind: ['file'] },
        { ...attachments[0].source, kind: 'tool' }, { ...attachments[0].source, workspace: '' },
        { ...attachments[0].source, path: 'line\nbreak' }, { ...attachments[0].source, path: 1 },
        { ...attachments[0].source, truncated: 'true' }, { ...attachments[0].source, extra: 'value' },
      ]) {
        await assert.rejects(service.prompt('invalid', undefined, [{ ...attachments[0], source }]), /上下文来源/);
      }
      await assert.rejects(service.prompt('invalid', undefined, [{ ...attachments[0], mimeType: 'text/plain' }]), /上下文来源类型/);
      assert.equal(promptCalls, before);
      const invalidHeader = `${marker}<attached-file name="bad" mime="text%2Fx-pi-file-reference" length="4" source="${encodeURIComponent(JSON.stringify({ ...attachments[0].source, kind: 'tool' }))}">\nbody\n</attached-file>\n`;
      assert.equal(decode(`Prompt${invalidHeader}`).attachments, undefined, 'invalid persisted metadata cannot masquerade as context');
      assert.equal(decode(`Prompt${invalidHeader.replace(/source="[^"]*"/, 'source="%XX"')}`).attachments, undefined);
    });

    await t.test('reopening saved history retains source labels and all framed content', async () => {
      await roundTrip(attachments);
      const saved = SessionManager.create(workspace);
      saved.appendMessage({ role: 'user', content: captured, timestamp: Date.now() });
      saved.appendMessage({
        role: 'assistant', content: [{ type: 'text', text: 'Saved reply' }],
        api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', timestamp: Date.now(),
      });
      await service.switchSession(saved.getSessionFile());
      const message = service.getSnapshot().messages.find((item) => item.role === 'user');
      assert.equal(message.text, 'Review this context');
      assert.deepEqual(message.attachments, attachments);
    });
  } finally {
    await service?.dispose();
    for (const [name, value] of environment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    const target = resolve(root);
    if (!target.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('Unsafe temporary path');
    rmSync(target, { recursive: true, force: true });
  }
});
