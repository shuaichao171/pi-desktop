import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { searchSessions, searchWorkspaceFiles } from '../packages/desktop/src/main/searchService.ts';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-search-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionsRoot = join(root, 'sessions');
  const first = join(root, 'project-one');
  const second = join(root, 'project-two');
  await Promise.all([sessionsRoot, first, second].map((path) => mkdir(path)));
  return { root, sessionsRoot, first, second };
}

function message(id, parentId, role, content) {
  return { type: 'message', id, parentId, timestamp: '2026-09-23T12:00:00.000Z', message: { role, content } };
}

async function session(sessionsRoot, cwd, id, entries, timestamp = '2026-09-23T12:00:00.000Z') {
  const directory = join(sessionsRoot, `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${id}.jsonl`);
  await writeFile(path, [{ type: 'session', version: 3, cwd, id, timestamp }, ...entries].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  return path;
}

test('session search spans registered workspaces, visible branches, literal terms and user/assistant bodies', async (t) => {
  const { sessionsRoot, first, second, root } = await fixture(t);
  const firstPath = await session(sessionsRoot, first, 'first', [
    message('question', null, 'user', '准备项目'),
    message('old-branch', 'question', 'assistant', [{ type: 'text', text: 'invisible discarded answer' }]),
    message('live-branch', 'question', 'assistant', [{ type: 'thinking', thinking: 'invisible private reasoning' }, { type: 'text', text: 'x'.repeat(350) + ' MAGIC C++ [a.*] important Answer' }]),
    { type: 'session_info', id: 'title', parentId: 'live-branch', name: 'Backend Notes' },
    message('tools', 'title', 'toolResult', [{ type: 'text', text: 'tool-secret-only' }]),
  ]);
  await session(sessionsRoot, second, 'second', [
    message('second-question', null, 'user', 'Second project magic document'),
    message('second-answer', 'second-question', 'assistant', [{ type: 'text', text: 'Another answer' }]),
  ]);
  const unregistered = join(root, 'not-registered');
  await session(sessionsRoot, unregistered, 'third', [message('third-question', null, 'user', 'magic hidden project')]);

  const across = await searchSessions(sessionsRoot, [first, second], 'MaGiC');
  assert.equal(across.truncated, false);
  assert.equal(across.sessions.length, 2);
  assert.deepEqual(new Set(across.sessions.map((item) => item.cwd)), new Set([first, second]));
  const answer = across.sessions.find((item) => item.path === firstPath);
  assert.equal(answer.messageId, 'live-branch');
  assert.match(answer.snippet, /^….*MAGIC/);
  assert.ok(answer.snippet.length <= 222);
  assert.equal((await searchSessions(sessionsRoot, [first, second], 'C++ [a.*] ANSWER')).sessions[0].messageId, 'live-branch');
  assert.equal((await searchSessions(sessionsRoot, [first, second], 'Backend Answer')).sessions[0].name, 'Backend Notes');
  assert.equal((await searchSessions(sessionsRoot, [first, second], 'invisible')).sessions.length, 0);
  assert.equal((await searchSessions(sessionsRoot, [first, second], 'tool-secret-only')).sessions.length, 0);
  assert.equal((await searchSessions(sessionsRoot, [first], 'Another')).sessions.length, 0);
  assert.equal((await searchSessions(sessionsRoot, [first], '')).sessions[0].firstMessage, '准备项目');
});

test('search uses the same entry ids and active branch as Pi without modifying persisted files', async (t) => {
  const { sessionsRoot, first } = await fixture(t);
  const path = await session(sessionsRoot, first, 'branch', [
    message('root', null, 'user', 'Start'),
    message('unused', 'root', 'assistant', [{ type: 'text', text: 'Discarded' }]),
    message('used', 'root', 'assistant', [{ type: 'text', text: 'Visible answer' }]),
  ]);
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const expected = SessionManager.open(path, undefined, first).getBranch().filter((entry) => entry.type === 'message').map((entry) => entry.id);
  const original = await readFile(path, 'utf8');
  const result = await searchSessions(sessionsRoot, [first], 'Visible');
  assert.ok(expected.includes(result.sessions[0].messageId));
  assert.equal(result.sessions[0].messageId, 'used');
  assert.equal(await readFile(path, 'utf8'), original);
});

test('attachments, auth-like files, nonregistered cwd and malformed records are not exposed', async (t) => {
  const { root, sessionsRoot, first } = await fixture(t);
  await session(sessionsRoot, first, 'attachments', [
    message('user', null, 'user', 'Visible prompt\n\n<!-- pi-desktop:attachments-v1 -->\n<attached-file name="secrets.txt" mime="text/plain" length="15">\nattachment-only\n</attached-file>\n'),
    message('assistant', 'user', 'assistant', [{ type: 'toolCall', id: 'secret', name: 'read', arguments: { query: 'private-tool-only' } }, { type: 'thinking', thinking: 'private-thought-only' }]),
  ]);
  const wrong = await session(sessionsRoot, first, 'wrong-owner', []);
  await writeFile(wrong, JSON.stringify({ type: 'session', id: 'wrong', version: 3, cwd: root }) + '\n' + JSON.stringify(message('wrong', null, 'user', 'wrong-owner-only')));
  await writeFile(join(sessionsRoot, 'auth.json'), JSON.stringify({ key: 'credential-only' }));
  for (const query of ['attachment-only', 'private-tool-only', 'private-thought-only', 'wrong-owner-only', 'credential-only']) {
    assert.equal((await searchSessions(sessionsRoot, [first], query)).sessions.length, 0, query);
  }
  const result = await searchSessions(sessionsRoot, [first], 'visible prompt');
  assert.equal(result.sessions[0].snippet, 'Visible prompt');
  assert.equal(result.sessions[0].firstMessage, 'Visible prompt');
  assert.equal(result.truncated, false, 'invalid files do not exhaust a search budget');
  assert.equal(result.skipped, 1, 'malformed/unreadable candidates have a distinct warning');
});

test('recent results are bounded, sorted by conversation activity and flagged when capped', async (t) => {
  const { sessionsRoot, first } = await fixture(t);
  for (let index = 0; index < 82; index += 1) {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
    await session(sessionsRoot, first, `recent-${index}`, [{ ...message(`m-${index}`, null, 'user', `Session ${index}`), timestamp }], timestamp);
  }
  const result = await searchSessions(sessionsRoot, [first], '');
  assert.equal(result.sessions.length, 80);
  assert.equal(result.truncated, true);
  assert.equal(result.sessions[0].id, 'recent-81');
  assert.equal(result.sessions[79].id, 'recent-2');
  const huge = await session(sessionsRoot, first, 'huge', []);
  await truncate(huge, 300 * 1024 * 1024);
  assert.equal((await searchSessions(sessionsRoot, [first], 'Session 81')).sessions[0].id, 'recent-81', 'an oversized recent session must not consume the complete scan budget');
  assert.equal((await searchSessions(sessionsRoot, [first], 'nonexistent')).truncated, true);
});

test('file search finds relative paths literally, excludes large directories and never reads file bodies', async (t) => {
  const { first } = await fixture(t);
  for (const path of ['src/widgets', 'node_modules/pkg', '.git/objects', '.venv', 'dist']) await mkdir(join(first, path), { recursive: true });
  await Promise.all([
    writeFile(join(first, 'src/widgets/Settings [draft].tsx'), 'secret-body-only'),
    writeFile(join(first, 'src/widgets/button.ts'), 'other'),
    writeFile(join(first, 'README.md'), 'docs'),
    ...['node_modules/pkg', '.git/objects', '.venv', 'dist'].map((dir) => writeFile(join(first, dir, 'Settings.ts'), 'ignored')),
  ]);
  const result = await searchWorkspaceFiles(first, 'SRC [draft]');
  assert.equal(result.truncated, false);
  assert.deepEqual(result.files.map((file) => file.path), ['src/widgets/Settings [draft].tsx']);
  assert.equal((await searchWorkspaceFiles(first, 'widgets\\Settings')).files.length, 1);
  assert.equal((await searchWorkspaceFiles(first, 'secret-body-only')).files.length, 0);
  assert.equal((await searchWorkspaceFiles(first, '../')).files.length, 0);
  assert.equal((await searchWorkspaceFiles(first, '')).files.length, 4);
  assert.ok(result.ignoredDirectories.includes('node_modules'));
  assert.ok(!result.ignoredDirectories.includes('dist'));
});

test('source folders named like build outputs remain searchable', async (t) => {
  const { first } = await fixture(t);
  const names = ['build', 'out', 'dist', 'release', 'vendor', 'target'];
  for (const name of names) {
    await mkdir(join(first, name));
    await writeFile(join(first, name, 'source.ts'), 'source');
  }
  const result = await searchWorkspaceFiles(first, 'source.ts');
  assert.deepEqual(new Set(result.files.map((entry) => entry.path)), new Set(names.map((name) => `${name}/source.ts`)));
  assert.equal(result.truncated, false);
});

test('file and session searches reject invalid query/path input and report missing roots', async (t) => {
  const { root, sessionsRoot, first } = await fixture(t);
  for (const query of [null, {}, 'x'.repeat(501), 'abc\0def']) {
    await assert.rejects(searchSessions(sessionsRoot, [first], query), /搜索/);
    await assert.rejects(searchWorkspaceFiles(first, query), /搜索/);
  }
  await assert.rejects(searchSessions(sessionsRoot, ['relative'], ''), /工作区/);
  await assert.rejects(searchWorkspaceFiles('', ''), /工作区/);
  await assert.rejects(searchWorkspaceFiles(join(root, 'missing'), ''), /ENOENT/);
  assert.deepEqual(await searchSessions(join(root, 'missing'), [first], ''), { sessions: [], truncated: false });
});

test('context search can include matching directories while default search remains files-only', async (t) => {
  const { first, second } = await fixture(t);
  await mkdir(join(first, '中文 文件夹/nested'), { recursive: true });
  await writeFile(join(first, '中文 文件夹/nested/entry.ts'), 'not read');
  await mkdir(join(first, 'node_modules/中文 文件夹'), { recursive: true });
  await writeFile(join(first, 'node_modules/中文 文件夹/ignored.ts'), 'ignored');
  await mkdir(join(first, '.git'));
  try { await symlink(second, join(first, '中文 外部链接'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error; }
  const normal = await searchWorkspaceFiles(first, '中文');
  assert.deepEqual(normal.files.map((entry) => [entry.kind, entry.path]), [['file', '中文 文件夹/nested/entry.ts']]);
  assert.deepEqual(await searchWorkspaceFiles(first, '中文', { includeDirectories: false }), normal);
  const context = await searchWorkspaceFiles(first, '中文', { includeDirectories: true });
  assert.deepEqual(new Set(context.files.map((entry) => `${entry.kind}:${entry.path}`)), new Set([
    'directory:中文 文件夹', 'directory:中文 文件夹/nested', 'file:中文 文件夹/nested/entry.ts',
  ]));
  assert.ok(context.files.filter((entry) => entry.kind === 'directory').every((entry) => entry.size === undefined));
  assert.equal((await searchWorkspaceFiles(first, 'node_modules', { includeDirectories: true })).files.length, 0);
  assert.equal((await searchWorkspaceFiles(first, '.git', { includeDirectories: true })).files.length, 0);
  for (const options of [null, [], true, 'true', { includeDirectories: 1 }, { includeDirectories: 'true' }, { unexpected: true }]) {
    await assert.rejects(searchWorkspaceFiles(first, '', options), /选项无效/);
  }
});

test('file search excludes symlink escapes and loops, and bounds large result sets', async (t) => {
  const { root, first, second, sessionsRoot } = await fixture(t);
  await writeFile(join(second, 'outside-only.txt'), 'private');
  try {
    await symlink(second, join(first, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(first, join(first, 'loop'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    t.diagnostic('Directory link assertions unavailable on this host');
  }
  assert.equal((await searchWorkspaceFiles(first, 'outside-only')).files.length, 0);
  const externalSessionDirectory = join(root, 'external-sessions');
  await mkdir(externalSessionDirectory);
  const linked = join(sessionsRoot, `--${resolve(first).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
  try { await symlink(externalSessionDirectory, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error; }
  await writeFile(join(externalSessionDirectory, 'private.jsonl'), JSON.stringify({ type: 'session', version: 3, id: 'private', cwd: first }) + '\n' + JSON.stringify(message('private', null, 'user', 'outside-session-only')));
  assert.equal((await searchSessions(sessionsRoot, [first], '')).sessions.length, 0);
  for (let index = 0; index < 81; index += 1) await writeFile(join(first, `${index}.txt`), '');
  const result = await searchWorkspaceFiles(first, '.txt');
  assert.equal(result.files.length, 80);
  assert.equal(result.truncated, true);
  assert.ok(result.files.every((file) => !file.path.startsWith('outside/') && !file.path.startsWith('loop/')));
});
