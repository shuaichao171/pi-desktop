import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { OutputLineTranscoder, createWindowsBashToolOverride, transcodeLine, wrapOperationsWithTranscoding } from '../packages/agent/src/winShellEncoding.ts';

const UTF8_TEXT = '中文输出';
const GBK_BYTES = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xca, 0xe4, 0xb3, 0xf6]); // “中文输出” in GBK

function gbkSupported() {
	try {
		new TextDecoder('gbk');
		return true;
	} catch {
		return false;
	}
}

function collect() {
	const chunks = [];
	return { chunks, text: () => Buffer.concat(chunks).toString('utf8'), onData: (chunk) => chunks.push(chunk) };
}

test('transcodeLine passes ASCII and valid UTF-8 through untouched', () => {
	const ascii = Buffer.from('plain ascii line\n', 'utf8');
	assert.equal(transcodeLine(ascii), ascii); // ASCII fast path: same buffer
	const utf8 = Buffer.from(`${UTF8_TEXT}\n`, 'utf8');
	assert.deepEqual(transcodeLine(utf8), utf8); // valid UTF-8: identical bytes
});

test('transcodeLine re-encodes GBK bytes as UTF-8', t => {
	if (!gbkSupported()) return t.skip('full ICU unavailable');
	assert.equal(transcodeLine(GBK_BYTES).toString('utf8'), UTF8_TEXT);
	// The GBK decoder is non-fatal: undecodable trailing bytes become U+FFFD
	// instead of replacing the whole line (same as a real GBK console).
	assert.ok(transcodeLine(Buffer.from([0xd6, 0xd0, 0xff])).toString('utf8').startsWith('中'));
});

test('OutputLineTranscoder splits on newlines and decides per line', t => {
	if (!gbkSupported()) return t.skip('full ICU unavailable');
	const { chunks, text, onData } = collect();
	const transcoder = new OutputLineTranscoder(onData);
	// One UTF-8 line, then a GBK line split across pushes mid-sequence.
	transcoder.push(Buffer.from(`utf8 line: ${UTF8_TEXT}\n`, 'utf8'));
	transcoder.push(GBK_BYTES.subarray(0, 3));
	transcoder.push(Buffer.concat([GBK_BYTES.subarray(3), Buffer.from('\n')]));
	transcoder.finish();
	assert.equal(text(), `utf8 line: ${UTF8_TEXT}\n${UTF8_TEXT}\n`);
	assert.ok(chunks.length >= 2);
});

test('OutputLineTranscoder keeps a partial line pending until finish', t => {
	if (!gbkSupported()) return t.skip('full ICU unavailable');
	const { text, onData } = collect();
	const transcoder = new OutputLineTranscoder(onData);
	transcoder.push(GBK_BYTES);
	assert.equal(text(), '');
	transcoder.finish();
	assert.equal(text(), UTF8_TEXT);
	// Pushes after finish are ignored.
	transcoder.push(Buffer.from('late\n', 'utf8'));
	assert.equal(text(), UTF8_TEXT);
});

test('wrapOperationsWithTranscoding flushes trailing output before exec resolves', async t => {
	if (!gbkSupported()) return t.skip('full ICU unavailable');
	const { text, onData } = collect();
	let seenOnData;
	const local = {
		exec: async (_command, _cwd, options) => {
			seenOnData = options.onData;
			options.onData(GBK_BYTES.subarray(0, 4));
			options.onData(GBK_BYTES.subarray(4)); // no trailing newline
			return { exitCode: 0 };
		},
	};
	const result = await wrapOperationsWithTranscoding(local).exec('true', process.cwd(), { onData });
	assert.deepEqual(result, { exitCode: 0 });
	assert.equal(text(), UTF8_TEXT); // flushed in finally, before exec resolved
	assert.equal(typeof seenOnData, 'function');
});

test('bash tool override keeps name and transcodes real GBK shell output', async t => {
	if (process.platform !== 'win32' || !gbkSupported()) return t.skip('requires Windows with full ICU');
	const root = await mkdtemp(join(tmpdir(), 'pi-win-enc-'));
	t.after(() => import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })));
	const definition = await createWindowsBashToolOverride(root, { getShellPath: () => undefined, getShellCommandPrefix: () => undefined });
	assert.ok(definition);
	assert.equal(definition.name, 'bash');
	const command = `printf '${UTF8_TEXT}' | iconv -f UTF-8 -t GBK && echo`;
	const result = await definition.execute('call', { command }, undefined, undefined, undefined);
	const finalText = String(result.content?.[0]?.text ?? '');
	assert.ok(finalText.includes(UTF8_TEXT), `tool result missing transcoded text: ${JSON.stringify(finalText)}`);
});
