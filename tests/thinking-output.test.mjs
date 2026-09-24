import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';

const assistant = (content, stopReason = 'stop', errorMessage) => ({
  role: 'assistant', content, api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason, errorMessage, timestamp: Date.now(),
});
const thinking = (text) => ({ type: 'thinking', thinking: text, thinkingSignature: 'opaque-signature-must-stay-in-sdk' });
const redacted = { type: 'thinking', thinking: 'redacted-content-must-stay-in-sdk', redacted: true, thinkingSignature: 'encrypted-payload-must-stay-in-sdk' };

test('Pi thinking streams are bounded, coalesced, finalized, isolated, and restored without opaque content', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-thinking-'));
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
    saved.appendMessage({ role: 'user', content: 'Inspect this project', timestamp: Date.now() });
    saved.appendMessage(assistant([thinking('Saved reasoning'), redacted]));
    service = new AgentService();
    const events = [];
    service.onEvent(({ event }) => events.push(event));
    await service.init({ cwd: workspace, sessionPath: saved.getSessionFile() });
    assert.equal(service.getSnapshot().messages.at(-1).thinking, 'Saved reasoning', 'reasoning-only history is retained');
    assert.equal(service.getSnapshot().messages.at(-1).thinkingStatus, 'done');
    const context = service.active;
    const session = context.runtime.session;
    const update = (type, content, contentIndex = 0) => session._handleAgentEvent({
      type: 'message_update', message: assistant(content),
      assistantMessageEvent: { type, partial: assistant(content), contentIndex, delta: 'ignored-in-favor-of-safe-partial', content: content[contentIndex]?.thinking ?? '' },
    });
    await session._handleAgentEvent({ type: 'message_start', message: assistant([]) });
    await update('thinking_start', [thinking('')]);
    assert.equal(service.getSnapshot().messages.at(-1).thinkingStatus, 'streaming');
    const initialEvents = events.filter((event) => event.type === 'assistant-thinking').length;
    for (let index = 1; index <= 24; index += 1) await update('thinking_delta', [thinking('a'.repeat(index)), redacted]);
    assert.equal(service.getSnapshot().messages.at(-1).thinking, 'a'.repeat(24), 'snapshots include tokens waiting for IPC');
    assert.equal(events.filter((event) => event.type === 'assistant-thinking').length, initialEvents, 'token updates share one pending projection');
    await new Promise((done) => setTimeout(done, 110));
    assert.equal(events.filter((event) => event.type === 'assistant-thinking').length, initialEvents + 1);
    assert.equal(events.findLast((event) => event.type === 'assistant-thinking').thinking, 'a'.repeat(24));

    await update('thinking_start', [thinking('a'.repeat(24)), thinking('')], 1);
    await update('thinking_delta', [thinking('a'.repeat(24)), thinking('Second block')], 1);
    await update('thinking_end', [thinking('a'.repeat(24)), thinking('Second block')], 1);
    assert.equal(events.findLast((event) => event.type === 'assistant-thinking').thinking, `${'a'.repeat(24)}\n\nSecond block`);
    assert.equal(events.findLast((event) => event.type === 'assistant-thinking').thinkingStatus, 'done');
    const complete = assistant([thinking('First final block'), redacted, thinking('Second final block'), { type: 'text', text: 'Answer' }]);
    await session._handleAgentEvent({ type: 'message_end', message: complete });
    const ended = events.findLast((event) => event.type === 'assistant-end');
    assert.equal(ended.thinking, 'First final block\n\nSecond final block');
    assert.equal(ended.thinkingStatus, 'done');
    assert.equal(service.getSnapshot().messages.at(-1).text, 'Answer');

    await session._handleAgentEvent({ type: 'message_start', message: assistant([]) });
    await update('thinking_delta', [thinking(`${'x'.repeat(47_999)}😀tail`)]);
    const capped = service.getSnapshot().messages.at(-1);
    assert.equal(capped.thinking.length, 47_999);
    assert.equal(capped.thinkingTruncated, true);
    const cancelled = assistant([thinking(`${'x'.repeat(47_999)}😀tail`)], 'aborted');
    await session._handleAgentEvent({ type: 'message_end', message: cancelled });
    assert.equal(events.findLast((event) => event.type === 'assistant-end').thinkingStatus, 'interrupted');
    assert.equal(service.getSnapshot().messages.at(-1).status, 'error');

    await session._handleAgentEvent({ type: 'message_start', message: assistant([]) });
    await update('thinking_delta', [thinking('Before failure')]);
    await session._handleAgentEvent({ type: 'message_end', message: assistant([thinking('Before failure')], 'error', 'Provider disconnected') });
    assert.equal(service.getSnapshot().messages.at(-1).thinkingStatus, 'error');

    await session._handleAgentEvent({ type: 'message_start', message: assistant([]) });
    await update('thinking_delta', [thinking('Streamed summary omitted from final payload')]);
    await session._handleAgentEvent({ type: 'message_end', message: assistant([{ type: 'text', text: 'Answer without repeated reasoning' }]) });
    assert.equal(events.findLast((event) => event.type === 'assistant-end').thinking, 'Streamed summary omitted from final payload', 'the final event flushes pending exposed content even if the provider omits it');

    await session._handleAgentEvent({ type: 'message_start', message: assistant([]) });
    await update('thinking_start', [redacted]);
    await update('thinking_delta', [redacted]);
    await session._handleAgentEvent({ type: 'message_end', message: assistant([redacted, { type: 'text', text: 'Public answer' }]) });
    assert.equal(service.getSnapshot().messages.at(-1).thinkingStatus, undefined, 'redacted-only responses do not invent a thinking transcript');

    await session._handleAgentEvent({ type: 'message_start', message: assistant([]) });
    await update('thinking_delta', [thinking('Initially exposed, then redacted')]);
    await update('thinking_end', [redacted]);
    const redactionEventCount = events.length;
    assert.equal(service.getSnapshot().messages.at(-1).thinking, '');
    assert.equal(events.findLast((event) => event.type === 'assistant-thinking').thinking, '');
    await new Promise((done) => setTimeout(done, 110));
    assert.ok(!events.slice(redactionEventCount).some((event) => event.type === 'assistant-thinking'), 'a pending delta cannot republish text redacted at thinking_end');
    await session._handleAgentEvent({ type: 'message_end', message: assistant([redacted]) });

    await session._handleAgentEvent({ type: 'message_start', message: assistant([]) });
    await update('thinking_delta', [thinking('Retained public block'), thinking('Later redacted block')], 1);
    await update('thinking_delta', [thinking('Retained public block'), redacted], 1);
    assert.equal(events.findLast((event) => event.type === 'assistant-thinking').thinking, 'Retained public block', 'mid-block redaction preserves other exposed blocks');
    await session._handleAgentEvent({ type: 'message_end', message: assistant([thinking('Retained public block'), redacted]) });

    await session._handleAgentEvent({ type: 'message_start', message: assistant([]) });
    await update('thinking_delta', [thinking('Interrupted without message_end')]);
    context.onSessionEvent({ type: 'agent_settled' });
    assert.equal(events.findLast((event) => event.type === 'assistant-end').thinking, 'Interrupted without message_end');
    assert.equal(service.getSnapshot().messages.at(-1).thinkingStatus, 'interrupted');

    await session._handleAgentEvent({ type: 'message_start', message: assistant([]) });
    await update('thinking_delta', [thinking('Background thinking')]);
    await service.newSession();
    const foregroundCount = events.filter((event) => event.type === 'assistant-thinking').length;
    await update('thinking_delta', [thinking('Background thinking continues')]);
    await new Promise((done) => setTimeout(done, 110));
    assert.equal(service.getSnapshot().messages.length, 0);
    assert.equal(events.filter((event) => event.type === 'assistant-thinking').length, foregroundCount);
    await service.switchSession(saved.getSessionFile());
    assert.equal(service.getSnapshot().messages.at(-1).thinking, 'Background thinking continues');
    await session._handleAgentEvent({ type: 'message_end', message: assistant([thinking('Background final')]) });
    assert.doesNotMatch(JSON.stringify({ events, snapshot: service.getSnapshot() }), /opaque-signature|redacted-content|encrypted-payload/);

    await service.dispose();
    service = new AgentService();
    await service.init({ cwd: workspace, sessionPath: saved.getSessionFile() });
    assert.equal(service.getSnapshot().messages.at(-1).thinking, 'Background final');
    assert.equal(service.getSnapshot().messages.at(-1).thinkingStatus, 'done');
    assert.ok(service.getSnapshot().messages.some((message) => message.thinkingTruncated && message.thinkingStatus === 'interrupted'));
    assert.doesNotMatch(JSON.stringify(service.getSnapshot()), /opaque-signature|redacted-content|encrypted-payload/);
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
