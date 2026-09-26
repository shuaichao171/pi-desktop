import type { UiSessionTreeNode } from '@pidesktop/shared';
export interface TreeEntry { node: UiSessionTreeNode; depth: number; parentId: string | null; position: number; siblings: number }
export function flattenTree(nodes: UiSessionTreeNode[], expanded?: ReadonlySet<string>, depth = 0, parentId: string | null = null): TreeEntry[] {
	return nodes.flatMap((node, index) => [{ node, depth, parentId, position: index + 1, siblings: nodes.length }, ...(!expanded || expanded.has(node.id) ? flattenTree(node.children, expanded, depth + 1, node.id) : [])]);
}
export function currentTreeLeaf(nodes: UiSessionTreeNode[]): UiSessionTreeNode | undefined { return flattenTree(nodes).find(({ node }) => node.active && !node.children.some((child) => child.active))?.node; }
