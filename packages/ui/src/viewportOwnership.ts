/**
 * Ownership of the transcript viewport while a jump or restore moves it.
 *
 * A locate request (the transcript jumping to a message found elsewhere) and a
 * deferred reading-position restore both take the viewport over: until they
 * finish, the transcript must not save reading positions, follow the bottom or
 * page in older history, because its content is about to move under the reader.
 *
 * Ownership used to be a bare boolean cleared only on the completing path. A
 * locate interrupted by a session switch — the switch aborts the request, so its
 * completion never runs — left the flag true for the rest of that window's life:
 * scroll-follow froze, reading positions stopped being saved and scrolling up
 * stopped loading older history, silently and without a way back.
 *
 * Interruption (abort, session switch, unmount) now always releases the viewport,
 * and a completion can only release the operation it started: a stale
 * continuation cannot take the viewport away from a newer one.
 */
export type ViewportOwnership = {
	/** Whether an in-flight jump or restore still owns the viewport. */
	readonly restoring: boolean;
	/** Takes the viewport for one operation; the returned token identifies it. */
	own(): number;
	/** Releases the viewport when `token` still owns it; a stale token is ignored. */
	release(token: number): void;
	/** Interruption: nobody owns the viewport any more, whatever the reason. */
	interrupt(): void;
};

export function createViewportOwnership(): ViewportOwnership {
	let token = 0;
	let owner = 0;
	return {
		get restoring() { return owner !== 0; },
		own() { owner = ++token; return owner; },
		release(token: number) { if (owner === token) owner = 0; },
		interrupt() { owner = 0; },
	};
}
