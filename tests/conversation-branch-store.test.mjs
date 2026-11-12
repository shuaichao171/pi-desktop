import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// The main-process store only touches `app` in the lazy singleton factory; the
// class itself is pure file IO, so a stub electron module is enough here.
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === 'electron') return { url: `data:text/javascript,${encodeURIComponent('export const app = { getPath: () => { throw new Error("unused in tests"); } };')}`, shortCircuit: true };
		if (specifier.startsWith('./') && context.parentURL && new URL(context.parentURL).pathname.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
		return nextResolve(specifier, context);
	},
});

test('a damaged conversation-branches.json is backed up before it is overwritten', async (t) => {
	const temp = mkdtempSync(join(tmpdir(), 'pi-branch-store-'));
	t.after(async () => { rmSync(temp, { recursive: true, force: true }); });
	const { ConversationBranchStore } = await import('../packages/desktop/src/main/conversationBranchStore.ts');
	const path = join(temp, 'conversation-branches.json');
	writeFileSync(path, '{ not json', 'utf8');

	const store = new ConversationBranchStore(path);
	assert.equal(store.get('C:\\sessions\\a.jsonl'), null, 'a corrupt record starts empty');
	const backups = readdirSync(temp).filter((name) => name.startsWith('conversation-branches.json.corrupt-'));
	assert.equal(backups.length, 1, 'the unreadable bytes are preserved beside the recovered file');
	assert.equal(readFileSync(join(temp, backups[0]), 'utf8'), '{ not json');

	store.record('C:\\sessions\\a.jsonl', 'leaf-1');
	assert.equal(store.get('C:\\sessions\\a.jsonl'), 'leaf-1');
	assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 1, selections: { 'C:\\sessions\\a.jsonl': 'leaf-1' } }, 'the new record replaces the corrupt file, not the backup');
});

test('branch selections round-trip and clear per session', async (t) => {
	const temp = mkdtempSync(join(tmpdir(), 'pi-branch-store-'));
	t.after(async () => { rmSync(temp, { recursive: true, force: true }); });
	const { ConversationBranchStore } = await import('../packages/desktop/src/main/conversationBranchStore.ts');
	const path = join(temp, 'conversation-branches.json');

	const store = new ConversationBranchStore(path);
	store.record('C:\\sessions\\a.jsonl', 'leaf-a');
	store.record('C:\\sessions\\b.jsonl', 'leaf-b');
	store.clear('C:\\sessions\\a.jsonl');

	const reloaded = new ConversationBranchStore(path);
	assert.equal(reloaded.get('C:\\sessions\\a.jsonl'), null, 'clear forgets the session');
	assert.equal(reloaded.get('C:\\sessions\\b.jsonl'), 'leaf-b', 'other sessions survive the reload');
});
