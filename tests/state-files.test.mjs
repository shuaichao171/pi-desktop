import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { backupCorruptStateFile, CorruptStateFileError, readStateFile, writeStateFile } from '../packages/desktop/src/main/stateFiles.ts';

const isSettings = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
  && typeof value.cwd === 'string';

test('state files distinguish first launch from malformed saved data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-state-'));
  try {
    const path = join(dir, 'workspace.json');
    assert.deepEqual(readStateFile(path, () => ({}), isSettings), {});
    writeFileSync(path, '{"cwd":', 'utf8');
    assert.throws(() => readStateFile(path, () => ({}), isSettings), CorruptStateFileError);
    assert.equal(readFileSync(path, 'utf8'), '{"cwd":');
    writeFileSync(path, '{"cwd":42}', 'utf8');
    assert.throws(() => readStateFile(path, () => ({}), isSettings), /状态文件损坏/);
    assert.equal(readFileSync(path, 'utf8'), '{"cwd":42}');
    const backup = backupCorruptStateFile(path);
    assert.match(backup, /workspace\.json\.corrupt-.*\.bak$/);
    assert.equal(readFileSync(backup, 'utf8'), '{"cwd":42}');
    assert.deepEqual(readStateFile(path, () => ({}), isSettings), {});
    writeStateFile(path, { cwd: 'recovered' });
    assert.equal(readFileSync(backup, 'utf8'), '{"cwd":42}', 'creating defaults must not overwrite the backup');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('state writes replace a complete file and clean up failed temporary writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-state-'));
  try {
    const path = join(dir, 'workspace.json');
    writeStateFile(path, { cwd: 'first' });
    writeStateFile(path, { cwd: 'second' });
    assert.deepEqual(readStateFile(path, () => ({}), isSettings), { cwd: 'second' });
    assert.deepEqual(readdirSync(dir), ['workspace.json']);

    const destinationDirectory = join(dir, 'cannot-replace');
    mkdirSync(destinationDirectory);
    assert.throws(() => writeStateFile(destinationDirectory, { cwd: 'third' }));
    assert.deepEqual(readdirSync(dir).sort(), ['cannot-replace', 'workspace.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
