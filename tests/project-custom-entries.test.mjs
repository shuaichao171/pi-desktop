import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectCustomEntryDisplayName as entryDisplayName, readProjectCustomEntries, saveProjectCustomEntries } from '../packages/ui/src/projectCustomEntries.ts';

test('project custom entries persist per workspace, normalize fields, and cap the list', () => {
  let stored;
  const storage = { getItem: () => stored, setItem: (key, value) => { stored = value; } };
  saveProjectCustomEntries({
    'd:\\proj-a': [
      { id: 'c1', kind: 'command', value: 'pnpm build' },
      { id: 'o1', kind: 'open', value: 'logs/app.log', target: 'file' },
      { id: 'bad', kind: 'wat', value: 'x' },
      { id: 'empty', kind: 'command', value: '   ' },
    ],
    'd:\\proj-b': [{ id: 'c2', kind: 'command', value: 'git status' }],
  }, storage);
  const read = readProjectCustomEntries(storage);
  assert.deepEqual(read['d:\\proj-a']?.map((entry) => entry.id), ['c1', 'o1'], 'invalid kinds and blank values are dropped');
  assert.equal(read['d:\\proj-b']?.length, 1);
  assert.equal(entryDisplayName(read['d:\\proj-a'][0]), 'pnpm build');
  assert.equal(entryDisplayName({ ...read['d:\\proj-a'][0], value: 'corepack pnpm install --frozen-lockfile --prefer-offline' }).endsWith('…'), true, 'long commands are truncated');
  assert.equal(entryDisplayName(read['d:\\proj-a'][1]), 'app.log', 'open entries show the basename');
  assert.equal(entryDisplayName({ ...read['d:\\proj-a'][1], label: '日志' }), '日志', 'a custom label wins');
});

test('renaming stores a custom label and clearing it falls back to the derived name', () => {
  const entry = { id: 'x', kind: 'open', value: 'D:\\proj\\logs\\run.log', target: 'file' };
  assert.equal(entryDisplayName(entry), 'run.log');
  assert.equal(entryDisplayName({ ...entry, label: '  ' }), 'run.log', 'blank labels fall back');
});
