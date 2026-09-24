import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const assistant = (input, output = 20) => ({
  role: 'assistant', content: [{ type: 'text', text: 'Saved response' }],
  api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4',
  usage: { input, output, cacheRead: 30, cacheWrite: 0, totalTokens: input + output + 30,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'stop', timestamp: Date.now(),
});

test('context usage comes from Pi projection after persistence and stays isolated across sessions', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-context-'));
  const workspace = join(tempRoot, 'workspace');
  mkdirSync(workspace);
  const environment = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map((name) => [name, process.env[name]]));
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, 'agent');
  process.env.PI_OFFLINE = '1';
  let service;
  try {
    const [{ AgentService }, { SessionManager }] = await Promise.all([
      import('../packages/agent/src/index.ts'), import('@earendil-works/pi-coding-agent'),
    ]);
    const saved = SessionManager.create(workspace);
    const userId = saved.appendMessage({ role: 'user', content: 'Restore token usage', timestamp: Date.now() });
    saved.appendMessage(assistant(1000));
    service = new AgentService();
    await service.init({ cwd: workspace });
    await service.setProviderApiKey('anthropic', 'test-context-key-no-network');
    const model = service.listModels().find((entry) => entry.provider === 'anthropic' && entry.contextWindow > 0);
    assert.ok(model);
    await service.setModel(model.provider, model.id);
    await service.dispose();
    service = new AgentService();
    const events = [];
    service.onEvent(({ event }) => events.push(event));
    await service.init({ cwd: workspace, sessionPath: saved.getSessionFile() });
    const first = service.active;
    const session = first.runtime.session;
    assert.ok(session.model.contextWindow > 0, 'the offline Pi catalog supplies a context window');
    assert.deepEqual(service.getSnapshot().contextUsage, session.getContextUsage());
    assert.equal(service.getSnapshot().contextUsage.tokens, 1050, 'uses provider usage, not transcript text length or cumulative totals');
    assert.deepEqual(events.findLast((event) => event.type === 'ready').contextUsage, session.getContextUsage());

    const snapshot = service.getSnapshot();
    snapshot.contextUsage.tokens = 123;
    events.findLast((event) => event.type === 'ready').contextUsage.tokens = 456;
    assert.equal(service.getSnapshot().contextUsage.tokens, 1050, 'snapshot and pushed object mutation cannot alter agent state');

    let reads = 0;
    const readUsage = session.getContextUsage.bind(session);
    session.getContextUsage = () => { reads += 1; return readUsage(); };
    for (let index = 0; index < 20; index += 1) first.onSessionEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'a' } });
    await settle();
    assert.equal(reads, 0, 'streaming tokens do not repeatedly rebuild Pi context projection');

    // Exercise the actual SDK callback: it publishes message_end before appending
    // the message. A synchronous read in our listener would still return 1050.
    await session._handleAgentEvent({ type: 'message_end', message: assistant(2000) });
    await settle();
    assert.equal(service.getSnapshot().contextUsage.tokens, 2050);
    assert.equal(events.findLast((event) => event.type === 'context-usage').contextUsage.tokens, 2050);

    await session._handleAgentEvent({ type: 'message_end', message: {
      role: 'toolResult', toolCallId: 'read-result', toolName: 'read',
      content: [{ type: 'text', text: 'Tool result content '.repeat(100) }],
      isError: false, timestamp: Date.now(),
    } });
    await settle();
    assert.deepEqual(service.getSnapshot().contextUsage, readUsage());
    assert.ok(service.getSnapshot().contextUsage.tokens > 2050, 'tool results are part of the active context');

    session.sessionManager.appendCompaction('Compacted summary', userId, 2050);
    first.onSessionEvent({ type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false });
    await settle();
    assert.deepEqual(service.getSnapshot().contextUsage, { tokens: null, contextWindow: session.model.contextWindow, percent: null });
    await session._handleAgentEvent({ type: 'message_end', message: assistant(500) });
    await settle();
    assert.equal(service.getSnapshot().contextUsage.tokens, 550);

    const count = events.filter((event) => event.type === 'context-usage').length;
    first.onSessionEvent({ type: 'agent_settled' });
    first.onSessionEvent({ type: 'agent_settled' });
    await settle();
    assert.equal(events.filter((event) => event.type === 'context-usage').length, count, 'unchanged boundary refreshes do not send redundant usage events');

    await service.newSession();
    const secondUsage = service.getSnapshot().contextUsage;
    assert.notEqual(secondUsage?.tokens, 550, 'new sessions do not inherit previous context usage');
    const secondCount = events.filter((event) => event.type === 'context-usage').length;
    await session._handleAgentEvent({ type: 'message_end', message: assistant(3000) });
    await settle();
    assert.deepEqual(service.getSnapshot().contextUsage, secondUsage);
    assert.equal(events.filter((event) => event.type === 'context-usage').length, secondCount, 'background usage cannot reach the foreground conversation');
    await service.switchSession(saved.getSessionFile());
    assert.equal(service.getSnapshot().contextUsage.tokens, 3050, 'returning to a live session restores its latest usage');
  } finally {
    await service?.dispose();
    for (const [name, value] of environment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    const resolvedTemp = resolve(tempRoot);
    if (!resolvedTemp.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('Unsafe temporary path');
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
});
