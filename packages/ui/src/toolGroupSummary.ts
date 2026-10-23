import type { UiToolActivity } from '@pidesktop/shared';
import { translate, type Locale } from './i18n.ts';

/**
 * Semantic summary for a group of tool calls (ZCode exploreToolCall /
 * conversationAssistantWorkItems): "Read 3 files · 2 searches · Ran 1 command"
 * instead of "6 tools". Shell commands made only of read-only programs count
 * as reading or searching, so exploration looks like exploration.
 */

export type ToolActivityKind = 'read' | 'search' | 'edit' | 'run' | 'subagent' | 'other';

const READ_PROGRAMS = /^(?:cat|head|tail|less|more|type|get-content|gc|bat|nl|wc|stat|file|readlink|realpath|pwd|which|where|get-location|test-path|resolve-path)$/i;
const SEARCH_PROGRAMS = /^(?:rg|grep|egrep|fgrep|ag|ack|find|fd|ls|dir|tree|gci|get-childitem|select-string|sls|locate)$/i;
const READ_ONLY_GIT = /^git\s+(?:status|log|show|diff|blame|branch|ls-files|rev-parse|grep)\b/i;

/** Strips `bash -lc "…"` / `powershell -Command "…"` wrappers around the real command. */
function unwrapShell(command: string): string {
	const trimmed = command.trim();
	const unquote = (value: string) => {
		const inner = value.trim();
		return (inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'")) ? inner.slice(1, -1).trim() : inner;
	};
	const posix = /^(?:\/bin\/)?(?:zsh|bash|sh)\s+-l?c\s+([\s\S]+)$/i.exec(trimmed);
	if (posix?.[1]) return unquote(posix[1]);
	const powershell = /^(?:powershell|pwsh)(?:\.exe)?\b[\s\S]*?\s-(?:command|c)\s+([\s\S]+)$/i.exec(trimmed);
	if (powershell?.[1]) return unquote(powershell[1]);
	return trimmed;
}

/** read/search when every segment of the command line only reads; otherwise null (a real run). */
export function classifyShellCommand(command: string): 'read' | 'search' | null {
	const raw = unwrapShell(command);
	// Command substitution runs anything, even inside double quotes.
	if (!raw || /\$\(|`/.test(raw)) return null;
	// Quoted arguments (`rg "a|b"`, `grep 'x > y'`) are data, not operators.
	const unwrapped = raw.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
	// Redirections write files.
	if (/(?:^|[^<>&0-9])>{1,2}(?!&)/.test(unwrapped)) return null;
	const segments = unwrapped.split(/&&|\|\||;|\|/).map((segment) => segment.trim()).filter(Boolean);
	if (!segments.length) return null;
	let search = false;
	for (const segment of segments) {
		const words = segment.replace(/^(?:sudo\s+)?/i, '').split(/\s+/);
		const program = (words[0] ?? '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
		if (/^cd$|^set-location$/i.test(program)) continue;
		if (/^sed$/i.test(program) && words.includes('-n') && !words.some((word) => /^-i/.test(word))) continue;
		if (READ_ONLY_GIT.test(segment)) { search = true; continue; }
		if (SEARCH_PROGRAMS.test(program)) {
			// `find -delete` / `-exec` act on what they find.
			if (/^find$/i.test(program) && words.some((word) => /^-(?:delete|exec|execdir|ok)$/.test(word))) return null;
			search = true;
			continue;
		}
		if (READ_PROGRAMS.test(program)) continue;
		return null;
	}
	return search ? 'search' : 'read';
}

export function classifyToolActivity(activity: Pick<UiToolActivity, 'tool' | 'command'>): ToolActivityKind {
	const tool = activity.tool.toLowerCase();
	if (tool === 'read') return 'read';
	if (tool === 'grep' || tool === 'find' || tool === 'ls' || tool === 'glob') return 'search';
	if (tool === 'edit' || tool === 'write' || tool === 'multiedit') return 'edit';
	if (tool === 'bash') return activity.command ? classifyShellCommand(activity.command) ?? 'run' : 'run';
	if (tool === 'subagent') return 'subagent';
	return 'other';
}

export interface ToolGroupCounts { read: number; search: number; edit: number; run: number; subagent: number; other: number }

/** Reads and edits count distinct files when known; everything else counts calls. */
export function countToolGroup(activities: readonly Pick<UiToolActivity, 'tool' | 'command' | 'files'>[]): ToolGroupCounts {
	const counts: ToolGroupCounts = { read: 0, search: 0, edit: 0, run: 0, subagent: 0, other: 0 };
	const files = { read: new Set<string>(), edit: new Set<string>() };
	for (const activity of activities) {
		const kind = classifyToolActivity(activity);
		if ((kind === 'read' || kind === 'edit') && activity.files?.length) for (const file of activity.files) files[kind].add(file);
		else counts[kind] += 1;
	}
	counts.read += files.read.size;
	counts.edit += files.edit.size;
	return counts;
}

/** True when the whole group only looked around (nothing edited or executed). */
export function isExplorationGroup(counts: ToolGroupCounts): boolean {
	return counts.edit === 0 && counts.run === 0 && counts.other === 0 && counts.read + counts.search > 0;
}

export function toolGroupSummaryParts(counts: ToolGroupCounts, locale: Locale): string[] {
	const part = (count: number, one: string, many: string) => translate(count === 1 ? one : many, { count }, locale);
	const parts: string[] = [];
	if (counts.read) parts.push(part(counts.read, 'toolGroup.readOne', 'toolGroup.read'));
	if (counts.search) parts.push(part(counts.search, 'toolGroup.searchOne', 'toolGroup.search'));
	if (counts.edit) parts.push(part(counts.edit, 'toolGroup.editOne', 'toolGroup.edit'));
	if (counts.run) parts.push(part(counts.run, 'toolGroup.runOne', 'toolGroup.run'));
	if (counts.subagent) parts.push(part(counts.subagent, 'toolGroup.subagentOne', 'toolGroup.subagent'));
	if (counts.other) parts.push(part(counts.other, 'toolGroup.otherOne', 'toolGroup.other'));
	return parts;
}
