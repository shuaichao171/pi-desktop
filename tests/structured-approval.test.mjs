import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seedTestModel } from './helpers/testModel.mjs';
import { requireApprovalDetails, requireDialogResponse } from '../packages/shared/src/approval.ts';
import { requestDesktopConfirmation } from '../packages/agent/src/extensionApproval.ts';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';

test('legacy confirmations preserve boolean responses and cancellation', async () => {
  let request;
  assert.equal(await requestDesktopConfirmation(async value => { request = value; return true; }, 'Continue', 'Proceed'), true);
  assert.equal(request.approval, undefined);
  assert.equal(await requestDesktopConfirmation(async () => null, 'Continue', 'Proceed'), false);
  assert.throws(() => requireDialogResponse({ kind: 'confirm' }, { approved: true, scope: 'once' }), /无效/);
});

test('structured confirmation carries command and diff and returns declined feedback to its actual caller', async () => {
  let seen, result;
  const controller = new AbortController();
  const accepted = await requestDesktopConfirmation(async (request, signal) => {
    seen = request; assert.equal(signal, controller.signal);
    return { approved: false, scope: 'once', feedback: '  Inspect first  ' };
  }, 'Permission', 'Review this edit', {
    signal: controller.signal, timeout: 5000,
    approval: { source: 'workspace extension', command: 'git diff', cwd: '/demo', files: [{ path: 'demo.ts', diff: '-old\n+new' }], scopes: ['once', 'session'] },
    onApprovalDecision: decision => { result = decision; },
  });
  assert.equal(accepted, false);
  assert.equal(seen.approval.command, 'git diff');
  assert.equal(seen.approval.files[0].diff, '-old\n+new');
  assert.deepEqual(result, { approved: false, scope: 'once', feedback: 'Inspect first' });
});

test('broader authorization requires a receiver and cannot be forged beyond the offered scopes', async () => {
  let offered, decision;
  await requestDesktopConfirmation(async request => { offered = request.approval.scopes; return true; }, 'A', 'B', { approval: { scopes: ['workspace'] } });
  assert.deepEqual(offered, ['once']);
  assert.equal(await requestDesktopConfirmation(async () => ({ approved: true, scope: 'session' }), 'A', 'B', {
    approval: { scopes: ['session'] }, onApprovalDecision: value => { decision = value; },
  }), true);
  assert.deepEqual(decision, { approved: true, scope: 'session' });
  assert.throws(() => requireDialogResponse({ kind: 'confirm', approval: { scopes: ['once'] } }, { approved: true, scope: 'workspace' }), /授权范围/);
  assert.throws(() => requireDialogResponse({ kind: 'confirm', approval: {} }, { approved: false, scope: 'workspace' }), /授权范围/);
  assert.throws(() => requireDialogResponse({ kind: 'confirm', approval: {} }, { approved: false, scope: 'once', feedback: 'x'.repeat(4001) }), /无效/);
  assert.throws(() => requireDialogResponse({ kind: 'select', options: ['safe'] }, 'forged'), /无效/);
});

test('malformed and unbounded approval metadata fails before requesting permission', async () => {
  assert.throws(() => requireApprovalDetails({ files: [{ path: 'x', diff: 'x'.repeat(64001) }] }), /无效/);
  assert.throws(() => requireApprovalDetails({ scopes: ['always'] }), /范围/);
  let requested = false;
  await assert.rejects(requestDesktopConfirmation(async () => { requested = true; return true; }, 'A', 'B', { approval: { command: 12 } }), /无效/);
  assert.equal(requested, false);
});

test('a real loaded Pi extension receives structured rejection feedback through the desktop UI context', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-approval-'));
  const workspace = join(directory, 'workspace');
  const extensions = join(workspace, '.pi', 'extensions');
  const marker = join(directory, 'decision.json');
  await mkdir(extensions, { recursive: true });
  await writeFile(join(extensions, 'approval.ts'), `
    import { writeFileSync } from 'node:fs';
    export default function(pi) {
      pi.registerCommand('approval-test', { handler: async (_args, ctx) => {
        let decision;
        const approved = await ctx.ui.confirm('Inspect command', 'Review the requested command', {
          approval: { source: 'Test extension', command: 'git status', scopes: ['once', 'session'] },
          onApprovalDecision(value) { decision = value; }
        });
        writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ approved, decision }));
      }});
    }
  `);
  const previous = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map(key => [key, process.env[key]]));
  seedTestModel(join(directory, 'agent'));
  process.env.PI_CODING_AGENT_DIR = join(directory, 'agent'); process.env.PI_OFFLINE = '1';
  let service;
  try {
    const { AgentService } = await import('../packages/agent/src/index.ts');
    let request;
    service = new AgentService(async () => ({ trusted: true, remember: false }), async value => {
      request = value; return { approved: false, scope: 'once', feedback: 'Read the diff first' };
    });
    await service.init({ cwd: workspace });
    await service.executeSlashCommand({ cwd: workspace, sessionId: service.getSnapshot().sessionId, name: 'approval-test' });
    assert.equal(request.approval.command, 'git status');
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), { approved: false, decision: { approved: false, scope: 'once', feedback: 'Read the diff first' } });
  } finally {
    await service?.dispose();
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const safe = relative(resolve(tmpdir()), resolve(directory));
    if (safe.startsWith('..') || isAbsolute(safe)) throw new Error('Unsafe fixture cleanup');
    await rm(directory, { recursive: true, force: true });
  }
});
