import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendQuote, findOccurrences, searchableMessageText, readingKey, readReading, recentReading, saveReading, READING_CAPACITY } from '../packages/ui/src/conversationState.ts';
import { currentTreeLeaf, flattenTree } from '../packages/ui/src/sessionTree.ts';
import { locateHistoryMessage } from '../packages/ui/src/conversationNavigation.ts';
import { useChatStore } from '../packages/ui/src/store.ts';

test('find counts every rendered occurrence without matching Markdown destinations', () => {
  const messages = [{ id: 'a', role: 'assistant', text: '**needle** then `needle` and [needle](https://needle.invalid)' }];
  const matches = findOccurrences(messages, 'needle');
  assert.equal(matches.length, 3);
  assert.deepEqual(matches.map(m => m.ordinal), [0, 1, 2]);
  assert.equal(findOccurrences([{ id: 'x', text: 'a.b A.B axb' }], 'a.b').length, 2);
  assert.deepEqual(findOccurrences([{ id: 'x', text: 'İ next NEXT' }], 'next').map(m => m.start), [2, 7]);
  const after = findOccurrences([{ id: 'old', text: 'needle' }, ...messages], 'needle');
  assert.equal(after[2].key, matches[1].key, 'prepending history preserves the current occurrence key');
});

test('find follows rendered GFM deletion, tables, task lists and automatic links', () => {
  const find = (text, query) => findOccurrences([{ id: 'gfm', role: 'assistant', text }], query);
  assert.equal(find('~~old~~ new', 'old').length, 1);
  assert.equal(find('~~old~~ new', '~~').length, 0);
  const table = '| Name | State |\n| --- | --- |\n| alpha | ready |';
  assert.equal(find(table, 'alpha').length, 1);
  assert.equal(find(table, '|').length, 0);
  assert.equal(find(table, '---').length, 0);
  assert.equal(find(table, 'alphaready').length, 0, 'adjacent cells are separate visible text');
  const tasks = '- [x] done\n- [ ] waiting';
  assert.equal(find(tasks, '[x]').length, 0);
  assert.equal(find(tasks, '[ ]').length, 0);
  assert.equal(find(tasks, 'done').length, 1);
  assert.equal(find(tasks, 'waiting').length, 1);
  const links = 'www.example.com https://example.org user@example.net [label](https://hidden.invalid)';
  for (const label of ['www.example.com', 'https://example.org', 'user@example.net']) assert.equal(find(links, label).length, 1);
  assert.equal(find(links, 'hidden.invalid').length, 0);
});

test('find uses rendered block boundaries while keeping inline and real multiline matches', () => {
  const codeThenParagraph = { id: 'code', role: 'assistant', text: '```\nfoo\n```\n\nbar' };
  assert.equal(searchableMessageText(codeThenParagraph), 'foo\nbar');
  assert.equal(findOccurrences([codeThenParagraph], 'foobar').length, 0);
  assert.equal(findOccurrences([codeThenParagraph], 'foo\nbar').length, 1);
  const list = { id: 'list', role: 'assistant', text: '- foo\n- bar' };
  assert.equal(searchableMessageText(list), '\nfoo\nbar\n');
  assert.equal(findOccurrences([list], 'foo\nbar').length, 1);
  assert.equal(findOccurrences([{ id: 'inline', role: 'assistant', text: '**foo**bar' }], 'foobar').length, 1);
});

test('reading cache separates projects, sessions, and branch tails and stays bounded', () => {
  const first = readingKey('cwd', 'session', 'branch-a');
  saveReading(first, { messageId: 'u1', offset: -24, followsBottom: false });
  assert.equal(readReading(first).offset, -24);
  assert.equal(readReading(readingKey('cwd', 'session', 'branch-b')), undefined);
  assert.equal(readReading(readingKey('other', 'session', 'branch-a')), undefined);
  assert.equal(recentReading('cwd', 'session').tailId, 'branch-a');
  assert.equal(recentReading('other', 'session'), undefined);
  for (let index = 0; index < READING_CAPACITY; index++) saveReading(`later-${index}`, { messageId: null, offset: 0, followsBottom: true });
  assert.equal(readReading(first), undefined);
});

test('quoting preserves draft, source, code whitespace, and an exactly removable block', () => {
  const quote = appendQuote('existing draft', 'line one\n  indented\n\nlast', 'Answer · a1');
  assert.ok(quote.text.startsWith('existing draft\n\n'));
  assert.ok(quote.block.includes('>   indented\n> \n> last'));
  assert.equal(quote.text.replace(quote.block, ''), 'existing draft\n\n');
});

test('tree collapse respects visibility and distinguishes the active leaf from its path', () => {
  const leaf = { id: 'n20', active: true, children: [] }; let root = leaf;
  for (let depth = 19; depth >= 0; depth--) root = { id: `n${depth}`, active: true, children: [root] };
  assert.equal(currentTreeLeaf([root]).id, 'n20');
  assert.equal(flattenTree([root], new Set()).length, 1);
  assert.equal(flattenTree([root]).at(-1).depth, 20);
  const partial = flattenTree([root], new Set(['n0', 'n1']));
  assert.deepEqual(partial.map(row => row.node.id), ['n0', 'n1', 'n2']);
  assert.equal(partial[2].parentId, 'n1');
});

test('history navigation loads until the exact older target and stops on exhaustion', async () => {
  useChatStore.setState(useChatStore.getInitialState(), true);
  let calls = 0;
  useChatStore.setState({ cwd: 'cwd', sessionPath: 'a', historyTotal: 3, messages: [{ id: 'latest', text: '' }], activities: [], loadOlderMessages: async () => {
    calls++; const id = calls === 1 ? 'middle' : 'oldest';
    useChatStore.setState(state => ({ messages: [{ id, text: '' }, ...state.messages] })); return true;
  } });
  assert.equal(await locateHistoryMessage('oldest', new AbortController().signal), 'oldest');
  assert.equal(calls, 2);
  assert.equal(await locateHistoryMessage('deleted', new AbortController().signal), null);
  assert.equal(calls, 2);
});

test('history navigation cancels late results after a branch or session change', async () => {
  useChatStore.setState(useChatStore.getInitialState(), true);
  let release;
  useChatStore.setState({ cwd: 'cwd', sessionPath: 'a', historyTotal: 5, messages: [], activities: [], loadOlderMessages: () => new Promise(resolve => { release = resolve; }) });
  const locating = locateHistoryMessage('target', new AbortController().signal);
  useChatStore.setState(state => ({ historyGeneration: state.historyGeneration + 1, messages: [{ id: 'target', text: 'other branch' }] }));
  release(true); assert.equal(await locating, null);
});

test('an aborted navigation waiting on an existing history request finishes without another load', async () => {
  useChatStore.setState(useChatStore.getInitialState(), true);
  let calls = 0; useChatStore.setState({ historyTotal: 10, loadingOlder: true, loadOlderMessages: async () => { calls++; return true; } });
  const controller = new AbortController(); const locating = locateHistoryMessage('old', controller.signal); controller.abort();
  assert.equal(await locating, null); assert.equal(calls, 0);
});
