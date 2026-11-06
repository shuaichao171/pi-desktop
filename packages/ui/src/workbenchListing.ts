import type { AgentBridge, WorkspaceEntry } from '@pidesktop/shared';

/**
 * Workbench folders list page by page (audit P2): the first page (folders
 * first, by name) renders at once and the remaining pages stream in behind
 * it, instead of the old single response silently cut at 400 children.
 * Past this many rows the tree stops asking and says the folder is truncated;
 * the file search covers anything deeper.
 */
export const WORKBENCH_LISTING_CAP = 2000;
/** The single-response limit of bridges without paged listing. */
const LEGACY_LISTING_LIMIT = 400;

export function sortWorkspaceEntries(entries: Iterable<WorkspaceEntry>): WorkspaceEntry[] {
	return [...entries].sort((a, b) => Number(a.kind === 'file') - Number(b.kind === 'file') || a.name.localeCompare(b.name));
}

export interface DirectoryListingOptions {
	/** False once the request is superseded (navigation, refresh, unmount): stop without reporting. */
	isCurrent(): boolean;
	/** Every page reports the whole sorted list so far; `complete` is true on the last report. */
	onEntries(entries: WorkspaceEntry[], complete: boolean): void;
	cap?: number;
}

/** Resolves with whether the listing stopped at the cap; rejects with the first page error. */
export async function streamDirectoryListing(
	bridge: Pick<AgentBridge, 'listWorkspaceEntries' | 'listWorkspaceEntriesPage'>,
	directory: string,
	{ isCurrent, onEntries, cap = WORKBENCH_LISTING_CAP }: DirectoryListingOptions,
): Promise<{ truncated: boolean }> {
	if (!bridge.listWorkspaceEntriesPage) {
		const items = await bridge.listWorkspaceEntries(directory);
		if (isCurrent()) onEntries(sortWorkspaceEntries(items), true);
		return { truncated: items.length >= LEGACY_LISTING_LIMIT };
	}
	// Keyed by path: a folder edited between two pages may shift an entry
	// across the page boundary; it must not render twice.
	const byPath = new Map<string, WorkspaceEntry>();
	let offset = 0;
	for (;;) {
		const page = await bridge.listWorkspaceEntriesPage(directory, offset);
		if (!isCurrent()) return { truncated: false };
		for (const entry of page.entries) byPath.set(entry.path, entry);
		const truncated = page.nextOffset !== null && byPath.size >= cap;
		const complete = page.nextOffset === null || truncated || page.nextOffset <= offset;
		onEntries(sortWorkspaceEntries(byPath.values()), complete);
		if (complete) return { truncated };
		offset = page.nextOffset!;
	}
}
