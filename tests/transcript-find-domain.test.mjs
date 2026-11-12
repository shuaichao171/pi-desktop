// G13 会话内查找（转录域扩展）：纯逻辑（匹配枚举=按转录顺序、工具标题、占位文本、循环切换/边界、空查询）+ UI 接线约定。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transcriptFindMatches, toolFindText, toolFindOccurrences, stepFindIndex, omittedFindText, OMITTED_FIND_TEXT_LIMIT } from '../packages/ui/src/transcriptFind.ts';
import { buildConversationTimeline } from '../packages/ui/src/conversationTimeline.ts';

const msg = (id, order, role, text, extra = {}) => ({ id, order, role, text, status: 'done', ...extra });

function fixtures() {
	const messages = [
		msg('u1', 0, 'user', 'find the needle in settings'),
		msg('notice', 1, 'system', 'needle in a notice', { systemKind: 'extension-notice' }),
		msg('a1', 2, 'assistant', 'looking at **needle** first'),
		msg('u2', 6, 'user', 'nothing here'),
	];
	const activities = [
		{ id: 't1', order: 3, tool: 'bash', title: 'bash(grep needle src)', status: 'done', command: 'grep needle src' },
		{ id: 't2', order: 4, tool: 'read', title: 'read', status: 'done', files: ['needle/notes.md', 'other.txt'] },
		{ id: 't3', order: 5, tool: 'subagent', title: 'subagent', status: 'done', subagent: { agent: 'reviewer', task: 'needle the plan' } },
	];
	return { messages, activities, timeline: buildConversationTimeline(messages, activities, []) };
}

test('tool find text joins the tool kind and title line without bridging phrases', () => {
	assert.equal(toolFindText({ id: 'x', order: 0, tool: 'bash', title: 'bash(pnpm test)', status: 'done', command: 'pnpm test' }), 'bash\npnpm test');
	assert.equal(toolFindText({ id: 'x', order: 0, tool: 'read', title: 'read(src/a.ts)', status: 'done' }), 'read\nsrc/a.ts');
	assert.equal(toolFindText({ id: 'x', order: 0, tool: 'read', title: 'read', status: 'done', files: ['a.ts', 'b.ts'] }), 'read\na.ts, b.ts');
	// The kind and the title are separate lines: a phrase cannot match across both.
	assert.equal(toolFindText({ id: 'x', order: 0, tool: 'read', title: 'read(src/a needle)', status: 'done' }).includes('read src'), false);
	const sub = toolFindText({ id: 'x', order: 0, tool: 'subagent', title: 'subagent', status: 'done', subagent: { agent: 'reviewer', task: 'check the plan' } });
	assert.equal(sub, 'subagent\nreviewer\ncheck the plan');
});

test('the find domain enumerates messages and tool titles in transcript order', () => {
	const { messages, activities, timeline } = fixtures();
	const matches = transcriptFindMatches(timeline, messages, activities, 'needle');
	// u1 message text, a1 markdown-normalized text, then the three tool title hits — the extension notice never matches.
	assert.deepEqual(matches.map((m) => m.kind), ['message', 'message', 'tool', 'tool', 'tool']);
	assert.deepEqual(matches.filter((m) => m.kind === 'message').map((m) => m.messageId), ['u1', 'a1']);
	const toolHits = matches.filter((m) => m.kind === 'tool');
	assert.deepEqual(toolHits.map((m) => m.activityId), ['t1', 't2', 't3']);
	// Tool hits address the owning turn, whose fold hides the title row.
	const turnIds = new Set(toolHits.map((m) => m.turnId));
	assert.equal(turnIds.size, 1);
	assert.ok(timeline.some((entry) => entry.kind === 'turn' && turnIds.has(entry.id)));
	assert.ok(toolHits.every((m) => m.key.startsWith(`tool:${m.activityId}:`)));
	// Every key is unique so stepping can address each occurrence.
	assert.equal(new Set(matches.map((m) => m.key)).size, matches.length);
});

test('find matches stay per-message: multiple hits in one message keep their ordinals, empty queries match nothing', () => {
	const messages = [msg('m1', 0, 'assistant', 'needle one and needle two')];
	const timeline = buildConversationTimeline(messages, [], []);
	const matches = transcriptFindMatches(timeline, messages, [], 'NeEdLe');
	assert.equal(matches.length, 2, 'case-insensitive substring matching');
	assert.deepEqual(matches.filter((m) => m.kind === 'message').map((m) => m.ordinal), [0, 1]);
	assert.deepEqual(transcriptFindMatches(timeline, messages, [], ''), []);
	assert.deepEqual(transcriptFindMatches(timeline, messages, [], '   '), []);
	assert.deepEqual(toolFindOccurrences({ id: 't', order: 0, tool: 'read', title: 'read(a)', status: 'done' }, '  ', 'turn'), []);
});

test('tool occurrences count every hit inside one activity title', () => {
	const activity = { id: 't9', order: 0, tool: 'bash', title: 'bash(echo needle && echo needle)', status: 'done', command: 'echo needle && echo needle' };
	const hits = toolFindOccurrences(activity, 'needle', 'turn:1');
	assert.equal(hits.length, 2);
	assert.deepEqual(hits.map((h) => h.ordinal), [0, 1]);
	assert.deepEqual(hits.map((h) => h.turnId), ['turn:1', 'turn:1']);
});

test('stepping wraps in both directions and clamps degenerate cases', () => {
	assert.equal(stepFindIndex(0, 5, 1), 1);
	assert.equal(stepFindIndex(4, 5, 1), 0, 'forward wraps to the first match');
	assert.equal(stepFindIndex(0, 5, -1), 4, 'backward wraps to the last match');
	assert.equal(stepFindIndex(2, 5, -1), 1);
	assert.equal(stepFindIndex(0, 1, 1), 0);
	assert.equal(stepFindIndex(0, 1, -1), 0, 'a single match steps onto itself');
	assert.equal(stepFindIndex(0, 0, 1), 0, 'no matches: no movement');
	assert.equal(stepFindIndex(9, 3, 1), 1, 'a stale index clamps to the first match, then steps');
	assert.equal(stepFindIndex(-4, 3, -1), 2);
});

test('omitted placeholder text joins the folded domain and caps for screen-reader brevity', () => {
	assert.equal(omittedFindText([]), null);
	assert.equal(omittedFindText(['', '   ', '\n']), null);
	assert.equal(omittedFindText(['bash\ngrep needle src', 'needle answer text']), 'bash\ngrep needle src\nneedle answer text');
	const long = 'x'.repeat(OMITTED_FIND_TEXT_LIMIT + 50);
	const capped = omittedFindText([long]);
	assert.equal(capped.length, OMITTED_FIND_TEXT_LIMIT + 1);
	assert.ok(capped.endsWith('…'));
	// The cap limits the DOM placeholder only; findability stays data-driven.
	const tail = 'needle-tail';
	const longMessage = [msg('m', 0, 'assistant', `${'x'.repeat(OMITTED_FIND_TEXT_LIMIT + 50)}${tail}`)];
	assert.equal(transcriptFindMatches(buildConversationTimeline(longMessage, [], []), longMessage, [], tail).length, 1, 'a hit past the placeholder cap still matches');
});

test('find wiring keeps folded turns findable: placeholders, turn rows and reset are wired (UI conventions)', () => {
	const chatView = readFileSync(new URL('../packages/ui/src/components/ChatView.tsx', import.meta.url), 'utf8');
	assert.ok(chatView.includes('transcriptFindMatches('), 'match enumeration feeds the find bar');
	assert.ok(chatView.includes('stepFindIndex('), 'stepping uses the wrap-around helper');
	assert.ok(chatView.includes('setFindFocusTick'), 'repeated Ctrl+F re-focuses the open bar');
	assert.ok(chatView.includes('entryContainsRow'), 'virtualized jumps resolve turn rows too');
	assert.ok(chatView.includes('activeFindTurnId'), 'tool-title hits own the current-match state');
	assert.ok(/useEffect\(\(\) => \{ setFindOpen\(false\); setFindQuery\(''\); setFindKey\(null\); \}, \[cwd, sessionId, sessionPath\]\)/.test(chatView), 'session switches clear find state');
	const turn = readFileSync(new URL('../packages/ui/src/components/ConversationTurn.tsx', import.meta.url), 'utf8');
	assert.ok(turn.includes('data-find-omitted'), 'folded turns render the sr-only omitted placeholder');
	assert.ok(turn.includes('omittedFindText('), 'placeholder text comes from the shared pure helper');
	assert.ok(turn.includes('toolFindText(tool)'), 'a tool-title hit expands the folded turn');
	assert.ok(turn.includes('data-turn-id={entry.id}'), 'turn sections expose a jumpable row id');
	const find = readFileSync(new URL('../packages/ui/src/components/TranscriptFind.tsx', import.meta.url), 'utf8');
	assert.ok(find.includes('focusRequest'), 'the bar re-focuses on rising focus requests');
	const css = readFileSync(new URL('../packages/ui/src/components/conversationTurn.css', import.meta.url), 'utf8');
	assert.ok(css.includes('.pd-find-omitted'), 'the placeholder is visually hidden');
	assert.ok(css.includes('.pd-conversation-turn.is-find-match'), 'turns with hits get a match outline');
});
