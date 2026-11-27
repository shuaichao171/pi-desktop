import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Electron stub: ipcMain records handlers; safeStorage is a reversible fake whose
// keychain can be "lost" to model a profile copied to another machine.
const electronStub = `
  const state = globalThis.__remoteConfigElectron ??= { handlers: new Map(), keychain: true };
  export const ipcMain = { handle: (channel, fn) => state.handlers.set(channel, fn) };
  export const BrowserWindow = {
    getAllWindows: () => [],
    fromWebContents: (sender) => ({ isDestroyed: () => false, webContents: sender }),
  };
  export const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from('sealed:' + [...value].reverse().join(''), 'utf8'),
    decryptString: (buffer) => {
      if (!state.keychain) throw new Error('keychain unavailable');
      const text = buffer.toString('utf8');
      if (!text.startsWith('sealed:')) throw new Error('bad ciphertext');
      return [...text.slice(7)].reverse().join('');
    },
  };
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: `data:text/javascript,${encodeURIComponent(electronStub)}`, shortCircuit: true };
    if (specifier === '@pidesktop/shared/remoteAccess') return nextResolve(new URL('../packages/shared/src/remoteAccess.ts', import.meta.url).href, context);
    if (specifier === '@pidesktop/shared') return nextResolve(new URL('../packages/shared/src/index.ts', import.meta.url).href, context);
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL && new URL(context.parentURL).pathname.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const RAW_TOKEN = 'eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0';

function legacyConfig(token) {
  return {
    version: 1, enabled: false, port: 47321, exposureMode: 'lan', machineLabel: 'Test PC',
    tailscaleServeEnabled: false, tailscaleServePort: 8443,
    cloudflareMode: 'named', cloudflareTunnelToken: token, cloudflarePublicHostname: 'pi.example.com',
  };
}

test('the Cloudflare tunnel token is stored encrypted and legacy plaintext files are migrated', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-remote-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'remote-access.json');
  writeFileSync(configPath, JSON.stringify(legacyConfig(RAW_TOKEN)));

  await import('electron');
  const electron = globalThis.__remoteConfigElectron;
  const { registerRemoteAccessIpc } = await import('../packages/desktop/src/main/remote/remoteAccessIpc.ts');
  const { REMOTE_ACCESS_CHANNELS } = await import('../packages/shared/src/remoteAccess.ts');
  const frame = {};
  const sender = { isDestroyed: () => false, mainFrame: frame };
  const event = { sender, senderFrame: frame };
  const register = () => registerRemoteAccessIpc({
    userDataDir: dir,
    appVersion: () => '0.0.0-test',
    getInitialSnapshot: async () => ({}),
    getPendingDialogs: () => [],
    handlers: {},
    requireTrustedSender: () => {},
  });
  const stored = () => JSON.parse(readFileSync(configPath, 'utf8'));

  // Boot on a pre-encryption file: the token still works and is rewritten encrypted.
  let controller = register();
  assert.equal(controller.getState().config.hasCloudflareTunnelToken, true);
  await controller.dispose();
  assert.match(stored().cloudflareTunnelToken, /^enc:/);
  assert.equal(readFileSync(configPath, 'utf8').includes(RAW_TOKEN), false, 'no plaintext token left on disk');

  // A restart decrypts it again; a new token from the settings page is also written encrypted.
  controller = register();
  assert.equal(controller.getState().config.hasCloudflareTunnelToken, true);
  const replacement = 'eyJuZXciOiJ0b2tlbiJ9-replacement';
  await electron.handlers.get(REMOTE_ACCESS_CHANNELS.setConfig)(event, { cloudflareTunnelToken: replacement });
  await controller.dispose();
  assert.match(stored().cloudflareTunnelToken, /^enc:/);
  assert.equal(readFileSync(configPath, 'utf8').includes(replacement), false);
  assert.equal(stored().cloudflarePublicHostname, 'pi.example.com', 'other fields are stored as-is');

  // An unreadable ciphertext (other machine's keychain) counts as no token rather than failing startup.
  electron.keychain = false;
  controller = register();
  assert.equal(controller.getState().config.hasCloudflareTunnelToken, false);
  await controller.dispose();
  electron.keychain = true;
});
