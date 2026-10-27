import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const stubs = {
  electron: `
    export const BrowserWindow = {
      fromWebContents: (wc) => globalThis.__guardWindows.get(wc) ?? null,
      getAllWindows: () => [],
    };
    export const ipcMain = { handle: (channel, handler) => globalThis.__guardHandlers.set(channel, handler) };
  `,
  '@earendil-works/pi-coding-agent': `export const getAgentDir = () => globalThis.__guardAgentDir;`,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (stubs[specifier]) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
    if (specifier.startsWith('./') && context.parentURL && new URL(context.parentURL).pathname.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { registerInputAttachmentIpc } = await import('../packages/desktop/src/main/inputAttachmentIpc.ts');
// Same file the package specifier resolves to, so the channel constants share one instance.
const { INPUT_FEATURE_CHANNELS: CH } = await import('../packages/shared/src/index.ts');

// A live main-frame renderer sender that satisfies requireRendererSender.
const sender = { mainFrame: {}, isDestroyed: () => false };
globalThis.__guardWindows = new Map([[sender, { isDestroyed: () => false, webContents: sender }]]);
globalThis.__guardHandlers = new Map();
const event = { sender, senderFrame: sender.mainFrame };
const invoke = (channel, ...args) => globalThis.__guardHandlers.get(channel)(event, ...args);

test('draft and attachment scopes authorize every live window, not just the main conversation', async () => {
  globalThis.__guardAgentDir = mkdtempSync(join(tmpdir(), 'pi-input-guard-'));
  const main = { cwd: 'C:\\main', sessionPath: 'C:\\sessions\\main.jsonl' };
  const pai = { cwd: 'C:\\pai-proj', sessionPath: 'C:\\sessions\\pai.jsonl' };
  let live = [main, pai];
  const features = registerInputAttachmentIpc(() => live);

  // The pai window's own scope passes the guard end to end. Regression: the
  // red banner "草稿无法保存到本机" came from get-draft rejecting this scope.
  assert.equal((await invoke(CH.getInputDraft, pai)).version, 0);
  const saved = await invoke(CH.saveInputDraft, { ...pai, expectedVersion: 0, text: 'pai note', attachmentIds: [] });
  assert.equal(saved.version, 1);
  assert.equal((await invoke(CH.getInputDraft, pai)).text, 'pai note');
  // Drafts stay isolated per scope.
  assert.equal((await invoke(CH.getInputDraft, main)).text, '');

  // A scope no live window owns is still refused.
  const stranger = { cwd: 'C:\\elsewhere', sessionPath: null };
  await assert.rejects(async () => invoke(CH.getInputDraft, stranger), /草稿所属工作区或会话已变化/);

  // rememberScope authorizes the deferred draft handoff after navigation.
  features.rememberScope(stranger);
  assert.equal((await invoke(CH.getInputDraft, stranger)).version, 0);

  // A scope that was live stays authorized after its window closes, matching
  // the original once-active semantics for the main conversation.
  live = [main];
  assert.equal((await invoke(CH.getInputDraft, pai)).text, 'pai note');
  features.dispose();
});
