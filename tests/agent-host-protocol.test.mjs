import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENT_HOST_METHODS, createAgentHostMethods, createAgentHostProxy, invokeAgentHostMethod } from '../packages/desktop/src/main/agentHostProtocol.ts';

test('every protocol method has a real implementation and the client forwards its exact arguments', async () => {
  const { AgentService } = await import('../packages/agent/src/index.ts');
  const service = Object.create(AgentService.prototype);
  const search = { searchSessions() {}, searchWorkspaceFiles() {}, readSessionContext() {}, searchSessionsPage() {}, searchProjectFiles() {}, rebuildSearchIndex() {}, cancelDataSearch() {}, getProjectSearchRules() {}, setProjectSearchRules() {}, getUsageReport() {}, cancelUsageReport() {} };
  const actual = createAgentHostMethods(service, search);
  assert.deepEqual(Object.keys(actual), [...AGENT_HOST_METHODS]);
  const calls = [];
  const agent = Object.fromEntries(AGENT_HOST_METHODS.map((name) => [name, function (...args) {
    calls.push({ name, args, receiver: this });
    return { method: name, args };
  }]));
  const methods = createAgentHostMethods(agent, {
    searchSessions: agent.searchSessions,
    searchWorkspaceFiles: agent.searchWorkspaceFiles,
    readSessionContext: agent.readSessionContext,
  });
  const proxy = createAgentHostProxy((method, ...args) => invokeAgentHostMethod(methods, { kind: 'call', id: 1, method, args }));
  assert.deepEqual(Object.keys(proxy), [...AGENT_HOST_METHODS]);
  for (const name of AGENT_HOST_METHODS) {
    const args = ['value', { nested: [1, true] }];
    assert.deepEqual(await proxy[name](...args), { method: name, args });
    assert.equal(calls.at(-1).name, name);
    if (!(name in search)) assert.equal(calls.at(-1).receiver, agent, 'instance methods retain their receiver');
  }
});

test('host dispatch rejects malformed envelopes and inherited methods', async () => {
  const methods = Object.fromEntries(AGENT_HOST_METHODS.map((name) => [name, () => { throw new Error('must not invoke'); }]));
  for (const message of [
    { id: 0, method: 'init', args: [] },
    { id: 1.5, method: 'init', args: [] },
    { id: 1, method: 'init', args: null },
    { id: 1, method: 'init', args: {} },
    { id: 1, method: 'toString', args: [] },
    { id: 1, method: 'constructor', args: [] },
  ]) await assert.rejects(invokeAgentHostMethod(methods, { kind: 'call', ...message }), /Invalid Pi agent call|Unknown Pi agent method/);
  assert.throws(() => createAgentHostMethods({}, {}), /Pi agent method unavailable/);
});
