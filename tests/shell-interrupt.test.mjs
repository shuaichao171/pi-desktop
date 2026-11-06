// Interruptible shell tools: registry semantics, exec contract (exit codes,
// timeout, abort, user interrupt through the process-tree kill), and the
// bash/powershell overrides built from the real SDK definitions. The shell for
// the operations-level tests is `node -e` itself so the suite is identical on
// every platform; the integration tests exercise the real shell config.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	INTERRUPT_EXIT_CODE,
	ShellRunRegistry,
	createInterruptibleShellOperations,
	createInterruptibleShellTools,
	withShellRunTracking,
} from '../packages/agent/src/shellInterrupt.ts';

function nodeShell() {
	return { shell: process.execPath, args: ['-e'] };
}

function collect() {
	const chunks = [];
	return { chunks, text: () => Buffer.concat(chunks).toString('utf8'), onData: (chunk) => chunks.push(chunk) };
}

function gbkSupported() {
	try {
		new TextDecoder('gbk');
		return true;
	} catch {
		return false;
	}
}

/** Mirror the real tool wiring: execute → AsyncLocalStorage scope → operations.exec. */
function trackedExec(operations, registry, { sessionId = 'sess-1', toolCallId = 'call-1' } = {}) {
	assert.ok(registry, 'trackedExec keeps the registry reference for assertions');
	const definition = withShellRunTracking({
		name: 'test-shell',
		execute: (_toolCallId, params) => operations.exec(params.command, process.cwd(), params.options),
	});
	const ctx = { sessionManager: { getSessionId: () => sessionId } };
	return (command, options = {}) => definition.execute(toolCallId, { command, options }, options.signal, undefined, ctx);
}

async function waitFor(predicate, { timeoutMs = 10000, what = 'condition' } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = predicate();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test('ShellRunRegistry isolates sessions and counts only live interrupts', () => {
	const registry = new ShellRunRegistry();
	const flags = {};
	const live = (sessionId, id, key) => ({ tool: 'bash', toolCallId: id, command: 'x', startedAt: 0, interrupt() { flags[key] = (flags[key] ?? 0) + 1; return true; } });
	const dead = { tool: 'bash', toolCallId: 'gone', command: 'x', startedAt: 0, interrupt: () => false };
	registry.register('s1', live('s1', 't1', 'a'));
	registry.register('s1', live('s1', 't2', 'b'));
	registry.register('s2', live('s2', 't1', 'c'));
	registry.register('s1', dead);
	assert.equal(registry.running('s1').length, 3);
	assert.equal(registry.interrupt('s1', 't1'), 1, 'kills exactly the matched live handle');
	assert.equal(flags.a, 1);
	assert.equal(flags.b, undefined, 'unmatched toolCallId untouched');
	assert.equal(registry.interrupt('s1', 'gone'), 0, 'already-ended handle is not counted');
	assert.equal(registry.interrupt('s2'), 1, 'all-session interrupt stays session-scoped');
	assert.equal(flags.c, 1);
	assert.equal(flags.b, undefined);
	assert.equal(registry.interrupt('missing'), 0);
	registry.unregister('s1', 't2');
	assert.equal(registry.running('s1').length, 2);
	registry.unregister('s1', 't1');
	registry.unregister('s1', 'gone');
	assert.deepEqual(registry.running('s1'), []);
	registry.unregister('s1', 't2'); // idempotent
});

test('interruptible exec resolves exit codes and streams output', async () => {
	const registry = new ShellRunRegistry();
	const operations = createInterruptibleShellOperations('bash', nodeShell, registry);
	const run = trackedExec(operations, registry);
	const out = collect();
	assert.deepEqual(await run("console.log('shell-ok')", { onData: out.onData }), { exitCode: 0 });
	assert.equal(out.text(), 'shell-ok\n');
	const failOut = collect();
	assert.deepEqual(await run('process.exit(7)', { onData: failOut.onData }), { exitCode: 7 });
	assert.deepEqual(registry.running('sess-1'), [], 'registry entries are cleaned up after exec');
});

test('exec outside a tool scope still runs but never registers', async () => {
	const registry = new ShellRunRegistry();
	const operations = createInterruptibleShellOperations('bash', nodeShell, registry);
	assert.deepEqual(await operations.exec("console.log('scopeless')", process.cwd(), { onData: () => {} }), { exitCode: 0 });
	assert.deepEqual(registry.running(''), []);
});

test('interrupting a running command resolves 130 with a marker and clears the registry', { timeout: 30000 }, async () => {
	const registry = new ShellRunRegistry();
	const operations = createInterruptibleShellOperations('bash', nodeShell, registry);
	const run = trackedExec(operations, registry, { toolCallId: 'call-long' });
	const out = collect();
	const pending = run("console.log('started'); setInterval(() => {}, 1000)", { onData: out.onData });
	const handles = await waitFor(() => (registry.running('sess-1').length ? registry.running('sess-1') : null), { what: 'registry entry' });
	assert.equal(handles[0].toolCallId, 'call-long');
	assert.equal(handles[0].tool, 'bash');
	assert.equal(handles[0].command.includes('setInterval'), true);
	await waitFor(() => (out.text().includes('started') ? true : null), { what: 'command output before interrupt' });
	assert.equal(registry.interrupt('sess-1', 'call-long'), 1);
	assert.deepEqual(await pending, { exitCode: INTERRUPT_EXIT_CODE });
	assert.equal(out.text().includes('[interrupted by user]'), true, 'marker injected into the output');
	assert.deepEqual(registry.running('sess-1'), []);
	assert.equal(registry.interrupt('sess-1'), 0, 'interrupting again after exit is a no-op');
});

test('exec applies the timeout by killing the tree and throwing timeout:N', { timeout: 30000 }, async () => {
	const registry = new ShellRunRegistry();
	const operations = createInterruptibleShellOperations('bash', nodeShell, registry);
	const run = trackedExec(operations, registry);
	const out = collect();
	await assert.rejects(run('setTimeout(() => {}, 60000)', { timeout: 1, onData: out.onData }), (error) => error.message === 'timeout:1');
	assert.deepEqual(registry.running('sess-1'), []);
});

test('exec honors an abort signal by killing the tree and throwing aborted', { timeout: 30000 }, async () => {
	const registry = new ShellRunRegistry();
	const operations = createInterruptibleShellOperations('bash', nodeShell, registry);
	const run = trackedExec(operations, registry);
	const controller = new AbortController();
	const out = collect();
	const pending = run("console.log('up'); setInterval(() => {}, 1000)", { signal: controller.signal, onData: out.onData });
	await waitFor(() => (out.text().includes('up') ? true : null), { what: 'command output before abort' });
	controller.abort();
	await assert.rejects(pending, (error) => error.message === 'aborted');
	assert.deepEqual(registry.running('sess-1'), []);
});

test('an already-aborted signal kills the freshly spawned command', { timeout: 30000 }, async () => {
	const registry = new ShellRunRegistry();
	const operations = createInterruptibleShellOperations('bash', nodeShell, registry);
	const run = trackedExec(operations, registry);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(run('setInterval(() => {}, 1000)', { signal: controller.signal, onData: () => {} }), (error) => error.message === 'aborted');
	assert.deepEqual(registry.running('sess-1'), []);
});

test('createInterruptibleShellTools overrides bash (plus powershell on Windows) with working exec', { timeout: 60000 }, async () => {
	const registry = new ShellRunRegistry();
	const settings = { getShellPath: () => undefined, getShellCommandPrefix: () => undefined };
	const tools = await createInterruptibleShellTools(process.cwd(), settings, registry);
	const names = tools.map((tool) => tool.name).sort();
	assert.ok(names.includes('bash'), 'bash override missing');
	if (process.platform === 'win32') assert.deepEqual(names, ['bash', 'powershell']);
	else assert.deepEqual(names, ['bash']);
	const bash = tools.find((tool) => tool.name === 'bash');
	const done = await bash.execute('call-bash-1', { command: 'echo integration-ok' }, undefined, undefined, undefined);
	const text = JSON.stringify(done);
	assert.ok(text.includes('integration-ok'));
	assert.equal(done.isError, undefined);
	// A long command is registered under the session from ctx and interruptible end-to-end.
	// The SDK bash execute reads session env via ctx.sessionManager (getSessionId + getSessionFile).
	const ctx = { sessionManager: { getSessionId: () => 'sess-int', getSessionFile: () => undefined } };
	const pending = bash.execute('call-long-2', { command: 'sleep 30' }, undefined, undefined, ctx);
	const handles = await waitFor(() => (registry.running('sess-int').length ? registry.running('sess-int') : null), { what: 'bash registry entry' });
	assert.equal(handles[0].toolCallId, 'call-long-2');
	assert.equal(registry.interrupt('sess-int'), 1);
	const interrupted = await pending;
	assert.equal(interrupted.isError, true, 'interrupted command reports an error result so the loop continues');
	assert.ok(JSON.stringify(interrupted).includes('[interrupted by user]'));
	assert.ok(JSON.stringify(interrupted).includes('130'));
	if (process.platform === 'win32') {
		const powershell = tools.find((tool) => tool.name === 'powershell');
		const psDone = await powershell.execute('call-ps-1', { command: 'Write-Output ps-ok' }, undefined, undefined, undefined);
		assert.ok(JSON.stringify(psDone).includes('ps-ok'));
	}
});

test('bash override still re-encodes GBK output through the real shell (Windows regression)', { timeout: 60000 }, async (t) => {
	if (process.platform !== 'win32') return t.skip('Windows-only');
	if (!gbkSupported()) return t.skip('full ICU unavailable');
	const registry = new ShellRunRegistry();
	const settings = { getShellPath: () => undefined, getShellCommandPrefix: () => undefined };
	const tools = await createInterruptibleShellTools(process.cwd(), settings, registry);
	const bash = tools.find((tool) => tool.name === 'bash');
	// printf with octal escapes emits the raw GBK bytes of “中文输出”.
	const command = "printf '\\326\\320\\316\\304\\312\\344\\263\\366\\n'";
	const result = await bash.execute('call-gbk', { command }, undefined, undefined, undefined);
	const text = JSON.stringify(result);
	assert.ok(text.includes('中文输出'), 'GBK bytes were not re-encoded to UTF-8');
});

test('shell command prefix from settings is prepended at execution time', { timeout: 30000 }, async () => {
	const registry = new ShellRunRegistry();
	const settings = {
		getShellPath: () => undefined,
		getShellCommandPrefix: () => 'DESK_TEST_MARKER_ENV=1',
	};
	const tools = await createInterruptibleShellTools(process.cwd(), settings, registry);
	const bash = tools.find((tool) => tool.name === 'bash');
	const result = await bash.execute('call-prefix', { command: 'echo "prefix=$DESK_TEST_MARKER_ENV"' }, undefined, undefined, undefined);
	const text = JSON.stringify(result);
	assert.ok(text.includes('prefix=1'), `prefix was not applied: ${text}`);
});
