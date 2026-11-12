import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('./') && context.parentURL && new URL(context.parentURL).pathname.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
		return nextResolve(specifier, context);
	},
});

test('the injected section wraps the instruction verbatim under a valid SDK section name', async () => {
	const { HIDDEN_CONTEXT_SECTION, hiddenContextSection } = await import('../packages/agent/src/hiddenContext.ts');
	// The SDK rejects section names outside /^[a-z][a-z0-9_-]*$/ (and "preamble"),
	// so the constant itself is pinned to that contract.
	assert.match(HIDDEN_CONTEXT_SECTION, /^[a-z][a-z0-9_-]*$/);
	assert.notEqual(HIDDEN_CONTEXT_SECTION, 'preamble');
	const text = '回答保持简洁。\nAlways cite file paths.';
	const section = hiddenContextSection(text);
	assert.ok(section.includes(text), 'the user instruction appears verbatim');
	assert.ok(section.includes('session instructions'), 'the framing tells the model what the block is');
});

test('readHiddenContext fails open on any unreadable or malformed store file', async (t) => {
	const { readHiddenContext } = await import('../packages/agent/src/hiddenContext.ts');
	const temp = mkdtempSync(join(tmpdir(), 'pi-hidden-read-'));
	t.after(async () => { rmSync(temp, { recursive: true, force: true }); });
	const path = join(temp, 'hidden-context.json');
	const read = (file) => readHiddenContext(file, 'C:\\sessions\\a.jsonl');

	assert.equal(read(join(temp, 'missing.json')), null, 'a missing file means no instruction');
	writeFileSync(path, '{ not json');
	assert.equal(read(path), null, 'corrupt bytes never block the prompt');
	writeFileSync(path, JSON.stringify({ version: 1, contexts: { 'C:\\sessions\\a.jsonl': '指令' } }));
	assert.equal(read(path), '指令', 'the current conversation\'s instruction is found');
	writeFileSync(path, JSON.stringify({ version: 1, contexts: { 'C:\\sessions\\a.jsonl': '' } }));
	assert.equal(read(path), null, 'an empty instruction is not injected');
	writeFileSync(path, JSON.stringify({ version: 1, contexts: { 'C:\\sessions\\other.jsonl': '指令' } }));
	assert.equal(read(path), null, 'instructions of other conversations never leak');
	writeFileSync(path, JSON.stringify({ version: 1, contexts: ['nope'] }));
	assert.equal(read(path), null, 'a malformed contexts map reads as none');
	assert.equal(readHiddenContext(path, ''), null, 'a session without a file is never injected');
});

test('the hidden extension injects its own system prompt section on before_agent_start', async (t) => {
	const { hiddenContextExtension, HIDDEN_CONTEXT_SECTION, hiddenContextSection } = await import('../packages/agent/src/hiddenContext.ts');
	const temp = mkdtempSync(join(tmpdir(), 'pi-hidden-ext-'));
	t.after(async () => { rmSync(temp, { recursive: true, force: true }); });
	const storePath = join(temp, 'hidden-context.json');
	writeFileSync(storePath, JSON.stringify({ version: 1, contexts: { 'C:\\sessions\\a.jsonl': '仅限本仓库' } }));

	const handlers = new Map();
	const pi = { on: (name, handler) => handlers.set(name, handler) };
	hiddenContextExtension(() => 'C:\\sessions\\a.jsonl', () => storePath)(pi);
	const beforeAgentStart = handlers.get('before_agent_start');
	assert.equal(typeof beforeAgentStart, 'function');

	const event = { systemPromptOptions: { sections: {} } };
	beforeAgentStart(event);
	assert.equal(event.systemPromptOptions.sections[HIDDEN_CONTEXT_SECTION], hiddenContextSection('仅限本仓库'), 'the section lands in the mutable prompt options');

	// A fresh session without a transcript file is never injected, even though the
	// store would have an instruction: without a session file there is no key.
	const fresh = hiddenContextExtension(() => undefined, () => storePath);
	const freshPi = { on: (name, handler) => handlers.set(`fresh:${name}`, handler) };
	fresh(freshPi);
	const freshEvent = { systemPromptOptions: { sections: {} } };
	handlers.get('fresh:before_agent_start')(freshEvent);
	assert.deepEqual(freshEvent.systemPromptOptions.sections, {}, 'a session without a file stays untouched');

	// No store path configured (tests, CLI host) means no injection at all.
	const unset = hiddenContextExtension(() => 'C:\\sessions\\a.jsonl', () => null);
	const unsetPi = { on: (name, handler) => handlers.set(`unset:${name}`, handler) };
	unset(unsetPi);
	const unsetEvent = { systemPromptOptions: { sections: {} } };
	handlers.get('unset:before_agent_start')(unsetEvent);
	assert.deepEqual(unsetEvent.systemPromptOptions.sections, {}, 'a missing store path disables the injector');
});
