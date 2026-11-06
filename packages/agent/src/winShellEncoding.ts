/**
 * Windows console-encoding fallback for the bash tool.
 *
 * The pi SDK decodes every tool-output byte stream as UTF-8. On Chinese
 * Windows the console codepage is GBK (cp936), so native commands invoked
 * through bash (cmd.exe builtins, ping, ipconfig, python, MSVC, ...) emit
 * GBK bytes that decode into U+FFFD replacement characters and show up in
 * the conversation as `������` mojibake.
 *
 * This module installs a Windows-only `bash` tool override (via the SDK's
 * `customTools`, which replace same-name builtins) that keeps pi's standard
 * local shell execution but re-encodes each output *line*: lines that are
 * valid UTF-8 pass through untouched, invalid lines are decoded as GBK and
 * re-encoded as UTF-8. Line granularity is safe because neither UTF-8 nor
 * GBK multi-byte sequences ever contain the 0x0A byte, and it keeps mixed
 * output (UTF-8 from git + GBK from native tools) working.
 *
 * The SDK exports used here are resolved through a dynamic import so an
 * older custom Pi engine that lacks them simply keeps the built-in bash
 * tool instead of failing to load the whole agent host.
 */

import type { BashOperations } from '@earendil-works/pi-coding-agent';

/** Settings surface consumed from the session's SettingsManager. */
export interface ShellEncodingSettings {
	getShellPath(): string | undefined;
	getShellCommandPrefix(): string | undefined;
}

/** Whether this Node build can decode GBK (full ICU); memoized probe. */
export function hasGbkSupport(): boolean {
	if (gbkDecoder === undefined) {
		try {
			gbkDecoder = new TextDecoder('gbk');
		} catch {
			// Builds without full ICU have no GBK decoder; keep legacy behavior.
			gbkDecoder = null;
		}
	}
	return gbkDecoder !== null;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
let gbkDecoder: TextDecoder | null | undefined;

/** Upper bound for buffering a stream that has not emitted a newline yet. */
const MAX_PENDING_BYTES = 8 * 1024 * 1024;

function decodeGbk(data: Buffer): string | null {
	if (gbkDecoder === undefined) {
		try {
			gbkDecoder = new TextDecoder('gbk');
		} catch {
			// Builds without full ICU have no GBK decoder; keep legacy behavior.
			gbkDecoder = null;
		}
	}
	if (gbkDecoder === null) return null;
	return gbkDecoder.decode(data);
}

function isAscii(data: Buffer): boolean {
	for (let i = 0; i < data.length; i++) {
		if (data[i] >= 0x80) return false;
	}
	return true;
}

/** Re-encode one line-bounded slice: valid UTF-8 (or ASCII) passes through, GBK is transcoded. */
export function transcodeLine(data: Buffer): Buffer {
	if (data.length === 0 || isAscii(data)) return data;
	try {
		// Strict decode proves the bytes are well-formed UTF-8; re-encoding is
		// then an identity transform, so genuine UTF-8 output is untouched.
		return Buffer.from(strictUtf8.decode(data), 'utf8');
	} catch {
		const text = decodeGbk(data);
		return text === null ? data : Buffer.from(text, 'utf8');
	}
}

/**
 * Buffers raw output chunks until a newline (or an oversized line) is seen,
 * then re-encodes each complete line and forwards the result. Call `finish()`
 * after the process exits to flush the trailing partial line.
 */
export class OutputLineTranscoder {
	private pending: Buffer[] = [];
	private pendingBytes = 0;
	private finished = false;

	private readonly emit: (data: Buffer) => void;

	constructor(emit: (data: Buffer) => void) {
		this.emit = emit;
	}

	push(chunk: Buffer): void {
		if (this.finished || chunk.length === 0) return;
		if (chunk.indexOf(0x0a) === -1 && this.pendingBytes + chunk.length < MAX_PENDING_BYTES) {
			// Fast path: nothing to flush yet, avoid concatenating.
			this.pending.push(chunk);
			this.pendingBytes += chunk.length;
			return;
		}
		this.pending.push(chunk);
		this.pendingBytes += chunk.length;
		this.flushCompleteLines();
	}

	finish(): void {
		if (this.finished) return;
		this.finished = true;
		if (this.pending.length === 0) return;
		const buffered = this.concatPending();
		this.pending = [];
		this.pendingBytes = 0;
		if (buffered.length > 0) this.emit(transcodeLine(buffered));
	}

	private concatPending(): Buffer {
		return this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending);
	}

	private flushCompleteLines(): void {
		const buffered = this.concatPending();
		const lineEnd = buffered.lastIndexOf(0x0a);
		if (lineEnd === -1 && this.pendingBytes < MAX_PENDING_BYTES) return;
		if (lineEnd === -1) {
			// Oversized single line: decide on the whole buffer.
			this.pending = [];
			this.pendingBytes = 0;
			this.emit(transcodeLine(buffered));
			return;
		}
		const rest = buffered.subarray(lineEnd + 1);
		this.pending = rest.length > 0 ? [rest] : [];
		this.pendingBytes = rest.length;
		const complete = buffered.subarray(0, lineEnd + 1);
		if (complete.length > 0) this.emit(transcodeLine(complete));
	}
}

/** Wraps shell operations so every `onData` chunk goes through the line transcoder. */
export function wrapOperationsWithTranscoding(local: BashOperations): BashOperations {
	return {
		exec: async (command, cwd, options) => {
			const transcoder = new OutputLineTranscoder(options.onData);
			try {
				return await local.exec(command, cwd, { ...options, onData: (chunk) => transcoder.push(chunk) });
			} finally {
				transcoder.finish();
			}
		},
	};
}

