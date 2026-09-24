import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('./') && context.parentURL && new URL(context.parentURL).pathname.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});
const { SessionGroupService } = await import('../packages/desktop/src/main/sessionGroups.ts');

async function fixture(t) {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, 'pi-session-groups-'));
  t.after(async () => {
    assert.equal(dirname(root), temp);
    await rm(root, { recursive: true, force: true });
  });
  const path = join(root, 'session-groups.json');
  const first = join(root, 'first.jsonl');
  const second = join(root, 'second.jsonl');
  const contents = '{"type":"session","id":"untouched"}\n';
  await Promise.all([writeFile(first, contents), writeFile(second, contents)]);
  const validated = [];
  const backups = [];
  const create = () => new SessionGroupService({
    path,
    validateSessionPath: async (sessionPath) => {
      validated.push(sessionPath);
      if (![first, second].includes(sessionPath)) throw new Error('未找到会话');
    },
    onCorruptState: (backup) => backups.push(backup),
  });
  return { root, path, first, second, contents, validated, backups, create, service: create() };
}

test('custom groups persist names and unique membership while deletion leaves conversations intact', async (t) => {
  const { service, create, first, second, contents } = await fixture(t);
  assert.deepEqual(await service.list(), []);
  const [one] = await service.update({ type: 'create', name: '  工作  ' });
  assert.equal(one.name, '工作');
  assert.ok(one.id);
  assert.deepEqual(one.sessionPaths, []);
  const [two] = await service.update({ type: 'create', name: '个人' });
  await service.update({ type: 'move-session', sessionPath: first, groupId: one.id });
  await service.update({ type: 'move-session', sessionPath: second, groupId: one.id });
  await service.update({ type: 'move-session', sessionPath: first, groupId: two.id });
  await service.update({ type: 'move-session', sessionPath: first, groupId: two.id });
  await service.update({ type: 'rename', id: one.id, name: '  工作项目  ' });
  assert.deepEqual(await create().list(), [
    { id: two.id, name: '个人', sessionPaths: [first] },
    { id: one.id, name: '工作项目', sessionPaths: [second] },
  ], 'restarting the service retains membership and the stable group id');
  await service.update({ type: 'move-session', sessionPath: first, groupId: null });
  assert.deepEqual((await service.list())[0].sessionPaths, []);
  await service.update({ type: 'delete', id: one.id });
  assert.deepEqual(await create().list(), [{ id: two.id, name: '个人', sessionPaths: [] }]);
  assert.equal(await readFile(first, 'utf8'), contents);
  assert.equal(await readFile(second, 'utf8'), contents, 'deleting a nonempty group does not modify or remove session files');
});

test('concurrent group updates and reads cannot overwrite one another, and failures do not poison the queue', async (t) => {
  const { service, create, first, second } = await fixture(t);
  await Promise.all(Array.from({ length: 12 }, (_, index) => service.update({ type: 'create', name: `Group ${index}` })));
  const groups = await service.list();
  assert.equal(groups.length, 12);
  const mutations = [
    service.update({ type: 'move-session', sessionPath: first, groupId: groups[0].id }),
    service.update({ type: 'move-session', sessionPath: second, groupId: groups[0].id }),
    service.update({ type: 'move-session', sessionPath: first, groupId: groups[1].id }),
    service.update({ type: 'rename', id: groups[0].id, name: 'Renamed' }),
  ];
  const reading = service.list();
  await Promise.all(mutations);
  const saved = await reading;
  assert.deepEqual(saved[0], { id: groups[0].id, name: 'Renamed', sessionPaths: [second] });
  assert.deepEqual(saved[1].sessionPaths, [first]);
  const failed = service.update({ type: 'create', name: 'renamed' });
  const recovered = service.update({ type: 'create', name: 'After failed mutation' });
  await assert.rejects(failed, /名称已存在/);
  await recovered;
  await service.flush();
  assert.equal((await create().list()).length, 13);
});

test('invalid requests and unknown sessions cannot change persisted groups', async (t) => {
  const { service, root, path, first, validated } = await fixture(t);
  const [one] = await service.update({ type: 'create', name: 'Group' });
  const [two] = await service.update({ type: 'create', name: 'Other' });
  const before = await readFile(path, 'utf8');
  const invalid = [
    null, [], {}, { type: 'unexpected' },
    { type: 'create', name: 42 }, { type: 'create', name: '  ' },
    { type: 'create', name: 'x'.repeat(81) }, { type: 'create', name: 'bad\nname' },
    { type: 'create', name: 'GROUP' },
    { type: 'rename', id: one.id, name: ' other ' },
    { type: 'rename', id: 'missing', name: 'Valid' },
    { type: 'delete', id: 'missing' }, { type: 'delete', id: {} },
    { type: 'move-session', sessionPath: first, groupId: 'missing' },
    { type: 'move-session', sessionPath: first },
    { type: 'move-session', sessionPath: {}, groupId: one.id },
    { type: 'move-session', sessionPath: 'bad\0path', groupId: one.id },
    { type: 'move-session', sessionPath: join(root, 'unknown.jsonl'), groupId: two.id },
    { type: 'move-session', sessionPath: join(root, 'unknown.jsonl'), groupId: null },
  ];
  for (const change of invalid) await assert.rejects(service.update(change));
  assert.equal(await readFile(path, 'utf8'), before);
  assert.deepEqual(validated, [join(root, 'unknown.jsonl'), join(root, 'unknown.jsonl')], 'malformed requests are rejected before session lookup');
  await service.update({ type: 'rename', id: one.id, name: '  Group  ' });
  assert.equal((await service.list()).find((group) => group.id === one.id).name, 'Group', 'renaming a group to its own name is valid');
});

test('corrupt group data is preserved before recovery and cannot create duplicate membership', async (t) => {
  const { service, root, path, first, backups } = await fixture(t);
  const invalid = JSON.stringify([
    { id: 'first', name: 'First', sessionPaths: [first] },
    { id: 'second', name: 'Second', sessionPaths: [first] },
  ]);
  await writeFile(path, invalid);
  const [firstRead, secondRead] = await Promise.all([service.list(), service.list()]);
  assert.deepEqual(firstRead, []);
  assert.deepEqual(secondRead, []);
  assert.equal(backups.length, 1, 'concurrent reads perform recovery only once');
  assert.equal(await readFile(backups[0], 'utf8'), invalid);
  await service.update({ type: 'create', name: 'Recovered' });
  assert.equal(await readFile(backups[0], 'utf8'), invalid);
  assert.ok((await readdir(root)).every((name) => !name.endsWith('.tmp')), 'atomic writes leave no temporary files');
});
