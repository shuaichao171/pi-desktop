// 识别项目目录（主进程 / agent 侧）：消息里的路径解析成可作为项目的目录；会话转移时把记录复制到目标项目。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, parse } from 'node:path';
import { test } from 'node:test';
import { resolveProjectCandidate } from '../packages/desktop/src/main/projectCandidate.ts';

test('candidates resolve to the first existing folder outside the conversation storage', async () => {
	const root = mkdtempSync(join(tmpdir(), 'pi-project-candidate-'));
	try {
		const app = join(root, 'app'), storage = join(root, 'conversations'), temp = join(storage, 'chat-1');
		mkdirSync(app); mkdirSync(temp, { recursive: true });
		writeFileSync(join(app, 'main.ts'), '');
		assert.equal(await resolveProjectCandidate([join(root, 'missing'), app], [storage]), app);
		assert.equal(await resolveProjectCandidate([join(app, 'main.ts')], [storage]), app, 'a file resolves to its folder');
		assert.equal(await resolveProjectCandidate([temp, storage], [storage]), null, 'temporary conversation folders are never offered');
		assert.equal(await resolveProjectCandidate([parse(root).root], []), null, 'filesystem roots are never offered');
		assert.equal(await resolveProjectCandidate(['relative/path', 42, ''], []), null);
		assert.equal(await resolveProjectCandidate('not-an-array', []), null);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('relocating copies the whole transcript into the target project with the new cwd', async () => {
	const root = mkdtempSync(join(tmpdir(), 'pi-relocate-'));
	const workspace = join(root, 'temporary'), project = join(root, 'project'), other = join(root, 'other');
	mkdirSync(workspace); mkdirSync(project); mkdirSync(other);
	const environment = new Map(['PI_CODING_AGENT_DIR', 'PI_OFFLINE'].map((name) => [name, process.env[name]]));
	process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
	process.env.PI_OFFLINE = '1';
	let service;
	try {
		const { AgentService } = await import('../packages/agent/src/index.ts');
		service = new AgentService();
		await service.init({ cwd: workspace });
		const path = service.getSnapshot().sessionPath;
		await service.renameSession(path, 'Review the project');
		await assert.rejects(service.relocateSession(path, other, project), /不属于/);
		const moved = await service.relocateSession(path, workspace, project);
		assert.equal(basename(moved), basename(path), 'the file name and session id are kept');
		assert.notEqual(dirname(moved), dirname(path));
		assert.ok(existsSync(path), 'the source stays until the desktop deletes it');
		const [header, ...rest] = readFileSync(moved, 'utf8').trim().split('\n');
		const [sourceHeader, ...sourceRest] = readFileSync(path, 'utf8').trim().split('\n');
		assert.equal(JSON.parse(header).cwd, project);
		assert.equal(JSON.parse(header).id, JSON.parse(sourceHeader).id);
		assert.deepEqual(rest, sourceRest, 'history entries are copied unchanged');
		const listed = await service.listSessions(project);
		assert.ok(listed.some((session) => session.path === moved && session.name === 'Review the project'));
		await assert.rejects(service.relocateSession(path, workspace, project), /EEXIST|exist/i, 'an existing copy is never overwritten');
	} finally {
		await service?.dispose().catch(() => {});
		rmSync(root, { recursive: true, force: true });
		for (const [name, value] of environment) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});
