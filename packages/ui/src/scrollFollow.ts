/**
 * Bottom-following decision for transcript scroll events.
 *
 * Landing within the bottom threshold re-arms following; only an actual upward
 * scroll breaks it. Transient layout shifts — the composer resizing when a
 * message is sent, content settling between pins — can leave the offset
 * momentarily past the threshold without the view moving; recomputing follow
 * state from that snapshot permanently cancelled bottom-following, and the
 * transcript stopped tracking new replies after a send.
 */
export function resolveFollowsBottom(previous: boolean, nearBottom: boolean, scrollTop: number, lastScrollTop: number): boolean {
	if (nearBottom) return true;
	// A real upward scroll (wheel, keys, scrollbar drag) is the only way to
	// leave the bottom; sub-pixel jitter is ignored.
	if (scrollTop < lastScrollTop - .5) return false;
	return previous;
}
