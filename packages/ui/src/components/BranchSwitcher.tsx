import { memo } from 'react';
import type { UiBranchFork } from '@pidesktop/shared';
import { useT } from '../i18n';
import { Icon } from './Icons';
import './branchSwitcher.css';

/**
 * Claude-style inline branch switcher: turns whose fork point has sibling
 * branches show ‹ k/n ›; stepping re-plays the chosen branch's message path.
 * Buttons stay individually focusable and the group also answers Arrow keys.
 */
export const BranchSwitcher = memo(function BranchSwitcher({ fork, disabled, onSwitch }: { fork: UiBranchFork; disabled?: boolean; onSwitch(targetId: string): void }) {
	const { t } = useT();
	const total = fork.alternatives.length;
	const activeIndex = fork.activeIndex < 0 || fork.activeIndex >= total ? -1 : fork.activeIndex;
	// No alternative below this fork is active (e.g. the docked leaf itself grew
	// the sibling subtrees): ‹ k/n › has no branch to report, so hide the group
	// instead of rendering a dead "‹ 0/n ›".
	if (activeIndex < 0 || total < 2) return null;
	const blocked = disabled;
	const step = (delta: number) => {
		if (blocked) return;
		const alternative = fork.alternatives[(activeIndex + delta + total) % total];
		if (alternative) onSwitch(alternative.targetId);
	};
	const active = fork.alternatives[activeIndex];
	return (
		<div
			className={`pd-branch-switcher${blocked ? ' is-disabled' : ''}`}
			data-fork-id={fork.forkId ?? undefined}
			role="group"
			aria-label={t('chat.branch.switcherLabel', { position: String(activeIndex + 1), total: String(total) })}
			onKeyDown={(event) => {
				if (event.nativeEvent.isComposing) return;
				if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); }
				else if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
			}}
		>
			<button type="button" className="pd-branch-step" aria-label={t('chat.branch.previous')} disabled={blocked} onClick={() => step(-1)}><Icon name="chevronLeft" width="13" height="13" /></button>
			<span className="pd-branch-position" aria-hidden="true">{activeIndex + 1}/{total}</span>
			<button type="button" className="pd-branch-step" aria-label={t('chat.branch.next')} disabled={blocked} onClick={() => step(1)}><Icon name="chevronRight" width="13" height="13" /></button>
			{active?.label && <span className="pd-branch-label" aria-hidden="true">{active.label}</span>}
		</div>
	);
});
