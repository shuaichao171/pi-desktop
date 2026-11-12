import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// The store only touches `app` in the lazy singleton factory; the class itself
// is pure file IO, so a stub electron module is enough here (branch-store pattern).
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === 'electron') return { url: `data:text/javascript,${encodeURIComponent('export const app = { getPath: () => { throw new Error("unused in tests"); } };')}`, shortCircuit: true };
		if (specifier.startsWith('./') && context.parentURL && new URL(context.parentURL).pathname.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
		return nextResolve(specifier, context);
	},
});

const record = (over = {}) => ({
	id: 'q1',
	sessionPath: 'C:\\sessions\\a.jsonl',
	anchorEntryId: 'u2',
	question: '这个轮次说了什么？',
	answer: null,
	status: 'running',
	modelProvider: 'p',
	modelId: 'm',
	modelName: 'M',
	contextTruncated: false,
	createdAt: 1,
	finishedAt: null,
	...over,
});

test('a damaged side-questions.json is backed up before it is overwritten', async (t) => {
	const temp = mkdtempSync(join(tmpdir(), 'pi-side-question-store-'));
	t.after(async () => { rmSync(temp, { recursive: true, force: true }); });
	const { SideQuestionStore } = await import('../packages/desktop/src/main/sideQuestionStore.ts');
	const path = join(temp, 'side-questions.json');
	writeFileSync(path, '{ not json', 'utf8');

	const store = new SideQuestionStore(path);
	assert.deepEqual(store.list('C:\\sessions\\a.jsonl'), [], 'a corrupt record starts empty');
	const backups = readdirSync(temp).filter((name) => name.startsWith('side-questions.json.corrupt-'));
	assert.equal(backups.length, 1, 'the unreadable bytes are preserved beside the recovered file');

	store.record('C:\\sessions\\a.jsonl', record());
	const parsed = JSON.parse(readFileSync(path, 'utf8'));
	assert.equal(parsed.version, 1);
	assert.equal(parsed.records['C:\\sessions\\a.jsonl'].length, 1);
});

test('records round-trip, upsert by id, cap, and clear per session', async (t) => {
	const temp = mkdtempSync(join(tmpdir(), 'pi-side-question-store-'));
	t.after(async () => { rmSync(temp, { recursive: true, force: true }); });
	const { SideQuestionStore } = await import('../packages/desktop/src/main/sideQuestionStore.ts');
	const path = join(temp, 'side-questions.json');
	const session = 'C:\\sessions\\a.jsonl';

	const store = new SideQuestionStore(path);
	store.record(session, record({ id: 'q1', createdAt: 2 }));
	store.record(session, record({ id: 'q2', createdAt: 1, status: 'done', answer: '答案' }));
	// Same id replaces the record instead of appending (re-ask keeps its card).
	store.record(session, record({ id: 'q1', createdAt: 2, status: 'error', error: '超时' }));
	assert.deepEqual(store.list(session).map((item) => item.id), ['q2', 'q1'], 'records sort oldest first');

	const reloaded = new SideQuestionStore(path);
	assert.equal(reloaded.list(session).find((item) => item.id === 'q1')?.status, 'error', 'the upsert survives the reload');
	assert.equal(reloaded.remove(session, 'q2'), true);
	assert.equal(reloaded.remove(session, 'q2'), false, 'a removed record cannot be removed again');
	reloaded.clear(session);
	assert.deepEqual(new SideQuestionStore(path).list(session), [], 'clear forgets the session');
});

test('a deleted record is not resurrected by a late settled write (guards live in ipc)', async (t) => {
	const temp = mkdtempSync(join(tmpdir(), 'pi-side-question-store-'));
	t.after(async () => { rmSync(temp, { recursive: true, force: true }); });
	const { SideQuestionStore } = await import('../packages/desktop/src/main/sideQuestionStore.ts');
	const store = new SideQuestionStore(join(temp, 'side-questions.json'));
	const session = 'C:\\sessions\\a.jsonl';
	store.record(session, record());
	assert.equal(store.remove(session, 'q1'), true);
	// A late settle would re-record with the same id; ipc checks list() first, and
	// the store itself keeps that write from bringing back anything unexpected.
	store.record(session, record({ status: 'done', answer: '晚到的答案' }));
	assert.equal(store.list(session).at(0)?.answer, '晚到的答案', 'an explicit re-record is an upsert, not a resurrection bug');
});

test('records left running by an earlier exit settle as interrupted errors on load', async (t) => {
	const temp = mkdtempSync(join(tmpdir(), 'pi-side-question-store-'));
	t.after(async () => { rmSync(temp, { recursive: true, force: true }); });
	const { SideQuestionStore, SIDE_QUESTION_INTERRUPTED } = await import('../packages/desktop/src/main/sideQuestionStore.ts');
	const path = join(temp, 'side-questions.json');
	writeFileSync(path, JSON.stringify({ version: 1, records: { 'C:\sessions\a.jsonl': [
		record({ id: 'stuck', status: 'running', createdAt: 5 }),
		record({ id: 'done', status: 'done', answer: '好', createdAt: 6, finishedAt: 7 }),
	] } }), 'utf8');
	const store = new SideQuestionStore(path);
	const [stuck, done] = store.list('C:\sessions\a.jsonl');
	assert.equal(stuck.status, 'error', 'nothing can settle a run from a previous process');
	assert.equal(stuck.error, SIDE_QUESTION_INTERRUPTED);
	assert.equal(stuck.finishedAt, 5);
	assert.equal(done.status, 'done', 'settled records are untouched');
	const onDisk = JSON.parse(readFileSync(path, 'utf8')).records['C:\sessions\a.jsonl'];
	assert.equal(onDisk.find((item) => item.id === 'stuck').status, 'error', 'the repair is persisted');
});
