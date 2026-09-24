import type { UiSlashCommand, UiSlashCommandRequest } from '@pidesktop/shared';

export const BUILTIN_SLASH_COMMANDS: readonly UiSlashCommand[] = [
	{ name: 'new', description: 'Start a new conversation', source: 'builtin', acceptsArguments: false, requiresIdle: true },
	{ name: 'compact', description: 'Compact the current conversation, optionally with summary instructions', source: 'builtin', acceptsArguments: true, requiresIdle: true },
	{ name: 'name', description: 'Rename the current conversation: /name <title>', source: 'builtin', acceptsArguments: true, requiresIdle: true },
	{ name: 'reload', description: 'Reload Pi extensions, skills and prompt templates', source: 'builtin', acceptsArguments: false, requiresIdle: true },
];

export function validateSlashCommandRequest(value: unknown): asserts value is UiSlashCommandRequest {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('指令参数无效');
	const request = value as Partial<UiSlashCommandRequest>;
	if (typeof request.cwd !== 'string' || !request.cwd || request.cwd.length > 32_768 || request.cwd.includes('\0')
		|| typeof request.sessionId !== 'string' || !request.sessionId || request.sessionId.length > 200
		|| typeof request.name !== 'string' || !validSlashCommandName(request.name)
		|| (request.args !== undefined && (typeof request.args !== 'string' || request.args.length > 200_000 || request.args.includes('\0')))
		|| (request.behavior !== undefined && request.behavior !== 'steer' && request.behavior !== 'followUp')
		|| (request.attachments !== undefined && !Array.isArray(request.attachments))) throw new Error('指令参数无效');
}

export function validSlashCommandName(name: string): boolean {
	return Boolean(name) && name.length <= 200 && !/[\s/\u0000-\u001f\u007f]/u.test(name);
}

/** Mirrors Pi 0.87 prompt argument syntax. Expand before framing attachments so
 * a template without $ARGUMENTS cannot discard the selected context. */
export function expandSlashPrompt(content: string, input: string): string {
	const args: string[] = [];
	let current = '';
	let quote: string | null = null;
	for (const char of input) {
		if (quote) {
			if (char === quote) quote = null;
			else current += char;
		} else if (char === '"' || char === "'") quote = char;
		else if (/\s/u.test(char)) { if (current) { args.push(current); current = ''; } }
		else current += char;
	}
	if (current) args.push(current);
	const all = args.join(' ');
	return content.replace(/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
		(_match, fallbackTarget: string | undefined, fallback: string, sliceStart: string | undefined, sliceLength: string | undefined, simple: string) => {
			if (fallbackTarget) return (fallbackTarget === '@' || fallbackTarget === 'ARGUMENTS' ? all : args[Number(fallbackTarget) - 1]) || fallback;
			if (sliceStart) {
				const start = Math.max(0, Number(sliceStart) - 1);
				return args.slice(start, sliceLength ? start + Number(sliceLength) : undefined).join(' ');
			}
			return simple === '@' || simple === 'ARGUMENTS' ? all : args[Number(simple) - 1] ?? '';
		});
}
