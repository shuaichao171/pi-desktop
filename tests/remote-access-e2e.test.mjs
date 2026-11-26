import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@pidesktop/shared/remoteAccess') {
      return nextResolve(new URL('../packages/shared/src/remoteAccess.ts', import.meta.url).href, context);
    }
    if (specifier === '@pidesktop/shared/remoteClient') {
      return nextResolve(new URL('../packages/shared/src/remoteClient.ts', import.meta.url).href, context);
    }
    if (specifier === '@pidesktop/shared') {
      return nextResolve(new URL('../packages/shared/src/index.ts', import.meta.url).href, context);
    }
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      if (context.parentURL && new URL(context.parentURL).pathname.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

function waitFor(predicate, timeoutMs = 4_000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('Timed out waiting for condition'));
      setTimeout(check, 20);
    };
    check();
  });
}

test('End-to-end mobile remote control over live HTTP + WebSocket (pairing, streaming, approvals, scopes, revocation)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-remote-e2e-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { RemoteAuthStore } = await import('../packages/desktop/src/main/remote/authStore.ts');
  const { createRemoteServer } = await import('../packages/desktop/src/main/remote/remoteServer.ts');
  const { buildRemotePairingUrl } = await import('../packages/shared/src/remoteAccess.ts');
  const {
    RemoteConnectionClient,
    RemoteRpcCallError,
    applyRemoteAgentEvent,
    mergeRemotePendingDialog,
    pairWithDesktop,
    removeRemotePendingDialog,
  } = await import('../packages/shared/src/remoteClient.ts');

  const authStore = new RemoteAuthStore(join(dir, 'auth.json'));
  const prompted = [];
  const dialogResponses = [];
  let seq = 0;

  const baseSnapshot = {
    sequence: 0,
    status: 'idle',
    model: 'claude-sonnet',
    modelName: 'Claude Sonnet',
    modelProvider: 'anthropic',
    thinkingLevel: 'medium',
    availableThinkingLevels: ['off', 'low', 'medium', 'high'],
    contextUsage: null,
    cwd: '/workspace/demo',
    sessionId: 'sess-1',
    sessionPath: '/workspace/demo/sess-1.jsonl',
    messages: [{ id: 'm1', order: 1, role: 'user', text: 'Hello desktop', status: 'done' }],
    activities: [],
    queuedCount: 0,
    queuedMessages: [],
    fileChanges: [],
    fileChangeTurns: [],
    fileChangeActiveRunId: null,
    backgroundTasks: [],
    error: null,
  };

  let pendingDialogs = [];
  let server;
  const getDescriptor = () => ({
    environmentId: authStore.environmentId,
    label: 'Test Desktop',
    appVersion: '0.5.12',
    platform: process.platform,
    protocolVersion: 1,
    capabilities: {
      bearer: true,
      wsTickets: true,
      scopes: true,
      directEndpoints: true,
      fileBrowse: true,
      gitDiff: true,
      backgroundTasks: true,
    },
    directEndpoints: server
      ? [
          {
            id: 'ts-https',
            kind: 'tailscale',
            label: 'Tailscale HTTPS',
            httpBaseUrl: 'https://test-desktop.tailnet.ts.net',
            wsBaseUrl: 'wss://test-desktop.tailnet.ts.net',
            isHttps: true,
          },
          {
            id: 'lo',
            kind: 'loopback',
            label: 'Loopback',
            httpBaseUrl: `http://127.0.0.1:${server.port}`,
            wsBaseUrl: `ws://127.0.0.1:${server.port}`,
            isHttps: false,
          },
        ]
      : [],
  });

  const handlers = {
    'environment.getDescriptor': () => getDescriptor(),
    'agent.getSnapshot': () => baseSnapshot,
    'agent.getHistoryPage': () => ({ offset: 0, limit: 20, total: 1, messages: baseSnapshot.messages, activities: [] }),
    'agent.listWorkspaces': () => ['/workspace/demo'],
    'agent.listConversationWorkspaces': () => [],
    'agent.listSessions': () => [
      { path: '/workspace/demo/sess-1.jsonl', id: 'sess-1', name: 'Demo Task', firstMessage: 'Hello desktop', modified: new Date().toISOString(), messageCount: 1 },
    ],
    'agent.listSessionsPage': () => ({ sessions: [], total: 0, hasMore: false, revision: 1 }),
    'agent.listModels': () => [{ provider: 'anthropic', id: 'claude-sonnet', name: 'Claude Sonnet', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 8192 }],
    'agent.listAgents': () => [],
    'agent.getInputQueue': () => ({ scope: { cwd: '/workspace/demo', sessionId: 'sess-1', sessionPath: null }, items: [], paused: false }),
    'agent.getPendingExtensionDialogs': () => pendingDialogs,
    'agent.getFileChangeDiffs': () => [{ path: 'src/app.ts', diff: '+const remote = true;\n' }],
    'agent.getSessionStats': () => ({ sessionId: 'sess-1', userMessages: 1, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 1, tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, total: 10 }, cost: 0 }),
    'agent.getMessageAttachment': () => ({ kind: 'text', name: 'a.txt', mimeType: 'text/plain', text: 'hi' }),
    'agent.getToolResultImage': () => ({ kind: 'image', name: 'img.png', mimeType: 'image/png', data: '' }),
    'agent.prompt': (params) => {
      prompted.push(params);
      // Simulate real-time agent streaming pushed back to mobile
      server.broadcastEvent({ channel: 'agent-event', payload: { sequence: ++seq, event: { type: 'status', status: 'busy' } } });
      server.broadcastEvent({ channel: 'agent-event', payload: { sequence: ++seq, event: { type: 'assistant-start', id: 'a1', order: 2 } } });
      server.broadcastEvent({ channel: 'agent-event', payload: { sequence: ++seq, event: { type: 'assistant-delta', id: 'a1', delta: 'Working on it… ' } } });
      server.broadcastEvent({ channel: 'agent-event', payload: { sequence: ++seq, event: { type: 'assistant-end', id: 'a1', text: 'Working on it… Done!' } } });
      server.broadcastEvent({ channel: 'agent-event', payload: { sequence: ++seq, event: { type: 'status', status: 'idle' } } });
      return { ok: true };
    },
    'agent.abort': () => ({ ok: true }),
    'agent.newSession': () => ({ cwd: '/workspace/demo', sessionId: 'sess-2', sessionPath: null }),
    'agent.switchWorkspace': () => ({ ok: true }),
    'agent.switchSession': () => ({ ok: true }),
    'agent.setModel': () => ({ ok: true }),
    'agent.setThinkingLevel': () => ({ ok: true }),
    'agent.setSessionAgent': () => ({ ok: true }),
    'agent.setAgentOption': () => ({ ok: true }),
    'agent.updateQueuedMessage': () => ({ ok: true }),
    'agent.interruptShellTools': () => ({ interrupted: 1 }),
    'agent.stopBackgroundTask': () => ({ stopped: true }),
    'agent.respondExtensionDialog': (params) => {
      dialogResponses.push(params);
      pendingDialogs = pendingDialogs.filter((d) => d.id !== params.id);
      server.broadcastEvent({ channel: 'extension-dialog-closed', payload: { id: params.id } });
      return { ok: true };
    },
    'workspace.listEntries': () => [{ name: 'src', path: 'src', kind: 'directory' }, { name: 'README.md', path: 'README.md', kind: 'file', size: 120 }],
    'workspace.readFile': ({ relativePath }) => ({ path: relativePath, content: '# Pi Desktop Remote\n' }),
    'workspace.gitStatus': () => ({ isRepository: true, branch: 'feat/mobile-remote', entries: [{ path: 'src/app.ts', staged: '', unstaged: 'M' }], truncated: false }),
    'workspace.gitDiff': ({ relativePath }) => ({ path: relativePath, diff: '@@ -1 +1 @@\n-old\n+new\n' }),
    'workspace.branches': () => ({ isRepository: true, current: 'feat/mobile-remote', detached: false, branches: ['main', 'feat/mobile-remote'] }),
  };

  server = await createRemoteServer(
    { bindHost: '127.0.0.1', port: 0 },
    {
      authStore,
      getDescriptor,
      getInitialSnapshot: async () => baseSnapshot,
      getPendingDialogs: () => pendingDialogs,
      handlers,
    },
  );
  t.after(() => server.stop());

  const baseUrl = `http://127.0.0.1:${server.port}`;
  const transport = {
    fetch: (input, init) => globalThis.fetch(input, init),
    createWebSocket: (url) => new globalThis.WebSocket(url),
  };

  // 0. The unauthenticated probe may be reachable through a public tunnel: it proves the
  //    environment id + protocol only, never the machine label, version, platform or LAN routes.
  const probe = await (await globalThis.fetch(`${baseUrl}/.well-known/pidesktop/environment`)).json();
  assert.deepEqual(Object.keys(probe).sort(), ['capabilities', 'environmentId', 'protocolVersion']);
  assert.equal(probe.environmentId, authStore.environmentId);
  assert.equal(JSON.stringify(probe).includes('Test Desktop'), false);
  assert.equal(JSON.stringify(probe).includes('tailnet'), false);

  // 1. Pair a full-control mobile client via QR pairing URL
  const fullGrant = await authStore.createPairingGrant({ label: 'Full Phone', role: 'full' });
  const fullPairingUrl = buildRemotePairingUrl({
    endpointUrl: baseUrl,
    code: fullGrant.code,
    environmentId: authStore.environmentId,
    label: 'Test Desktop',
  });

  // Wrong env ID in URL must be rejected before posting the secret
  const mismatchedUrl = buildRemotePairingUrl({
    endpointUrl: baseUrl,
    code: fullGrant.code,
    environmentId: 'wrong-env-id',
  });
  await assert.rejects(
    () =>
      pairWithDesktop({
        transport,
        pairingUrlOrAddress: mismatchedUrl,
        clientLabel: 'Attacker',
        deviceType: 'mobile',
        os: 'ios',
      }),
    /Environment ID mismatch/,
  );

  // Legitimate pairing succeeds and auto-learns Tailscale HTTPS route (excluding loopback)
  const fullEnv = await pairWithDesktop({
    transport,
    pairingUrlOrAddress: fullPairingUrl,
    clientLabel: 'My iPhone',
    deviceType: 'mobile',
    os: 'ios',
  });
  assert.equal(fullEnv.role, 'full');
  assert.equal(fullEnv.environmentId, authStore.environmentId);
  assert.ok(fullEnv.routes.some((r) => r.httpBaseUrl === 'https://test-desktop.tailnet.ts.net' && r.learned));

  // Connect live WebSocket client (ensure token never appears in WS URL)
  let capturedWsUrl = '';
  let mobileSnapshot = null;
  let mobileDialogs = [];
  const fullClient = new RemoteConnectionClient(
    {
      fetch: transport.fetch,
      createWebSocket: (url) => {
        capturedWsUrl = url;
        return new globalThis.WebSocket(url);
      },
    },
    {
      onHello: (hello) => {
        mobileSnapshot = hello.snapshot;
        mobileDialogs = [...hello.pendingDialogs];
      },
      onEvent: (event) => {
        if (event.channel === 'agent-event') {
          mobileSnapshot = applyRemoteAgentEvent(mobileSnapshot, event.payload);
        } else if (event.channel === 'extension-dialog') {
          mobileDialogs = mergeRemotePendingDialog(mobileDialogs, event.payload);
        } else if (event.channel === 'extension-dialog-closed') {
          mobileDialogs = removeRemotePendingDialog(mobileDialogs, event.payload.id);
        }
      },
    },
    { heartbeatIntervalMs: 60_000, betterRouteCheckIntervalMs: 60_000 },
  );
  t.after(() => fullClient.disconnect());

  fullClient.connect(fullEnv);
  await waitFor(() => fullClient.getState().phase === 'connected');
  assert.equal(capturedWsUrl.includes(fullEnv.accessToken), false, 'long-lived access token must never appear in WS URL');
  assert.ok(capturedWsUrl.includes('ticket='), 'WS URL must use single-use wsTicket');
  assert.equal(mobileSnapshot.messages[0].text, 'Hello desktop');

  // 2. Full client sends prompt and receives streamed assistant output
  await fullClient.call('agent.prompt', { text: 'Run tests' });
  await waitFor(() => mobileSnapshot?.messages.some((m) => m.id === 'a1' && m.status === 'done'));
  assert.equal(prompted.length, 1);
  assert.equal(mobileSnapshot.messages.find((m) => m.id === 'a1')?.text, 'Working on it… Done!');

  // 3. Desktop pushes an approval dialog -> phone receives and approves it
  const approvalReq = {
    id: 'dlg-approve-1',
    kind: 'confirm',
    title: 'Allow bash command?',
    message: 'npm test',
    approval: { command: 'npm test' },
  };
  pendingDialogs.push(approvalReq);
  server.broadcastEvent({ channel: 'extension-dialog', payload: approvalReq });
  await waitFor(() => mobileDialogs.length === 1);
  assert.equal(mobileDialogs[0].id, 'dlg-approve-1');

  await fullClient.call('agent.respondExtensionDialog', { id: 'dlg-approve-1', value: true });
  await waitFor(() => mobileDialogs.length === 0);
  assert.deepEqual(dialogResponses, [{ id: 'dlg-approve-1', value: true }]);

  // 4. Workspace file & Git diff RPCs work
  const fileRes = await fullClient.call('workspace.readFile', { relativePath: 'README.md' });
  assert.equal(fileRes.content, '# Pi Desktop Remote\n');
  const diffRes = await fullClient.call('workspace.gitDiff', { relativePath: 'src/app.ts' });
  assert.match(diffRes.diff, /\+new/);

  // 5. Pair a read-only client and verify server-side scope enforcement
  const roGrant = await authStore.createPairingGrant({ label: 'Tablet Viewer', role: 'read-only' });
  const roEnv = await pairWithDesktop({
    transport,
    pairingUrlOrAddress: baseUrl,
    code: roGrant.code,
    clientLabel: 'iPad Viewer',
    deviceType: 'tablet',
    os: 'ios',
  });
  const roClient = new RemoteConnectionClient(transport, {}, { heartbeatIntervalMs: 60_000, betterRouteCheckIntervalMs: 60_000 });
  t.after(() => roClient.disconnect());
  roClient.connect(roEnv);
  await waitFor(() => roClient.getState().phase === 'connected');

  const roGit = await roClient.call('workspace.gitStatus');
  assert.equal(roGit.branch, 'feat/mobile-remote');
  await assert.rejects(
    () => roClient.call('agent.prompt', { text: 'Should be forbidden' }),
    (err) => err instanceof RemoteRpcCallError && err.code === 'forbidden' && err.requiredScope === 'chat:operate',
  );

  // 6. Revoking full client on desktop immediately disconnects its live socket with auth-error
  assert.equal(server.activeSocketCount(), 2);
  await authStore.revokeSession(fullEnv.sessionId);
  await waitFor(() => fullClient.getState().phase === 'auth-error');
  await waitFor(() => server.activeSocketCount() === 1);
});
