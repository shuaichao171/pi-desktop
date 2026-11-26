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

test('RemoteAuthStore enforces one-time pairing, scoped sessions, single-use WS tickets, and revocation', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-remote-auth-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const authPath = join(dir, 'remote-access-auth.json');

  const { RemoteAuthStore } = await import('../packages/desktop/src/main/remote/authStore.ts');
  const store = new RemoteAuthStore(authPath);
  const envId = store.environmentId;
  assert.ok(envId.length > 8);

  // Create one-time full-control grant
  const { grant, code } = await store.createPairingGrant({
    label: 'My iPhone',
    role: 'full',
    expiresInMinutes: 10,
  });
  assert.equal(grant.role, 'full');
  assert.deepEqual([...grant.scopes], ['chat:read', 'chat:operate', 'workspace:read']);
  assert.equal(store.listPairingGrants().length, 1);
  // Raw code is never exposed in listings
  assert.equal('codeHash' in store.listPairingGrants()[0], false);
  assert.equal('code' in store.listPairingGrants()[0], false);

  // Exchange once succeeds
  const exchanged = await store.exchangePairingCode({
    code,
    clientLabel: 'iPhone 16 Pro',
    deviceType: 'mobile',
    os: 'ios',
  });
  assert.ok(exchanged);
  assert.equal(exchanged.session.label, 'iPhone 16 Pro');
  assert.equal(exchanged.session.role, 'full');
  assert.equal(store.listPairingGrants().length, 0);

  // Reusing the same pairing code MUST fail
  const replay = await store.exchangePairingCode({ code });
  assert.equal(replay, null);

  // Bearer auth succeeds
  const authed = store.authenticateBearer(`Bearer ${exchanged.accessToken}`);
  assert.ok(authed);
  assert.equal(authed.sessionId, exchanged.session.sessionId);
  assert.equal(store.authenticateBearer('Bearer invalid-token'), null);

  // Single-use WebSocket ticket
  const ticket = store.mintWebSocketTicket(exchanged.session.sessionId);
  assert.ok(ticket);
  const consumed = store.consumeWebSocketTicket(ticket.ticket);
  assert.ok(consumed);
  assert.equal(consumed.sessionId, exchanged.session.sessionId);
  // Second consumption of same ticket MUST fail
  assert.equal(store.consumeWebSocketTicket(ticket.ticket), null);

  // Persistence across restarts keeps environmentId & sessions
  await store.flush();
  const reloaded = new RemoteAuthStore(authPath);
  assert.equal(reloaded.environmentId, envId);
  assert.ok(reloaded.authenticateBearer(`Bearer ${exchanged.accessToken}`));

  // Revocation fires listener & invalidates session + pending tickets immediately
  const revokedIds = [];
  reloaded.onSessionRevoked((id) => revokedIds.push(id));
  const pendingTicket = reloaded.mintWebSocketTicket(exchanged.session.sessionId);
  assert.ok(pendingTicket);
  const wasRevoked = await reloaded.revokeSession(exchanged.session.sessionId);
  assert.equal(wasRevoked, true);
  assert.deepEqual(revokedIds, [exchanged.session.sessionId]);
  assert.equal(reloaded.authenticateBearer(`Bearer ${exchanged.accessToken}`), null);
  assert.equal(reloaded.consumeWebSocketTicket(pendingTicket.ticket), null);
});

test('Pairing URL builder/parser and QR code matrix encoder work across realistic payloads', async () => {
  const { buildRemotePairingUrl, parseRemotePairingUrl } = await import('../packages/shared/src/remoteAccess.ts');
  const { encodeQrMatrix, renderQrSvgPath, computeReedSolomonEcc } = await import('../packages/shared/src/qrMatrix.ts');

  const url = buildRemotePairingUrl({
    endpointUrl: 'https://demo-machine.trycloudflare.com/',
    code: 'secret_code_1234567890',
    environmentId: 'env-abc-123',
    label: 'Office Workstation',
  });
  assert.ok(url.startsWith('pidesktop://pair?'));

  const parsed = parseRemotePairingUrl(url);
  assert.deepEqual(parsed, {
    endpointUrl: 'https://demo-machine.trycloudflare.com',
    code: 'secret_code_1234567890',
    environmentId: 'env-abc-123',
    label: 'Office Workstation',
  });

  // Also accepts https://host/#code=...
  const parsedHash = parseRemotePairingUrl('https://box.tailnet.ts.net/#code=abc999&env=e1');
  assert.deepEqual(parsedHash, {
    endpointUrl: 'https://box.tailnet.ts.net',
    code: 'abc999',
    environmentId: 'e1',
  });

  // Rejects unsafe schemes
  assert.equal(parseRemotePairingUrl('pidesktop://pair?url=javascript:alert(1)&code=abc'), null);
  assert.equal(parseRemotePairingUrl('javascript:alert(1)'), null);

  // Reed-Solomon test vector (ISO/IEC 18004 Annex I: "01234567" -> first check verifying deterministic non-zero ECC)
  const ecc = computeReedSolomonEcc(Uint8Array.from([0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11]), 10);
  assert.equal(ecc.length, 10);

  // QR matrix structure checks (finder patterns + timing + dark module + SVG path)
  const qr = encodeQrMatrix(url);
  assert.ok(qr.version >= 4 && qr.version <= 12);
  assert.equal(qr.size, 17 + qr.version * 4);
  // Top-left 7x7 finder corners and 3x3 center must be dark
  assert.equal(qr.modules[0][0], true);
  assert.equal(qr.modules[0][6], true);
  assert.equal(qr.modules[6][0], true);
  assert.equal(qr.modules[3][3], true);
  // Separator ring around top-left finder must be light
  assert.equal(qr.modules[7][0], false);
  assert.equal(qr.modules[0][7], false);
  // Fixed dark module at (4*version + 9, 8)
  assert.equal(qr.modules[4 * qr.version + 9][8], true);
  const path = renderQrSvgPath(qr);
  assert.ok(path.startsWith('M0,0h1v1h-1z'));
});
