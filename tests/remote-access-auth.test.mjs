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
  // The note typed on the desktop names the device; the phone's generic model name does not override it.
  assert.equal(exchanged.session.label, 'My iPhone');
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

test('RemoteAuthStore names a device by the phone-reported label only when the desktop left the note empty', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-remote-auth-label-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const authPath = join(dir, 'remote-access-auth.json');

  const { RemoteAuthStore } = await import('../packages/desktop/src/main/remote/authStore.ts');
  const store = new RemoteAuthStore(authPath);

  // No desktop note: the grant shows a placeholder until the phone reports its model.
  const unnamed = await store.createPairingGrant({ label: '   ', role: 'read-only' });
  assert.equal(unnamed.grant.label, 'Read-only device');
  assert.equal('labelFromDesktop' in unnamed.grant, false, 'internal flag stays out of public grants');
  assert.equal('labelFromDesktop' in store.listPairingGrants()[0], false);
  // The flag survives a restart between minting the QR code and the phone scanning it.
  await store.flush();
  const reloaded = new RemoteAuthStore(authPath);
  const reported = await reloaded.exchangePairingCode({ code: unnamed.code, clientLabel: 'Xiaomi MI 6', os: 'android' });
  assert.ok(reported);
  assert.equal(reported.session.label, 'Xiaomi MI 6');

  // No note and nothing reported: the placeholder remains.
  const silent = await reloaded.createPairingGrant({ role: 'full' });
  const silentSession = await reloaded.exchangePairingCode({ code: silent.code });
  assert.ok(silentSession);
  assert.equal(silentSession.session.label, 'Mobile device');

  // A desktop note survives a restart too and still wins.
  const named = await reloaded.createPairingGrant({ label: 'Kitchen tablet', role: 'full' });
  await reloaded.flush();
  const again = new RemoteAuthStore(authPath);
  const namedSession = await again.exchangePairingCode({ code: named.code, clientLabel: 'Samsung SM-X200' });
  assert.ok(namedSession);
  assert.equal(namedSession.session.label, 'Kitchen tablet');
  await again.flush();
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

  // Regression (C1/M5): Version 7-16 alignment patterns centered on timing row/col 6 MUST be drawn
  // (never skipped because timing patterns were placed first), and long payloads up to V16 encode cleanly.
  const v7Payload = 'https://demo-machine.trycloudflare.com/pair?' + 'a'.repeat(100);
  const qrV7 = encodeQrMatrix(v7Payload);
  assert.equal(qrV7.version, 7);
  // V7 centers are [6, 22, 38]; check the 5x5 alignment patterns centered at (6, 22) and (22, 6).
  // Alignment modules are function modules so they are never masked.
  for (const [cr, cc] of [[6, 22], [22, 6], [22, 22], [22, 38], [38, 22], [38, 38]]) {
    for (let dr = -2; dr <= 2; dr += 1) {
      for (let dc = -2; dc <= 2; dc += 1) {
        const expectedDark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
        assert.equal(qrV7.modules[cr + dr][cc + dc], expectedDark, `V7 alignment (${cr},${cc}) offset (${dr},${dc})`);
      }
    }
  }
  const qrV15 = encodeQrMatrix('x'.repeat(500));
  assert.ok(qrV15.version >= 15 && qrV15.version <= 16);
  for (const [cr, cc] of [[6, 26], [6, 48], [26, 6], [48, 6]]) {
    for (let dr = -2; dr <= 2; dr += 1) {
      for (let dc = -2; dc <= 2; dc += 1) {
        const expectedDark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
        assert.equal(qrV15.modules[cr + dr][cc + dc], expectedDark, `V15 alignment (${cr},${cc}) offset (${dr},${dc})`);
      }
    }
  }
});

test('RemoteAuthStore guards NaN TTL, caps WS tickets, and notifies revocation synchronously', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-remote-auth-hardening-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { RemoteAuthStore } = await import('../packages/desktop/src/main/remote/authStore.ts');
  const store = new RemoteAuthStore(join(dir, 'auth.json'));

  const { grant, code } = await store.createPairingGrant({ role: 'full', expiresInMinutes: Number.NaN });
  assert.ok(Number.isFinite(Date.parse(grant.expiresAt)), 'NaN expiresInMinutes falls back to default TTL');

  const exchanged = await store.exchangePairingCode({ code });
  assert.ok(exchanged);
  const sid = exchanged.session.sessionId;

  // Minting more than per-session cap evicts the oldest tickets
  const minted = [];
  for (let i = 0; i < 20; i += 1) {
    minted.push(store.mintWebSocketTicket(sid).ticket);
  }
  assert.equal(store.consumeWebSocketTicket(minted[0]), null, 'oldest ticket evicted by per-session cap');
  assert.ok(store.consumeWebSocketTicket(minted.at(-1)), 'newest ticket remains valid');

  // Revocation callback fires synchronously before disk persistence finishes
  const revoked = [];
  store.onSessionRevoked((id) => revoked.push(id));
  const revokePromise = store.revokeSession(sid);
  assert.deepEqual(revoked, [sid], 'revoke listeners run synchronously before awaiting persist()');
  await revokePromise;
  await store.flush();
});

test('RemoteAuthStore expires connected sessions too and slides expiry on WebSocket RPC use', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-remote-auth-expiry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  const day = 24 * 60 * 60 * 1000;

  const { RemoteAuthStore } = await import('../packages/desktop/src/main/remote/authStore.ts');
  const store = new RemoteAuthStore(join(dir, 'remote-access-auth.json'));
  const pair = async (label) => {
    const { code } = await store.createPairingGrant({ label, role: 'full' });
    const exchanged = await store.exchangePairingCode({ code });
    assert.ok(exchanged);
    return exchanged.session.sessionId;
  };
  const idle = await pair('Idle phone');
  const active = await pair('Active phone');
  const revoked = [];
  store.onSessionRevoked((id) => revoked.push(id));
  // Both devices hold a live socket: being connected must not keep a session alive.
  store.markConnected(idle, '10.0.0.2');
  store.markConnected(active, '10.0.0.3');

  // RPC traffic is activity and slides the 30-day window; the idle one never slides.
  t.mock.timers.tick(20 * day);
  assert.equal(store.touchSession(active), true);
  t.mock.timers.tick(11 * day);
  store.sweepExpired();
  assert.deepEqual(revoked, [idle], 'the expired session is revoked so its sockets close');
  assert.equal(store.touchSession(idle), false, 'an expired session fails the per-RPC check');
  assert.deepEqual(store.listSessions().map((s) => s.sessionId), [active]);
  assert.equal(store.mintWebSocketTicket(idle), null);
  assert.equal(store.touchSession(active), true);
  await store.flush();
});
