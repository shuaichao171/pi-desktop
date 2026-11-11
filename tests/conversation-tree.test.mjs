import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import {
	activeTreeLeafId,
	branchPathIds,
	buildConversationTreeIndex,
	flattenSessionTree,
	isOnBranchPath,
	selectedChildrenByFork,
	subtreeTipId,
	treeFromLinearMessages,
} from '../packages/shared/src/conversationTree.ts';
import { useChatStore } from '../packages/ui/src/store.ts';

const node = (id, kind, label, children = [], extra = {}) => ({ id, kind, label, childCount: children.length, children, active: false, ...extra });

/** root → u1 → a1(root fork variant) and u2(edit variant) → a2. */
function editBranchTree() {
	return [
		node('u1', 'user', 'original question', [
			node('a1', 'assistant', 'original answer', [], { active: false, timestamp: '2026-01-01T01:00:00Z' }),
		], { active: true, timestamp: '2026-01-01T00:00:00Z' }),
		node('u2', 'user', 'edited question', [
			node('r1', 'assistant', 'tool round', [
				node('a2', 'assistant', 'edited answer', [], { active: true, timestamp: '2026-01-02T02:00:00Z' }),
			], { active: true, timestamp: '2026-01-02T01:00:00Z' }),
		], { active: true, timestamp: '2026-01-02T00:00:00Z' }),
	];
}

test('a linear message list builds a single-path tree with no forks', () => {
	const tree = treeFromLinearMessages([
		{ id: 'u1', order: 0, role: 'user', text: 'first line\nsecond line' },
		{ id: 'a1', order: 1, role: 'assistant', text: 'answer' },
		{ id: 'u2', order: 2, role: 'user', text: 'follow up' },
	]);
	const index = buildConversationTreeIndex(tree);
	assert.deepEqual(flattenSessionTree(tree).map(({ node: item }) => item.id), ['u1', 'a1', 'u2']);
	assert.equal(index.leafId, 'u2');
	assert.equal(index.leafCount, 1);
	assert.equal(index.forks.length, 0);
	assert.equal(activeTreeLeafId(tree), 'u2');
	assert.equal(tree[0].label, 'first line');
});

test('edit variants become sibling branches below the shared fork point', () => {
	const tree = editBranchTree();
	const index = buildConversationTreeIndex(tree);
	assert.equal(index.leafId, 'a2');
	assert.equal(index.leafCount, 2);
	assert.equal(index.forks.length, 1, 'only the root forks');
	const fork = index.forks[0];
	assert.equal(fork.forkId, null, 'the two user messages are separate roots');
	assert.deepEqual(fork.alternatives.map((alternative) => alternative.id), ['u1', 'u2'], 'ordered by timestamp');
	assert.equal(fork.activeIndex, 1, 'the edited branch (u2) is active');
	assert.equal(fork.alternatives[0].active, false);
	// Alternative labels prefer the branch's first user message.
	assert.equal(fork.alternatives[0].label, 'original question');
	assert.equal(fork.alternatives[0].targetId, 'a1', 'switching views the original branch tip');
	assert.equal(fork.alternatives[1].targetId, 'a2');
});

test('forks below an entry produce a switcher anchored at that entry', () => {
	// a1 answered; the user edited the follow-up question u2 → sibling u3.
	const tree = [
		node('u1', 'user', 'q1', [
			node('a1', 'assistant', 'answer', [
				node('u2', 'user', 'old follow-up', [node('a2', 'assistant', 'old reply', [], { active: false, timestamp: '2026-01-02T01:00:00Z' })], { active: false, timestamp: '2026-01-02T00:00:00Z' }),
				node('u3', 'user', 'new follow-up', [node('a3', 'assistant', 'new reply', [], { active: true, timestamp: '2026-01-03T01:00:00Z' })], { active: true, timestamp: '2026-01-03T00:00:00Z' }),
			], { active: true }),
		], { active: true, timestamp: '2026-01-01T00:00:00Z' }),
	];
	const index = buildConversationTreeIndex(tree);
	assert.equal(index.leafId, 'a3');
	assert.equal(index.leafCount, 2);
	assert.equal(index.forks.length, 1);
	assert.equal(index.forks[0].forkId, 'a1', 'the fork point is the previous answer');
	assert.equal(index.byForkId.get('a1'), index.forks[0]);
	assert.deepEqual(index.forks[0].alternatives.map((alternative) => alternative.id), ['u2', 'u3']);
	assert.equal(index.forks[0].activeIndex, 1);
});

test('path helpers derive membership and the selectedChild projection', () => {
	const tree = editBranchTree();
	const index = buildConversationTreeIndex(tree);
	assert.deepEqual([...branchPathIds(index, 'a2')], ['u2', 'r1', 'a2']);
	assert.equal(isOnBranchPath(index, 'a2', 'u2'), true);
	assert.equal(isOnBranchPath(index, 'a2', 'u1'), false);
	assert.equal(isOnBranchPath(index, 'a2', 'missing'), false);
	const selected = selectedChildrenByFork(index, 'a2');
	assert.equal(selected.get(null), 'u2');
	// The abandoned branch selects its own root.
	assert.equal(selectedChildrenByFork(index, 'a1').get(null), 'u1');
});

test('subtree tips follow the most recently appended entry, not tree depth', () => {
	const head = node('u1', 'user', 'q', [
		node('a1', 'assistant', 'older answer', [], { timestamp: '2026-01-01T00:00:00Z' }),
		node('a2', 'assistant', 'newer answer', [], { timestamp: '2026-01-05T00:00:00Z' }),
	], { timestamp: '2026-01-01T00:00:00Z' });
	assert.equal(subtreeTipId(head), 'a2');
	// Timestamp ties fall back to pre-order (append order).
	const tie = node('u1', 'user', 'q', [
		node('a1', 'assistant', 'first', [], { timestamp: '' }),
		node('a2', 'assistant', 'second', [], { timestamp: '' }),
	]);
	assert.equal(subtreeTipId(tie), 'a2');
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

function bridgeWithTree(treeByLeaf, storedSelection = null) {
	const calls = { switch: [], selections: [] };
	let leaf = Object.keys(treeByLeaf)[0];
	const tree = () => treeByLeaf[leaf];
	return {
		calls,
		leafRef: { get current() { return leaf; }, set current(value) { leaf = value; } },
		bridge: {
			getSessionTree: async () => tree(),
			getSessionBranchSelection: async () => storedSelection,
			setSessionBranchSelection: async (path, leafId) => { calls.selections.push([path, leafId]); },
			switchSessionBranch: async (entryId) => { calls.switch.push(entryId); leaf = entryId; },
		},
	};
}

beforeEach(() => {
	useChatStore.setState(useChatStore.getInitialState(), true);
});

test('switchConversationBranch navigates and records the new visible leaf', async () => {
	const treeA = editBranchTree(); // active leaf: a2 (edited branch)
	const treeB = editBranchTree(); // rebuild and activate the original branch
	for (const { node: item } of flattenSessionTree(treeB)) item.active = item.id === 'u1' || item.id === 'a1';
	const host = bridgeWithTree({ a2: treeA, a1: treeB });
	host.bridge.switchSessionBranch = async (entryId) => { host.calls.switch.push(entryId); host.leafRef.current = entryId === 'a1' ? 'a1' : 'a2'; };
	useChatStore.setState({
		bridge: host.bridge, status: 'idle', cwd: 'C:\\w', sessionId: 's1',
		sessionPath: 'C:\\sessions\\one.jsonl', navigationPending: false, sessionLoading: false,
	});
	await useChatStore.getState().switchConversationBranch('a1');
	assert.deepEqual(host.calls.switch, ['a1']);
	assert.deepEqual(host.calls.selections, [['C:\\sessions\\one.jsonl', 'a1']], 'records the leaf actually viewed');
	assert.equal(useChatStore.getState().branchSwitchPending, false);
	assert.equal(activeTreeLeafId(useChatStore.getState().branchTree ?? []), 'a1');
});

test('syncBranchView restores a remembered sibling branch after a load', async () => {
	const natural = editBranchTree(); // active leaf a2
	const viewed = editBranchTree();
	for (const { node: item } of flattenSessionTree(viewed)) item.active = item.id === 'u1' || item.id === 'a1';
	const host = bridgeWithTree({ a2: natural }, 'a1');
	host.bridge.switchSessionBranch = async (entryId) => { host.calls.switch.push(entryId); host.leafRef.current = 'a1'; host.bridge.getSessionBranchSelection = async () => null; host.bridge.getSessionTree = async () => viewed; };
	useChatStore.setState({
		bridge: host.bridge, status: 'idle', cwd: 'C:\\w', sessionId: 's1',
		sessionPath: 'C:\\sessions\\two.jsonl', navigationPending: false, sessionLoading: false,
	});
	await useChatStore.getState().syncBranchView('C:\\sessions\\two.jsonl');
	assert.deepEqual(host.calls.switch, ['a1'], 'the stored sibling leaf is applied once per load');
	await useChatStore.getState().syncBranchView('C:\\sessions\\two.jsonl');
	assert.equal(host.calls.switch.length, 1, 'the second ready only keeps the record current');
});

test('syncBranchView keeps the natural branch when the record is only an ancestor', async () => {
	const tree = editBranchTree();
	const host = bridgeWithTree({ a2: tree }, 'u2'); // u2 lies on the active path
	useChatStore.setState({
		bridge: host.bridge, status: 'idle', cwd: 'C:\\w', sessionId: 's1',
		sessionPath: 'C:\\sessions\\three.jsonl', navigationPending: false, sessionLoading: false,
	});
	await useChatStore.getState().syncBranchView('C:\\sessions\\three.jsonl');
	assert.deepEqual(host.calls.switch, [], 'an ancestral record must not truncate the loaded view');
	assert.deepEqual(host.calls.selections, [['C:\\sessions\\three.jsonl', 'a2']], 'the record advances to the natural leaf');
});
