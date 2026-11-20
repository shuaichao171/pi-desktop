import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal fake child exposing the API BackgroundTaskManager uses. */
function fakeChild(pid = 4242) {
	const child = new EventEmitter();
	child.pid = pid;
	child.unref = () => {};
	return child;
}

async function makeManager(overrides = {}) {
	const { BackgroundTaskManager } = await import('../packages/agent/src/backgroundTasks.ts');
	return { BackgroundTaskManager, manager: new BackgroundTaskManager({ retryFirstMs: 10, retryMaxMs: 30, deliverBudgetMs: 1000, adoptPollMs: 20, ...overrides }) };
}

/** Hooks recorder: prompts/isIdle/notify calls are captured for assertions. */
function recorder({ idle = true, fail = false } = {}) {
	const calls = { prompts: [], notifies: [] };
	return {
		calls,
		hooks: {
			prompt: async (text) => { if (fail) throw new Error('model unavailable'); calls.prompts.push(text); },
			isIdle: () => idle,
			notify: (kind, text) => calls.notifies.push({ kind, text }),
		},
	};
}

test('background task lifecycle: start, settle, wake with output tail', async () => {
	const { manager, BackgroundTaskManager } = await makeManager();
	assert.ok(manager instanceof BackgroundTaskManager);
	const dir = mkdtempSync(join(tmpdir(), 'bgtask-'));
	const { calls, hooks } = recorder();
	manager.attach('session-a', hooks);

	const child = fakeChild();
	const record = manager.start({ sessionId: 'session-a', sessionDir: dir, cwd: dir, command: 'echo hello' }, () => ({ child, pid: child.pid }));
	assert.equal(record.status, 'running');
	assert.equal(record.taskId.startsWith('bg-'), true);
	// Registry persisted as running; log file lives beside it.
	const registry = JSON.parse(readFileSync(join(dir, '.pi-desktop-background-tasks', 'session-a.json'), 'utf8'));
	assert.equal(registry.some((item) => item.taskId === record.taskId && item.status === 'running'), true);

	// Simulate output then exit.
	writeFileSync(record.logFile, 'line1\nhello from script\n', 'utf8');
	child.emit('exit', 0);
	await sleep(50);

	assert.equal(calls.prompts.length, 1);
	const message = calls.prompts[0];
	assert.match(message, /\[后台任务结束\]/);
	assert.match(message, new RegExp(record.taskId));
	assert.match(message, /退出码 0/);
	assert.match(message, /hello from script/);
	assert.match(message, /完成/);
	assert.equal(manager.currentRecords('session-a')[0].delivered, true);
	// Delivered flag persisted.
	const settled = JSON.parse(readFileSync(join(dir, '.pi-desktop-background-tasks', 'session-a.json'), 'utf8'));
	assert.equal(settled.find((item) => item.taskId === record.taskId).delivered, true);
	manager.clear();
});

test('busy session defers delivery and retries until idle', async () => {
	const { manager } = await makeManager();
	const dir = mkdtempSync(join(tmpdir(), 'bgtask-'));
	let idle = false;
	const calls = { prompts: [], notifies: [] };
	manager.attach('session-b', {
		prompt: async (text) => { calls.prompts.push(text); idle = false; },
		isIdle: () => idle,
		notify: (kind, text) => calls.notifies.push({ kind, text }),
	});
	const child = fakeChild();
	const record = manager.start({ sessionId: 'session-b', sessionDir: dir, cwd: dir, command: 'long build' }, () => ({ child, pid: child.pid }));
	child.emit('exit', 1);
	await sleep(30);
	// Busy: nothing delivered yet, marked failed with exit code 1.
	assert.equal(calls.prompts.length, 0);
	idle = true;
	await sleep(80);
	assert.equal(calls.prompts.length, 1);
	assert.match(calls.prompts[0], /退出码 1/);
	assert.match(calls.prompts[0], /失败/);
	manager.clear();
});

test('wake chain guard stops runaway auto-continuation until user activity', async () => {
	const { manager, BackgroundTaskManager: M } = await makeManager();
	assert.equal(M.name, 'BackgroundTaskManager');
	const dir = mkdtempSync(join(tmpdir(), 'bgtask-'));
	const { calls, hooks } = recorder();
	manager.attach('session-c', hooks);
	const children = [];
	for (let index = 0; index < 8; index += 1) {
		const child = fakeChild();
		children.push(child);
		const record = manager.start({ sessionId: 'session-c', sessionDir: dir, cwd: dir, command: `job-${index}` }, () => ({ child, pid: child.pid }));
		// Deliver sequentially: chain grows one per completed task.
		child.emit('exit', 0);
		await sleep(30);
	}
	// MAX_AUTO_WAKE_CHAIN = 6: first six deliver, the last two park with a warning.
	assert.equal(calls.prompts.length, 6);
	assert.equal(calls.notifies.length >= 1, true);
	assert.match(calls.notifies[0].text, /上限/);
	// Real user activity resets the chain; both parked notifications go out in one wake.
	manager.noteUserActivity('session-c');
	await sleep(50);
	assert.equal(calls.prompts.length, 7);
	assert.match(calls.prompts[6], /job-6/);
	assert.match(calls.prompts[6], /job-7/);
	assert.equal(manager.currentRecords('session-c').every((item) => item.delivered), true);
	manager.clear();
});

test('adoption on session attach: re-arm live pid, settle dead pid, deliver parked', async () => {
	const { manager } = await makeManager({ deliverBudgetMs: 10000 }); // 补投延迟 1s，预算需大于它以避开定时器抖动
	const dir = mkdtempSync(join(tmpdir(), 'bgtask-'));
	const registryDir = join(dir, '.pi-desktop-background-tasks');
	mkdirSync(registryDir, { recursive: true });
	// Parked: finished while the session was away (undelivered); live: this very test process.
	writeFileSync(join(registryDir, 'session-d.json'), JSON.stringify([
		{ taskId: 'bg-parked', sessionId: 'session-d', command: 'parked job', cwd: dir, pid: 111, logFile: join(registryDir, 'bg-parked.log'), startedAt: Date.now() - 60000, endedAt: Date.now() - 1000, exitCode: 0, status: 'completed', delivered: false },
		{ taskId: 'bg-live', sessionId: 'session-d', command: 'live job', cwd: dir, pid: process.pid, logFile: join(registryDir, 'bg-live.log'), startedAt: Date.now() - 60000, status: 'running' },
	]), 'utf8');
	writeFileSync(join(registryDir, 'bg-live.log'), 'live output\n', 'utf8');

	const { calls, hooks } = recorder();
	manager.attach('session-d', hooks);
	manager.adopt('session-d', dir);
	await sleep(1200); // adopt 里的补投延迟为 1s，等它落地。

	// Parked notification delivered.
	assert.equal(calls.prompts.some((text) => text.includes('bg-parked')), true);
	// Live task adopted (still running, no prompt for it yet).
	assert.equal(calls.prompts.some((text) => text.includes('bg-live')), false);
	assert.equal(manager.currentRecords('session-d').find((item) => item.taskId === 'bg-live').status, 'running');
	manager.clear();
});

test('dead pid during adoption settles as completed with unknown exit code', async () => {
	const { manager } = await makeManager();
	const dir = mkdtempSync(join(tmpdir(), 'bgtask-'));
	const registryDir = join(dir, '.pi-desktop-background-tasks');
	mkdirSync(registryDir, { recursive: true });
	writeFileSync(join(registryDir, 'session-e.json'), JSON.stringify([
		{ taskId: 'bg-gone', sessionId: 'session-e', command: 'gone job', cwd: dir, pid: 999999, logFile: join(registryDir, 'bg-gone.log'), startedAt: Date.now() - 60000, status: 'running' },
	]), 'utf8');
	const { calls, hooks } = recorder();
	manager.attach('session-e', hooks);
	manager.adopt('session-e', dir);
	await sleep(60);
	const message = calls.prompts.find((text) => text.includes('bg-gone'));
	assert.ok(message, 'offline settle should deliver');
	assert.match(message, /退出码未知/);
	manager.clear();
});

test('registry persistence keeps concurrent running records and prunes history', async () => {
	const { manager } = await makeManager();
	const dir = mkdtempSync(join(tmpdir(), 'bgtask-'));
	const first = fakeChild();
	const second = fakeChild();
	const recordA = manager.start({ sessionId: 'session-f', sessionDir: dir, cwd: dir, command: 'a' }, () => ({ child: first, pid: first.pid }));
	manager.start({ sessionId: 'session-f', sessionDir: dir, cwd: dir, command: 'b' }, () => ({ child: second, pid: second.pid }));
	// Settle only the first: the second running record must survive in the registry.
	first.emit('exit', 0);
	await sleep(20);
	const registry = JSON.parse(readFileSync(join(dir, '.pi-desktop-background-tasks', 'session-f.json'), 'utf8'));
	assert.equal(registry.filter((item) => item.status === 'running').length, 1);
	assert.equal(registry.find((item) => item.taskId === recordA.taskId).status, 'completed');
	manager.clear();
});

test('real process end-to-end: spawn, log capture, stop kill', async () => {
	const { manager } = await makeManager({ adoptPollMs: 20 });
	const dir = mkdtempSync(join(tmpdir(), 'bgtask-'));
	const { calls, hooks } = recorder();
	manager.attach('session-g', hooks);
	const record = manager.start({ sessionId: 'session-g', sessionDir: dir, cwd: dir, command: 'node sleeper' }, (logFile) => {
		const fd = openSync(logFile, 'a');
		const child = spawn(process.execPath, ['-e', 'console.log("started"); setTimeout(() => { console.log("done"); }, 60000);'], { cwd: dir, detached: true, stdio: ['ignore', fd, fd] });
		closeSync(fd);
		child.unref();
		return { child, pid: child.pid };
	});
	assert.ok(record.pid > 0, 'spawned child has a pid');
	await sleep(400);
	assert.ok(existsSync(record.logFile), 'log file captured child stdout');
	assert.match(readFileSync(record.logFile, 'utf8'), /started/);
	assert.equal(manager.currentRecords('session-g')[0].status, 'running');
	// Kill via manager.stop: exit event settles the record as failed (non-zero/signal exit).
	assert.equal(manager.stop(record.taskId), true);
	await sleep(600);
	const settledRecord = manager.currentRecords('session-g')[0];
	assert.equal(settledRecord.status === 'failed' || settledRecord.status === 'completed', true);
	assert.equal(settledRecord.status, 'failed');
	assert.equal(calls.prompts.length, 1);
	manager.clear();
});

test('exhausted delivery budget re-arms with a fresh budget on user activity', async () => {
	const { manager } = await makeManager({ retryFirstMs: 10, retryMaxMs: 10, deliverBudgetMs: 50 });
	const dir = mkdtempSync(join(tmpdir(), 'bgtask-'));
	let idle = false;
	const calls = { prompts: [], notifies: [] };
	manager.attach('session-h', { prompt: async (text) => { calls.prompts.push(text); }, isIdle: () => idle, notify: (kind, text) => calls.notifies.push({ kind, text }) });
	const child = fakeChild();
	manager.start({ sessionId: 'session-h', sessionDir: dir, cwd: dir, command: 'slow' }, () => ({ child, pid: child.pid }));
	child.emit('exit', 0);
	await sleep(150);
	// Budget exhausted while busy: parked with a warning.
	assert.equal(calls.prompts.length, 0);
	assert.equal(calls.notifies.some((item) => /长时间无法投递/.test(item.text)), true);
	idle = true;
	manager.noteUserActivity('session-h');
	await sleep(50);
	assert.equal(calls.prompts.length, 1);
	manager.clear();
});

test('task finished while session detached delivers on re-attach', async () => {
	const { manager } = await makeManager();
	const dir = mkdtempSync(join(tmpdir(), 'bgtask-'));
	const { calls, hooks } = recorder();
	manager.attach('session-i', hooks);
	const child = fakeChild();
	manager.start({ sessionId: 'session-i', sessionDir: dir, cwd: dir, command: 'x' }, () => ({ child, pid: child.pid }));
	manager.detach('session-i');
	child.emit('exit', 0);
	await sleep(50);
	assert.equal(calls.prompts.length, 0);
	manager.attach('session-i', hooks);
	manager.adopt('session-i', dir);
	await sleep(50);
	assert.equal(calls.prompts.length, 1);
	manager.clear();
});

test('failed prompts do not consume the wake chain; repeated failures park until user activity', async () => {
	const { manager } = await makeManager({ retryFirstMs: 5, retryMaxMs: 5 });
	const dir = mkdtempSync(join(tmpdir(), 'bgtask-'));
	let failures = 2;
	const calls = { prompts: [], notifies: [] };
	const hooks = {
		prompt: async (text) => { if (failures > 0) { failures -= 1; throw new Error('model unavailable'); } calls.prompts.push(text); },
		isIdle: () => true,
		notify: (kind, text) => calls.notifies.push({ kind, text }),
	};
	manager.attach('session-j', hooks);
	const first = fakeChild();
	manager.start({ sessionId: 'session-j', sessionDir: dir, cwd: dir, command: 'a' }, () => ({ child: first, pid: first.pid }));
	first.emit('exit', 0);
	await sleep(80);
	// Two transient failures then success: delivered once, chain counts only the real wake.
	assert.equal(calls.prompts.length, 1);
	assert.equal(manager.wakeChainCount('session-j'), 1);

	failures = Infinity;
	const second = fakeChild();
	manager.start({ sessionId: 'session-j', sessionDir: dir, cwd: dir, command: 'b' }, () => ({ child: second, pid: second.pid }));
	second.emit('exit', 0);
	await sleep(80);
	assert.equal(calls.prompts.length, 1);
	assert.equal(manager.wakeChainCount('session-j'), 1);
	assert.equal(calls.notifies.filter((item) => /连续失败/.test(item.text)).length, 1, 'parks once with a warning instead of retrying forever');
	failures = 0;
	manager.noteUserActivity('session-j');
	await sleep(50);
	assert.equal(calls.prompts.length, 2);
	manager.clear();
});

test('spawn without pid is rejected and never registered; pid <= 0 is never alive', async () => {
	const { manager } = await makeManager();
	const { isPidAlive } = await import('../packages/agent/src/backgroundTasks.ts');
	const dir = mkdtempSync(join(tmpdir(), 'bgtask-'));
	const child = fakeChild(undefined);
	assert.throws(() => manager.start({ sessionId: 'session-k', sessionDir: dir, cwd: dir, command: 'x' }, () => ({ child, pid: -1 })), /未获得进程 pid/);
	assert.equal(manager.runningCount('session-k'), 0);
	assert.equal(existsSync(join(dir, '.pi-desktop-background-tasks', 'session-k.json')), false);
	assert.equal(isPidAlive(-1), false);
	assert.equal(isPidAlive(0), false);
	assert.equal(isPidAlive(process.pid), true);
	manager.clear();
});

test('late spawn error settles the task as failed', async () => {
	const { manager } = await makeManager();
	const dir = mkdtempSync(join(tmpdir(), 'bgtask-'));
	const { calls, hooks } = recorder();
	manager.attach('session-l', hooks);
	const child = fakeChild();
	manager.start({ sessionId: 'session-l', sessionDir: dir, cwd: dir, command: 'x' }, () => ({ child, pid: child.pid }));
	child.emit('error', new Error('EACCES'));
	await sleep(30);
	assert.equal(manager.runningCount('session-l'), 0);
	assert.equal(manager.currentRecords('session-l')[0].status, 'failed');
	assert.equal(calls.prompts.length, 1);
	manager.clear();
});

test('signal exit reports the signal instead of an offline exit', async () => {
	const { manager } = await makeManager();
	const dir = mkdtempSync(join(tmpdir(), 'bgtask-'));
	const { calls, hooks } = recorder();
	manager.attach('session-m', hooks);
	const child = fakeChild();
	manager.start({ sessionId: 'session-m', sessionDir: dir, cwd: dir, command: 'x' }, () => ({ child, pid: child.pid }));
	child.emit('exit', null, 'SIGKILL');
	await sleep(30);
	assert.match(calls.prompts[0], /被信号 SIGKILL 终止/);
	assert.doesNotMatch(calls.prompts[0], /离线/);
	assert.equal(manager.currentRecords('session-m')[0].status, 'failed');
	manager.clear();
});

test('prune drops old delivered records together with their log files', async () => {
	const { manager } = await makeManager();
	const dir = mkdtempSync(join(tmpdir(), 'bgtask-'));
	const registryDir = join(dir, '.pi-desktop-background-tasks');
	mkdirSync(registryDir, { recursive: true });
	const oldLog = join(registryDir, 'bg-old.log');
	const freshLog = join(registryDir, 'bg-fresh.log');
	const outsideLog = join(dir, 'outside.log');
	for (const file of [oldLog, freshLog, outsideLog]) writeFileSync(file, 'x', 'utf8');
	const day = 24 * 60 * 60 * 1000;
	writeFileSync(join(registryDir, 'session-n.json'), JSON.stringify([
		{ taskId: 'bg-old', sessionId: 'session-n', command: 'old', cwd: dir, pid: 1, logFile: oldLog, startedAt: Date.now() - 3 * day, endedAt: Date.now() - 2 * day, exitCode: 0, status: 'completed', delivered: true },
		{ taskId: 'bg-outside', sessionId: 'session-n', command: 'old', cwd: dir, pid: 1, logFile: outsideLog, startedAt: Date.now() - 3 * day, endedAt: Date.now() - 2 * day, exitCode: 0, status: 'completed', delivered: true },
		{ taskId: 'bg-fresh', sessionId: 'session-n', command: 'fresh', cwd: dir, pid: 1, logFile: freshLog, startedAt: Date.now() - 2000, endedAt: Date.now() - 1000, exitCode: 0, status: 'completed', delivered: true },
	]), 'utf8');
	manager.prune('session-n', dir);
	const registry = JSON.parse(readFileSync(join(registryDir, 'session-n.json'), 'utf8'));
	assert.deepEqual(registry.map((item) => item.taskId), ['bg-fresh']);
	assert.equal(existsSync(oldLog), false);
	assert.equal(existsSync(freshLog), true);
	assert.equal(existsSync(outsideLog), true, 'logs outside the registry dir are never deleted');
	manager.clear();
});

test('run_in_background tool applies the shell command prefix and keeps the original command', async () => {
	const { manager } = await makeManager();
	const { createBackgroundTaskTool } = await import('../packages/agent/src/backgroundTasks.ts');
	const dir = mkdtempSync(join(tmpdir(), 'bgtask-'));
	const { calls, hooks } = recorder();
	manager.attach('session-o', hooks);
	// node -e evaluates the prefix line then the command, so the log proves both ran.
	const tool = createBackgroundTaskTool(manager, () => ({ shell: process.execPath, args: ['-e'] }), () => 'console.log("PREFIX-RAN")');
	const ctx = { cwd: dir, sessionManager: { getSessionId: () => 'session-o', getSessionDir: () => dir } };
	const result = await tool.execute('call-1', { command: 'console.log("COMMAND-RAN")', note: '前缀测试' }, undefined, undefined, ctx);
	assert.match(result.content[0].text, /taskId=bg-/);
	assert.match(result.content[0].text, process.platform === 'win32' ? /taskkill \/F \/T \/PID/ : /kill -- -\d+/);
	const deadline = Date.now() + 5000;
	while (!calls.prompts.length && Date.now() < deadline) await sleep(50);
	assert.equal(calls.prompts.length, 1);
	assert.match(calls.prompts[0], /PREFIX-RAN/);
	assert.match(calls.prompts[0], /COMMAND-RAN/);
	assert.match(calls.prompts[0], /命令: console\.log\("COMMAND-RAN"\)/);
	assert.match(calls.prompts[0], /说明: 前缀测试/);
	assert.equal(manager.currentRecords('session-o')[0].command, 'console.log("COMMAND-RAN")');
	manager.clear();
});

test('pure helpers: wake message shape, duration, tail reads', async () => {
	const { buildWakeMessage, formatDuration, readTail } = await import('../packages/agent/src/backgroundTasks.ts');
	assert.equal(formatDuration(0), '0s');
	assert.equal(formatDuration(59000), '59s');
	assert.equal(formatDuration(192000), '3m12s');
	const record = { taskId: 'bg-x1', sessionId: 's', command: 'cmd', cwd: '.', pid: 1, logFile: 'x.log', startedAt: 1000, endedAt: 62000, exitCode: 2, status: 'failed' };
	const message = buildWakeMessage(record, 'tail text');
	assert.match(message, /退出码 2/);
	assert.match(message, /失败/);
	assert.match(message, /tail text/);
	assert.match(buildWakeMessage({ ...record, exitCode: null }, 'x'), /退出码未知/);
	assert.doesNotMatch(buildWakeMessage({ ...record, exitCode: null }, 'x'), /离线/);
	assert.match(buildWakeMessage({ ...record, exitCode: null, exitedOffline: true }, 'x'), /宿主离线期间结束/);
	assert.match(buildWakeMessage({ ...record, exitCode: null, signal: 'SIGTERM' }, 'x'), /被信号 SIGTERM 终止/);
	const dir = mkdtempSync(join(tmpdir(), 'bgtail-'));
	const file = join(dir, 'log.txt');
	writeFileSync(file, 'x'.repeat(9000) + 'TAIL', 'utf8');
	assert.equal(readTail(file, 4).endsWith('TAIL'), true);
	assert.equal(readTail(join(dir, 'missing.log'), 10), '');
});

test('notification text: marked as automatic, not a user turn', async () => {
	const { buildNotificationMessage } = await import('../packages/agent/src/backgroundTasks.ts');
	const record = { taskId: 'bg-h1', sessionId: 's', command: 'cmd', cwd: '.', pid: 1, logFile: 'x.log', startedAt: 0, endedAt: 1000, exitCode: 0, status: 'completed' };
	for (const mode of ['wake', 'steer']) {
		const message = buildNotificationMessage([{ record, tail: 'ok' }], mode);
		assert.match(message.split('\n')[0], /自动发出的后台任务通知，不是用户发言/);
		assert.equal(message.match(/不是用户发言/g).length, 1);
	}
	const two = buildNotificationMessage([{ record, tail: 'a' }, { record: { ...record, taskId: 'bg-h2' }, tail: 'b' }], 'wake');
	assert.equal(two.match(/不是用户发言/g).length, 1, 'header appears once per merged notification');
});

test('output tail: progress redraws collapse, ANSI stripped, cut at line boundary', async () => {
	const { cleanOutputTail, readOutputTail } = await import('../packages/agent/src/backgroundTasks.ts');
	// \r 重绘只保留最后一帧；CRLF 不被当成重绘。
	assert.equal(cleanOutputTail('start\n 10%\r 50%\r100%\ndone\r\n', 1000), 'start\n100%\ndone');
	assert.equal(cleanOutputTail('\x1b[32mPASS\x1b[0m a.test\n\x1b]0;title\x07next', 1000), 'PASS a.test\nnext');
	// 超长时从下一行开头截，并标注省略。
	const lines = Array.from({ length: 50 }, (_, i) => `line-${String(i).padStart(2, '0')}`).join('\n');
	const cut = cleanOutputTail(lines, 30);
	assert.match(cut, /^…（前面的输出已省略）\n/);
	const body = cut.split('\n').slice(1);
	assert.ok(body.every((line) => /^line-\d\d$/.test(line)), `no partial lines: ${body.join('|')}`);
	assert.equal(body.at(-1), 'line-49');
	// 单行超长时退回字符截断。
	assert.equal(cleanOutputTail('y'.repeat(100), 10), `…（前面的输出已省略）\n${'y'.repeat(10)}`);
	// 不从文件开头读时丢掉第一行半行。
	assert.equal(cleanOutputTail('tial line\nfull line', 1000, false), '…（前面的输出已省略）\nfull line');

	const dir = mkdtempSync(join(tmpdir(), 'bgclean-'));
	const file = join(dir, 'log.txt');
	// 进度条刷屏远超尾部长度时，清理后仍能看到它前面的有用输出。
	const progress = Array.from({ length: 20000 }, (_, i) => `\r${i}`).join('');
	writeFileSync(file, `useful result\n${progress}\nexit ok\n`, 'utf8');
	assert.equal(readOutputTail(file, 4000), 'useful result\n19999\nexit ok');
	assert.equal(readOutputTail(join(dir, 'missing.log'), 10), '');
});

test('notification tail budget: shorter when steered, shared across a batch', async () => {
	const { notificationTailChars, WAKE_OUTPUT_TAIL_CHARS, STEER_OUTPUT_TAIL_CHARS, NOTIFICATION_TAIL_BUDGET_CHARS } = await import('../packages/agent/src/backgroundTasks.ts');
	assert.equal(notificationTailChars('wake', 1), WAKE_OUTPUT_TAIL_CHARS);
	assert.equal(notificationTailChars('steer', 1), STEER_OUTPUT_TAIL_CHARS);
	assert.ok(STEER_OUTPUT_TAIL_CHARS < WAKE_OUTPUT_TAIL_CHARS);
	for (const count of [2, 3, 5, 8]) {
		assert.ok(notificationTailChars('wake', count) * count <= NOTIFICATION_TAIL_BUDGET_CHARS, `wake x${count} within budget`);
		assert.ok(notificationTailChars('steer', count) * count <= NOTIFICATION_TAIL_BUDGET_CHARS, `steer x${count} within budget`);
	}
	assert.ok(notificationTailChars('wake', 100) >= 400, 'each task keeps a minimal tail');
});

test('task ending mid-run is steered into that run, with no wake after the reply', async () => {
	const { manager } = await makeManager();
	const dir = mkdtempSync(join(tmpdir(), 'bgtask-'));
	let running = true;
	const calls = { prompts: [], steers: [], notifies: [] };
	manager.attach('session-s', {
		prompt: async (text) => { calls.prompts.push(text); },
		steer: async (text) => { calls.steers.push(text); },
		isIdle: () => !running,
		isRunning: () => running,
		notify: (kind, text) => calls.notifies.push({ kind, text }),
	});
	const child = fakeChild();
	const record = manager.start({ sessionId: 'session-s', sessionDir: dir, cwd: dir, command: 'verify run' }, () => ({ child, pid: child.pid }));
	writeFileSync(record.logFile, 'verify ok\n', 'utf8');
	child.emit('exit', 0);
	await sleep(30);
	assert.equal(calls.steers.length, 1, 'delivered into the run in progress');
	assert.match(calls.steers[0], new RegExp(record.taskId));
	assert.match(calls.steers[0], /verify ok/);
	assert.match(calls.steers[0], /本轮进行中结束/);
	assert.equal(manager.currentRecords('session-s')[0].delivered, true);
	// The run ends: nothing left to wake for.
	running = false;
	await sleep(80);
	assert.equal(calls.prompts.length, 0);
	assert.equal(manager.wakeChainCount('session-s'), 0, 'steering does not consume the wake chain');
	manager.clear();
});

test('tasks settled while busy and not steerable go out together in one wake', async () => {
	const { manager } = await makeManager();
	const dir = mkdtempSync(join(tmpdir(), 'bgtask-'));
	let idle = false;
	const calls = { prompts: [], notifies: [] };
	// No steer hook (or a run that cannot take steering): wait for idle.
	manager.attach('session-m', {
		prompt: async (text) => { calls.prompts.push(text); },
		isIdle: () => idle,
		notify: (kind, text) => calls.notifies.push({ kind, text }),
	});
	const first = fakeChild(5001), second = fakeChild(5002);
	const a = manager.start({ sessionId: 'session-m', sessionDir: dir, cwd: dir, command: 'job-a' }, () => ({ child: first, pid: first.pid }));
	const b = manager.start({ sessionId: 'session-m', sessionDir: dir, cwd: dir, command: 'job-b' }, () => ({ child: second, pid: second.pid }));
	first.emit('exit', 0);
	await sleep(5);
	second.emit('exit', 1);
	await sleep(30);
	assert.equal(calls.prompts.length, 0);
	idle = true;
	await sleep(120);
	assert.equal(calls.prompts.length, 1, 'one wake for both tasks');
	assert.match(calls.prompts[0], new RegExp(a.taskId));
	assert.match(calls.prompts[0], new RegExp(b.taskId));
	assert.match(calls.prompts[0], /请基于以上结果继续/);
	assert.equal(manager.wakeChainCount('session-m'), 1);
	manager.clear();
});

test('concurrent deliveries in one session never send a task twice', async () => {
	const { manager } = await makeManager();
	const dir = mkdtempSync(join(tmpdir(), 'bgtask-'));
	const calls = { prompts: [] };
	manager.attach('session-r', {
		// Slow acknowledgement: the second task's timer fires while the first delivery is in flight.
		prompt: async (text) => { await sleep(40); calls.prompts.push(text); },
		isIdle: () => true,
		notify: () => {},
	});
	const first = fakeChild(6001), second = fakeChild(6002);
	const a = manager.start({ sessionId: 'session-r', sessionDir: dir, cwd: dir, command: 'job-a' }, () => ({ child: first, pid: first.pid }));
	const b = manager.start({ sessionId: 'session-r', sessionDir: dir, cwd: dir, command: 'job-b' }, () => ({ child: second, pid: second.pid }));
	first.emit('exit', 0);
	second.emit('exit', 0);
	await sleep(200);
	const all = calls.prompts.join('\n');
	assert.equal(all.split(`taskId=${a.taskId}`).length - 1, 1, 'first task delivered once');
	assert.equal(all.split(`taskId=${b.taskId}`).length - 1, 1, 'second task delivered once');
	assert.equal(manager.currentRecords('session-r').every((item) => item.delivered), true);
	manager.clear();
});
