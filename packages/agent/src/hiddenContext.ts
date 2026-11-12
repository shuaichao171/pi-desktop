import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

/**
 * 会话隐藏上下文注入（agent host 侧）。
 *
 * 桌面主进程持有 hidden-context.json（唯一写入方，见
 * desktop/src/main/hiddenContextStore.ts）；host 通过 fork 环境变量
 * PI_DESKTOP_HIDDEN_CONTEXT_FILE 拿到同一文件路径，在本进程内只读。
 * 每次运行开始（before_agent_start）按当前会话文件路径取值并写入
 * systemPromptOptions 的独立段落——SDK 会把它渲染进本次请求的系统提示词，
 * 并以结构化 system 段落增量记录到转录；指令文本从不追加到用户消息。
 * 只读失败一律按「无指令」处理（fail-open），绝不阻塞发送。
 */

/** System prompt section tag; must match /^[a-z][a-z0-9_-]*$/ and not be "preamble". */
export const HIDDEN_CONTEXT_SECTION = 'session_instructions';

/** Fork-time env pointing at the desktop-owned store file; absent in tests/CLI. */
export function hiddenContextStorePath(env: NodeJS.ProcessEnv = process.env): string | null {
	const path = env.PI_DESKTOP_HIDDEN_CONTEXT_FILE?.trim();
	return path ? path : null;
}

/**
 * Tolerant read of one conversation's instruction from the shared store file.
 * The host never writes (or backs up) this file; unreadable bytes mean "none".
 */
export function readHiddenContext(storePath: string, sessionPath: string, read = readFileSync): string | null {
	if (!storePath || !sessionPath) return null;
	let contents: string;
	try { contents = read(storePath, 'utf8'); }
	catch { return null; }
	let parsed: unknown;
	try { parsed = JSON.parse(contents); }
	catch { return null; }
	if (!parsed || typeof parsed !== 'object') return null;
	const contexts = (parsed as { contexts?: unknown }).contexts;
	if (!contexts || typeof contexts !== 'object' || Array.isArray(contexts)) return null;
	// The main-process writer keys records by normalizeSessionPath (= resolve());
	// look up the same normalized form so a differently spelled path still matches.
	const records = contexts as Record<string, unknown>;
	const text = Object.hasOwn(records, sessionPath) ? records[sessionPath] : records[resolve(sessionPath)];
	return typeof text === 'string' && text.trim() ? text : null;
}

/** Wraps the user's instruction in the framing the model reads it with. */
export function hiddenContextSection(text: string): string {
	return [
		'The user has attached private session instructions for this conversation.',
		'Follow them alongside the rest of this prompt.',
		'',
		text,
	].join('\n');
}

/**
 * Hidden pi-desktop extension: injects the current conversation's instruction
 * as its own system prompt section on every agent run.
 */
export function hiddenContextExtension(sessionFile: () => string | undefined, storePath: () => string | null = hiddenContextStorePath): ExtensionFactory {
	return (pi) => {
		pi.on('before_agent_start', (event) => {
			const file = storePath();
			const session = sessionFile();
			if (!file || !session) return;
			const text = readHiddenContext(file, session);
			if (!text) return;
			event.systemPromptOptions.sections[HIDDEN_CONTEXT_SECTION] = hiddenContextSection(text);
		});
	};
}
