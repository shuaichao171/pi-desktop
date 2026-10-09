import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('./') && context.parentURL && new URL(context.parentURL).pathname.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

// Deletion now matches the native pi CLI: the transcript file is unlinked
// directly with no app trash. The end-to-end handler flow (prepare → unlink →
// release, queueing, guards) lives in agent-ipc.test.mjs; here we keep the
// group-membership cleanup invariants that outlived the trash removal.
test('group membership is dropped everywhere when a session is removed', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'pi-session-delete-'));
  t.after(async () => { rmSync(temp, { recursive: true, force: true }); });
  const { SessionGroupService } = await import('../packages/desktop/src/main/sessionGroups.ts');
  const statePath = join(temp, 'groups.json');
  const service = new SessionGroupService({ path: statePath, validateSessionPath: async () => {} });
  await service.update({ type: 'create', name: 'Research' });
  await service.update({ type: 'create', name: 'Infra' });
  const groups = await service.list();
  await service.update({ type: 'move-session', sessionPath: join(temp, 'a.jsonl'), groupId: groups[0].id });
  await service.update({ type: 'move-session', sessionPath: join(temp, 'b.jsonl'), groupId: groups[0].id });
  await service.update({ type: 'move-session', sessionPath: join(temp, 'a.jsonl'), groupId: groups[1].id });
  const afterRemoval = await service.removeSession(join(temp, 'a.jsonl'));
  assert.deepEqual(afterRemoval.map((group) => group.sessionPaths), [[join(temp, 'b.jsonl')], []]);
  const persisted = await service.list();
  assert.deepEqual(persisted.map((group) => group.sessionPaths), [[join(temp, 'b.jsonl')], []]);
  // Removing an unknown session is a no-op that keeps groups intact.
  const untouched = await service.removeSession(join(temp, 'ghost.jsonl'));
  assert.equal(untouched.length, 2);
});
