// 应用在会话运行中被关闭（正常退出、强杀、崩溃）后，下次启动自动继续这些会话：
// 主进程始终把「当前正在运行的会话」写盘，退出开始时冻结；主窗启动后取走一次并逐个发送续跑提示。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// Main-process modules import siblings without an extension (bundler style); resolve them to .ts.
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === './stateFiles' && context.parentURL?.includes('/desktop/src/main/')) return nextResolve('./stateFiles.ts', context);
		return nextResolve(specifier, context);
	},
});
const { InterruptedRunTracker, isRunningPhase } = await import('../packages/desktop/src/main/interruptedRuns.ts');
import { INTERRUPTED_RUN_RESUME_PROMPT, resumeInterruptedRuns } from '../packages/ui/src/interruptedRunResume.ts';

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), 'pi-interrupted-'));
	const sessions = ['a', 'b', 'c'].map((name) => { const path = join(dir, `${name}.jsonl`); writeFileSync(path, ''); return path; });
	return { file: join(dir, 'interrupted-runs.json'), sessions };
}

test('the record mirrors running conversations, so a hard kill leaves them behind', () => {
	const { file, sessions: [a, b] } = fixture();
	const tracker = new InterruptedRunTracker(file);
	tracker.update('main', { cwd: 'C:/p', path: a, running: true });
	tracker.update('pai:1', { cwd: 'C:/q', path: b, running: true });
	assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).runs.map((run) => run.path), [a, b]);
	tracker.update('main', { cwd: 'C:/p', path: a, running: false });
	assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).runs.map((run) => run.path), [b]);
	// A window closed on purpose stops counting.
	tracker.clearSource('pai:1');
	assert.equal(existsSync(file), false);
	// Simulated crash: a new process reads what the last one left.
	tracker.update('main', { cwd: 'C:/p', path: a, running: true });
	assert.deepEqual(new InterruptedRunTracker(file).take(), [{ cwd: 'C:/p', path: a }]);
});

test('shutdown freezes the record before disposal aborts the turns', () => {
	const { file, sessions: [a] } = fixture();
	const tracker = new InterruptedRunTracker(file);
	tracker.update('main', { cwd: 'C:/p', path: a, running: true });
	tracker.freeze();
	tracker.update('main', { cwd: 'C:/p', path: a, running: false });
	tracker.clearSource('main');
	const next = new InterruptedRunTracker(file);
	assert.deepEqual(next.take(), [{ cwd: 'C:/p', path: a }]);
	// Handed out once: a renderer reload does not restart the same turns again.
	assert.deepEqual(next.take(), []);
	assert.equal(existsSync(file), false);
});

test('untaken runs survive another crash and deleted sessions are skipped', () => {
	const { file, sessions: [a, b] } = fixture();
	writeFileSync(file, JSON.stringify({ version: 1, runs: [{ cwd: 'C:/p', path: a }, { cwd: 'C:/p', path: join(file, '..', 'gone.jsonl') }] }));
	const second = new InterruptedRunTracker(file);
	second.update('main', { cwd: 'C:/p', path: b, running: true });
	assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).runs.map((run) => run.path), [a, join(file, '..', 'gone.jsonl'), b]);
	assert.deepEqual(new InterruptedRunTracker(file).take().map((run) => run.path), [a, b]);
});

test('corrupt records are ignored instead of blocking startup', () => {
	const { file } = fixture();
	writeFileSync(file, '{not json');
	assert.deepEqual(new InterruptedRunTracker(file).take(), []);
});

test('turns waiting on an extension question count as running', () => {
	assert.equal(isRunningPhase('running'), true);
	assert.equal(isRunningPhase('waiting-input'), true);
	assert.equal(isRunningPhase('waiting-approval'), true);
	assert.equal(isRunningPhase('idle'), false);
	assert.equal(isRunningPhase('failed'), false);
});

test('each interrupted conversation receives the continue prompt and the start session ends focused', async () => {
	let current = { cwd: 'C:/p', path: 'start' };
	const log = [];
	const result = await resumeInterruptedRuns([
		{ cwd: 'C:/p', path: 'start' }, { cwd: 'C:/q', path: 'other' }, { cwd: 'C:/q', path: 'broken' },
	], {
		current: () => current,
		select: async (cwd, path) => { log.push(`select ${path}`); if (path === 'broken') return false; current = { cwd, path }; return true; },
		send: async (text) => { assert.equal(text, INTERRUPTED_RUN_RESUME_PROMPT); log.push(`send ${current.path}`); },
	});
	assert.deepEqual(log, ['select other', 'send other', 'select broken', 'select start', 'send start']);
	assert.deepEqual(result.resumed.map((run) => run.path), ['other', 'start']);
	assert.deepEqual(result.failed.map(({ run }) => run.path), ['broken']);
	assert.equal(current.path, 'start');
});

test('the window returns to its startup conversation when that one was not interrupted', async () => {
	let current = { cwd: 'C:/p', path: 'start' };
	await resumeInterruptedRuns([{ cwd: 'C:/q', path: 'other' }], {
		current: () => current,
		select: async (cwd, path) => { current = { cwd, path }; return true; },
		send: async () => {},
	});
	assert.equal(current.path, 'start');
	assert.equal(INTERRUPTED_RUN_RESUME_PROMPT, 'The app was quit while you were working. Please continue from where you left off.');
});

test('main process wires the tracker into every agent host and freezes on shutdown', () => {
	const ipc = readFileSync(new URL('../packages/desktop/src/main/ipc.ts', import.meta.url), 'utf8');
	assert.match(ipc, /trackRuntime\('main', event\.event\)/);
	assert.match(ipc, /trackRuntime\(paiRuntimeSource\(entry\), event\)/);
	assert.match(ipc, /disposingServices = true;\n\t\/\/[^\n]*\n\tinterruptedRuns\?\.freeze\(\);/);
	const panes = readFileSync(new URL('../packages/desktop/src/main/splitPanes.ts', import.meta.url), 'utf8');
	assert.match(panes, /trackRuntime\?\.\(`pane:\$\{entry\.paneId\}`, event\)/);
});
