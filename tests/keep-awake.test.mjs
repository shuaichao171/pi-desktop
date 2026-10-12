import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// Injectable-controller test: Electron's powerSaveBlocker is stubbed out the
// same way notifications.test.mjs stubs Notification, so the reconciliation
// logic runs in plain Node.
let settings = { keepAwakeWhileRunning: false };
const started = [];
const stopped = [];
globalThis.__keepAwakeTest = {
  readSettings() { return settings; },
  start() { const id = started.length + 1; started.push(id); return id; },
  stop(id) { if (id === 42) throw new Error('already stopped'); stopped.push(id); },
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const sources = {
      electron: 'export const powerSaveBlocker = { start: () => globalThis.__keepAwakeTest.start(), stop: (id) => globalThis.__keepAwakeTest.stop(id) };',
      './desktopSettings': 'export const readDesktopSettings = () => globalThis.__keepAwakeTest.readSettings();',
    };
    if (sources[specifier]) return { url: `data:text/javascript,${encodeURIComponent(sources[specifier])}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { createKeepAwakeController } = await import('../packages/desktop/src/main/keepAwake.ts');

function freshController() {
  started.length = 0;
  stopped.length = 0;
  settings = { keepAwakeWhileRunning: false };
  return createKeepAwakeController({ settingsPath: () => 'test-settings.json', log: () => {} });
}

test('no blocker while the preference is off, even with active work', () => {
  const controller = freshController();
  controller.setAgentBusy(true);
  controller.setAutomationActive(true);
  assert.equal(controller.isBlocking(), false);
  assert.equal(started.length, 0);
});

test('the blocker follows agent busy transitions while the preference is on', () => {
  const controller = freshController();
  settings = { keepAwakeWhileRunning: true };
  controller.settingsChanged();
  assert.equal(controller.isBlocking(), false);
  controller.setAgentBusy(true);
  assert.equal(controller.isBlocking(), true);
  assert.equal(started.length, 1);
  controller.setAgentBusy(false);
  assert.equal(controller.isBlocking(), false);
  assert.deepEqual(started, stopped);
});

test('automation activity alone holds the blocker and toggling the preference releases it', () => {
  const controller = freshController();
  settings = { keepAwakeWhileRunning: true };
  controller.setAutomationActive(true);
  assert.equal(controller.isBlocking(), true);
  settings = { keepAwakeWhileRunning: false };
  controller.settingsChanged();
  assert.equal(controller.isBlocking(), false);
  assert.deepEqual(started, stopped);
});

test('a stop failure on an already-invalid id never wedges the controller', () => {
  const controller = freshController();
  settings = { keepAwakeWhileRunning: true };
  controller.setAgentBusy(true);
  controller.setAgentBusy(false);
  settings = { keepAwakeWhileRunning: true };
  controller.setAgentBusy(true);
  assert.equal(controller.isBlocking(), true);
  controller.dispose();
  assert.equal(controller.isBlocking(), false);
});

test('repeated transitions do not churn the blocker', () => {
  const controller = freshController();
  settings = { keepAwakeWhileRunning: true };
  controller.setAgentBusy(true);
  controller.setAgentBusy(true);
  controller.settingsChanged();
  assert.equal(started.length, 1);
});
