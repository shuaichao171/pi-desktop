import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

const notifications = [];
let settingsError = null;
globalThis.__notifierTest = {
  Notification: class extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; }
    show() { notifications.push(this); }
  },
  readSettings() { if (settingsError) throw settingsError; return { notificationsEnabled: true }; },
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const sources = {
      electron: 'export const { Notification } = globalThis.__notifierTest; export class BrowserWindow {}',
      './appLocale': "export const getAppLocale = () => 'en-US';",
      './desktopSettings': 'export const readDesktopSettings = () => globalThis.__notifierTest.readSettings();',
    };
    if (sources[specifier]) return { url: `data:text/javascript,${encodeURIComponent(sources[specifier])}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { createDesktopNotifier } = await import('../packages/desktop/src/main/notifications.ts');

test('assistant errors survive a final idle status and notification clicks retain workspace identity', () => {
  const revealed = [];
  const notifier = createDesktopNotifier({ settingsPath: () => '', getMainWindow: () => null,
    revealSession: (...args) => revealed.push(args) });
  const emit = (event) => notifier.handleAgentEvent({ sequence: 1, event }, '/sessions/task.jsonl', '/work/project');
  notifications.length = 0;
  emit({ type: 'status', status: 'busy' });
  emit({ type: 'assistant-end', errorMessage: 'Provider quota exhausted' });
  emit({ type: 'status', status: 'idle' });
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].options.title, /Task failed/);
  assert.equal(notifications[0].options.body, 'Provider quota exhausted');
  notifications[0].emit('click');
  assert.deepEqual(revealed, [['/sessions/task.jsonl', '/work/project']]);
  emit({ type: 'status', status: 'busy' });
  emit({ type: 'status', status: 'idle' });
  assert.match(notifications[1].options.title, /Task finished/);
});

test('automation notifications reveal their own workspace and cancelled runs stay silent', () => {
  const revealed = [];
  const notifier = createDesktopNotifier({ settingsPath: () => '', getMainWindow: () => null,
    revealSession: (...args) => revealed.push(args) });
  notifications.length = 0;
  const run = { status: 'succeeded', summary: 'Done', error: null, sessionPath: '/sessions/automation.jsonl' };
  notifier.handleAutomationRun(run, 'Review', '/work/other');
  notifications[0].emit('click');
  assert.deepEqual(revealed, [[run.sessionPath, '/work/other']]);
  notifier.handleAutomationRun({ ...run, status: 'cancelled' }, 'Review', '/work/other');
  assert.equal(notifications.length, 1);
});

test('a settings IO failure cannot escape the agent event callback', (t) => {
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  settingsError = new Error('Permission denied');
  t.after(() => { settingsError = null; });
  const notifier = createDesktopNotifier({ settingsPath: () => '', getMainWindow: () => null, revealSession() {} });
  notifier.handleAgentEvent({ event: { type: 'status', status: 'busy' } }, null);
  assert.doesNotThrow(() => notifier.handleAgentEvent({ event: { type: 'status', status: 'idle' } }, null));
  assert.equal(errors.length, 1);
});

test('switching from a running conversation to an idle one is not a task completion', () => {
  notifications.length = 0;
  const notifier = createDesktopNotifier({ settingsPath: () => '', getMainWindow: () => null, revealSession() {} });
  notifier.handleAgentEvent({ event: { type: 'status', status: 'busy' } }, '/sessions/running.jsonl');
  notifier.handleAgentEvent({ event: { type: 'ready' } }, '/sessions/idle.jsonl');
  notifier.handleAgentEvent({ event: { type: 'status', status: 'idle' } }, '/sessions/idle.jsonl');
  assert.equal(notifications.length, 0);
  notifier.handleAgentEvent({ event: { type: 'status', status: 'busy' } }, '/sessions/idle.jsonl');
  notifier.handleAgentEvent({ event: { type: 'status', status: 'idle' } }, '/sessions/idle.jsonl');
  assert.equal(notifications.length, 1);
});
