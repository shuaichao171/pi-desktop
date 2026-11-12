import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// The main-process store only touches `app` in the lazy singleton factory; the
// class itself is pure file IO, so a stub electron module is enough here
// (branch-store / side-question-store pattern).
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === 'electron') return { url: `data:text/javascript,${encodeURIComponent('export const app = { getPath: () => { throw new Error("unused in tests"); } };')}`, shortCircuit: true };
		if (specifier.startsWith('./') && context.parentURL && new URL(context.parentURL).pathname.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
		return nextResolve(specifier, context);
	},
});

test('a damaged hidden-context.json is backed up before it is overwritten', async (t) => {
	const temp = mkdtempSync(join(tmpdir(), 'pi-hidden-store-'));
	t.after(async () => { rmSync(temp, { recursive: true, force: true }); });
	const { HiddenContextStore } = await import('../packages/desktop/src/main/hiddenContextStore.ts');
	const path = join(temp, 'hidden-context.json');
	writeFileSync(path, '{ not json', 'utf8');

	const store = new HiddenContextStore(path);
	assert.equal(store.get('C:\\sessions\\a.jsonl'), '', 'a corrupt record starts empty');
	const backups = readdirSync(temp).filter((name) => name.startsWith('hidden-context.json.corrupt-'));
	assert.equal(backups.length, 1, 'the unreadable bytes are preserved beside the recovered file');
	assert.equal(readFileSync(join(temp, backups[0]), 'utf8'), '{ not json');

	store.record('C:\\sessions\\a.jsonl', '始终用中文回复');
	assert.equal(store.get('C:\\sessions\\a.jsonl'), '始终用中文回复');
	assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 1, contexts: { 'C:\\sessions\\a.jsonl': '始终用中文回复' } }, 'the new record replaces the corrupt file, not the backup');
});

test('hidden instructions round-trip, clear per session, and an empty save forgets the key', async (t) => {
	const temp = mkdtempSync(join(tmpdir(), 'pi-hidden-store-'));
	t.after(async () => { rmSync(temp, { recursive: true, force: true }); });
	const { HiddenContextStore } = await import('../packages/desktop/src/main/hiddenContextStore.ts');
	const path = join(temp, 'hidden-context.json');
	const store = new HiddenContextStore(path);

	assert.equal(store.get('C:\\sessions\\a.jsonl'), '', 'a missing record reads as no instruction');
	store.record('C:\\sessions\\a.jsonl', 'first');
	store.record('C:\\sessions\\b.jsonl', 'second');
	assert.equal(readFileSync(path, 'utf8'), JSON.stringify({ version: 1, contexts: { 'C:\\sessions\\a.jsonl': 'first', 'C:\\sessions\\b.jsonl': 'second' } }), 'records persist as one versioned JSON file');

	store.record('C:\\sessions\\a.jsonl', '');
	const reloaded = new HiddenContextStore(path);
	assert.equal(reloaded.get('C:\\sessions\\a.jsonl'), '', 'an empty save drops the key entirely');
	assert.equal(reloaded.get('C:\\sessions\\b.jsonl'), 'second', 'other sessions survive');
	reloaded.record('C:\\sessions\\b.jsonl', '   \n\t  ');
	assert.equal(JSON.parse(readFileSync(path, 'utf8')).contexts['C:\\sessions\\b.jsonl'], undefined, 'blank-only text also clears (indicator and injector agree)');
	reloaded.clear('C:\\sessions\\b.jsonl');
	assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 1, contexts: {} }, 'session deletion forgets the conversation');
});

test('oversized instructions are clamped to the 8000-character cap', async (t) => {
	const temp = mkdtempSync(join(tmpdir(), 'pi-hidden-store-'));
	t.after(async () => { rmSync(temp, { recursive: true, force: true }); });
	const { HiddenContextStore } = await import('../packages/desktop/src/main/hiddenContextStore.ts');
	const { HIDDEN_CONTEXT_MAX_CHARS } = await import('../packages/shared/src/hiddenContext.ts');
	const path = join(temp, 'hidden-context.json');

	const store = new HiddenContextStore(path);
	// Defensive depth: the IPC boundary rejects oversize input; the store clamps
	// anything that still arrives (hand-edited file, older writer) so the file
	// itself can never grow past one bounded instruction per session.
	store.record('C:\\sessions\\a.jsonl', 'x'.repeat(HIDDEN_CONTEXT_MAX_CHARS + 500));
	assert.equal(store.get('C:\\sessions\\a.jsonl').length, HIDDEN_CONTEXT_MAX_CHARS, 'the store never persists beyond the cap');

	const oversized = 'y'.repeat(HIDDEN_CONTEXT_MAX_CHARS + 1);
	const { requireHiddenContextText } = await import('../packages/shared/src/hiddenContext.ts');
	assert.throws(() => requireHiddenContextText(oversized), new RegExp(`不能超过 ${HIDDEN_CONTEXT_MAX_CHARS} 字符`), 'the renderer boundary rejects instead of truncating');
	assert.throws(() => requireHiddenContextText(42), /隐藏指令内容无效/, 'non-string input is rejected');
	assert.equal(requireHiddenContextText('多行\n指令'), '多行\n指令', 'multi-line text passes through verbatim');
});
