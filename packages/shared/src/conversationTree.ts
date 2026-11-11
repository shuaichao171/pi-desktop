import type { UiMessage, UiSessionTreeNode } from './index';

/**
 * Conversation-tree branch model (Claude-desktop style) projected onto Pi's
 * native session tree.
 *
 * A Pi session file is an append-only entry tree: every entry has an id and a
 * parentId, and the "leaf" pointer names the currently viewed path. Editing or
 * forking a message moves the leaf and lets the next append grow a sibling
 * branch, so alternatives below a fork point are child subtrees of one entry.
 *
 * This module is pure data logic shared by the renderer (inline ‹ k/n ›
 * switchers, header badge) and the tests; it never touches IO.
 */

/** One selectable sibling subtree directly below a fork point. */
export interface UiBranchAlternative {
	/** Head entry of the alternative (direct child of the fork point). */
	id: string;
	kind: UiSessionTreeNode['kind'];
	label: string;
	timestamp?: string;
	/** Entry to navigate to when choosing this alternative: the deepest entry of its subtree. */
	targetId: string;
	/** True when the visible branch descends from this alternative. */
	active: boolean;
}

/** A point on the visible path where sibling branches exist. */
export interface UiBranchFork {
	/** Fork-point entry id; null when the session itself has several roots. */
	forkId: string | null;
	alternatives: UiBranchAlternative[];
	/** Index of the active alternative in `alternatives`; -1 when none is active. */
	activeIndex: number;
}

export interface UiConversationTreeIndex {
	/** Forks on the visible path, in path order (root first). */
	forks: UiBranchFork[];
	/** Same forks keyed by fork-point entry id (null key = multiple roots). */
	byForkId: Map<string | null, UiBranchFork>;
	/** Leaf entry id of the visible branch; null for an empty session. */
	leafId: string | null;
	/** Parent id by entry id; null parent = root entry. */
	parentOf: Map<string, string | null>;
	/** Distinct root-to-leaf paths in the whole tree (1 when unbranched). */
	leafCount: number;
}

/** Pre-order flattening with parent links; the shape UiSessionTreeNode[] lacks. */
export function flattenSessionTree(nodes: readonly UiSessionTreeNode[], parentId: string | null = null, depth = 0): { node: UiSessionTreeNode; parentId: string | null; depth: number }[] {
	return nodes.flatMap((node) => [{ node, parentId, depth }, ...flattenSessionTree(node.children, node.id, depth + 1)]);
}

/** Leaf of the marked (active) path: the last active node in pre-order. */
export function activeTreeLeafId(nodes: readonly UiSessionTreeNode[]): string | null {
	let leaf: string | null = null;
	for (const { node } of flattenSessionTree(nodes)) if (node.active) leaf = node.id;
	return leaf;
}

/** Deepest (most recently appended) entry of a subtree, by timestamp then pre-order. */
export function subtreeTipId(node: UiSessionTreeNode): string {
	let tip = node.id;
	let tipAt = node.timestamp ?? '';
	for (const { node: descendant } of flattenSessionTree(node.children)) {
		const at = descendant.timestamp ?? '';
		if (at >= tipAt) { tip = descendant.id; tipAt = at; }
	}
	return tip;
}

/** First user-message descendant (or the head itself) — edit branches start with one. */
function describeAlternative(head: UiSessionTreeNode): { kind: UiSessionTreeNode['kind']; label: string } {
	for (const { node } of flattenSessionTree([head])) if (node.kind === 'user') return { kind: node.kind, label: node.label };
	return { kind: head.kind, label: head.label };
}

function orderedChildren(children: UiSessionTreeNode[]): UiSessionTreeNode[] {
	return children
		.map((child, index) => ({ child, index }))
		.sort((a, b) => (a.child.timestamp ?? '').localeCompare(b.child.timestamp ?? '') || a.index - b.index)
		.map(({ child }) => child);
}

/**
 * Index the fork points of the visible path. A fork point is an entry with more
 * than one child (plus the root itself when several roots exist); each child
 * subtree becomes one selectable alternative.
 */
export function buildConversationTreeIndex(nodes: readonly UiSessionTreeNode[]): UiConversationTreeIndex {
	const flat = flattenSessionTree(nodes);
	const parentOf = new Map(flat.map(({ node, parentId }) => [node.id, parentId]));
	const childrenOf = new Map<string | null, UiSessionTreeNode[]>();
	for (const { node, parentId } of flat) {
		const list = childrenOf.get(parentId) ?? [];
		list.push(node);
		childrenOf.set(parentId, list);
	}
	// Path membership from the active leaf upward; without active marks (a
	// single-path projection) fall back to the pre-order tail as the leaf.
	const leafId = activeTreeLeafId(nodes) ?? flat.at(-1)?.node.id ?? null;
	const path = new Set<string>();
	for (let id = leafId; id !== null && path.size <= flat.length; id = parentOf.get(id) ?? null) {
		if (path.has(id)) break;
		path.add(id);
	}
	const forks: UiBranchFork[] = [];
	const byForkId = new Map<string | null, UiBranchFork>();
	const addFork = (forkId: string | null, children: UiSessionTreeNode[]): void => {
		const alternatives = orderedChildren(children).map((child) => {
			const described = describeAlternative(child);
			return {
				id: child.id,
				kind: described.kind,
				label: described.label,
				...(child.timestamp ? { timestamp: child.timestamp } : {}),
				targetId: subtreeTipId(child),
				active: path.has(child.id),
			};
		});
		const fork: UiBranchFork = { forkId, alternatives, activeIndex: alternatives.findIndex((alternative) => alternative.active) };
		forks.push(fork);
		byForkId.set(forkId, fork);
	};
	// Path order (root → leaf) keeps switchers in reading order; the root fork
	// (several roots) sits above everything.
	if ((childrenOf.get(null)?.length ?? 0) > 1) addFork(null, childrenOf.get(null)!);
	const orderedPath = [...path].reverse();
	for (const entryId of orderedPath) {
		const children = childrenOf.get(entryId);
		if (!children || children.length < 2) continue;
		addFork(entryId, children);
	}
	// Ancestor-only leaf count: every node without children ends one distinct path.
	let leafCount = 0;
	if (flat.length) for (const { node } of flat) if (!node.children.length) leafCount += 1;
	return { forks, byForkId, leafId, parentOf, leafCount };
}

/** Entry ids on the path root → leafId (inclusive, reading order). Unknown leaf yields an empty set. */
export function branchPathIds(index: UiConversationTreeIndex, leafId: string | null): Set<string> {
	const path: string[] = [];
	const seen = new Set<string>();
	for (let id = leafId; id !== null && !seen.has(id) && (id === index.leafId || index.parentOf.has(id)); id = index.parentOf.get(id) ?? null) {
		seen.add(id);
		path.push(id);
	}
	return new Set(path.reverse());
}

/** True when candidate lies on the path root → leafId (i.e. leafId continues candidate's branch). */
export function isOnBranchPath(index: UiConversationTreeIndex, leafId: string | null, candidateId: string): boolean {
	return branchPathIds(index, leafId).has(candidateId);
}

/**
 * Claude-style selectedChild projection: which child each fork point on the
 * leaf's path selects. Persisting the leaf id is enough (the map is derived),
 * but this is the shape switchers render and the model is documented against it.
 */
export function selectedChildrenByFork(index: UiConversationTreeIndex, leafId: string | null): Map<string | null, string> {
	const path = branchPathIds(index, leafId);
	const selected = new Map<string | null, string>();
	for (const fork of index.forks) {
		if (fork.forkId !== null && !path.has(fork.forkId)) continue;
		const active = fork.alternatives.find((alternative) => path.has(alternative.id));
		if (active) selected.set(fork.forkId, active.id);
	}
	// Forks beyond the stored leaf (deeper on the active path) are irrelevant here.
	return selected;
}

/**
 * Build a single-path tree from a linear message list (keep-warm previews have
 * no tree yet). The result is a valid UiSessionTreeNode[] whose only branch is
 * the message order itself, so fork/switcher logic degrades to "no branches".
 */
export function treeFromLinearMessages(messages: readonly Pick<UiMessage, 'id' | 'order' | 'role' | 'text'>[]): UiSessionTreeNode[] {
	const sorted = [...messages].sort((a, b) => a.order - b.order);
	const kind = (role: UiMessage['role']): UiSessionTreeNode['kind'] => role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'other';
	let tree: UiSessionTreeNode[] = [];
	for (const message of sorted) {
		const node: UiSessionTreeNode = {
			id: message.id,
			kind: kind(message.role),
			label: message.text.split(/\r?\n/)[0]!.slice(0, 90),
			childCount: 0,
			children: [],
			active: true,
		};
		// Append as the only child of the previous tail (root for the first message).
		if (!tree.length) tree = [node];
		else {
			let tail = tree[0]!;
			while (tail.children.length) tail = tail.children[0]!;
			tail.children = [node];
			tail.childCount = 1;
		}
	}
	return tree;
}
