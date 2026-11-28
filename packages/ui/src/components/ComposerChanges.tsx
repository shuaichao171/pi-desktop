import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type MouseEvent } from 'react';
import type { UiFileChange, UiFileDiffScope } from '@pidesktop/shared';
import { useT } from '../i18n';
import { Icon } from './Icons';
import { FileLabel } from './FileChangePresentation';
import './composerChanges.css';

const INITIAL_FILES = 3;

/** One shared review dialog for every changes entry; ChatView owns the dialog. */
export type ChangesReviewApi = (scope: UiFileDiffScope, path: string, trigger?: HTMLElement | null) => void;

const composerFocus = () => document.querySelector<HTMLTextAreaElement>('.pd-composer-shell textarea');

const trackBlur = (event: FocusEvent<HTMLElement>, entry: { current: boolean }) => {
	entry.current = event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget);
};

/**
 * Settled changes card. One per completed turn (variant 'turn', scope that run);
 * the conversation variant stays at the transcript end for changes recorded
 * before run tracking existed (legacy sessions).
 */
export function ChangesCard({ items, scope, variant, review }: { items: UiFileChange[]; scope: UiFileDiffScope; variant: 'turn' | 'conversation'; review: ChangesReviewApi }) {
	const { t } = useT();
	const [showAll, setShowAll] = useState(false);
	const primary = useRef<HTMLButtonElement | null>(null);
	const entryHasFocus = useRef(false);
	const listId = useId();
	useEffect(() => { if (items.length === 0) setShowAll(false); }, [items.length]);
	// Removing a file from a snapshot can remove its focused control.
	useLayoutEffect(() => {
		if (entryHasFocus.current && document.activeElement === document.body) {
			entryHasFocus.current = false;
			(primary.current ?? composerFocus())?.focus({ preventScroll: true });
		}
	}, [items]);
	useEffect(() => () => {
		if (!entryHasFocus.current || document.activeElement !== document.body) return;
		composerFocus()?.focus({ preventScroll: true });
	}, []);
	if (!items.length) return null;
	const single = items.length === 1 ? items[0]! : null;
	const title = single ? (t('composerChanges.editedSingle', { name: single.path.split(/[\\/]/).at(-1) ?? '' })) : t('changes.count', { count: items.length });
	const visible = showAll ? items : items.slice(0, INITIAL_FILES);
	const openReview = (path: string, event: MouseEvent<HTMLButtonElement>) => review(scope, path, event.currentTarget);
	const fileRows = (files: UiFileChange[]) => files.map(item => <button key={item.path} type="button" className="pd-composer-changes-file" data-change-path={item.path} title={item.path} aria-label={t('changes.diffFor', { path: item.path })} aria-haspopup="dialog" onClick={event => openReview(item.path, event)}>
		<FileLabel item={item} /><Icon name="chevronRight" width="12" height="12" />
	</button>);
	return <section className="pd-composer-changes pd-conversation-changes" aria-label={t('changes.files')} onFocusCapture={() => { entryHasFocus.current = true; }} onBlurCapture={event => trackBlur(event, entryHasFocus)}>
		<div className="pd-changes-card-header">
			<button ref={primary} type="button" className="pd-changes-card-main" aria-haspopup="dialog" onClick={event => openReview(items[0]!.path, event)}>
				<span className="pd-changes-card-icon"><Icon name="file" width="21" height="21" /></span>
				<span className="pd-changes-card-copy"><strong title={single?.path}>{title}</strong><span className="pd-changes-card-subtitle"><span>{variant === 'turn' ? (t('composerChanges.thisTurn')) : (t('composerChanges.thisConversation'))}</span></span></span>
			</button>
			<button type="button" className="pd-composer-changes-review" aria-haspopup="dialog" onClick={event => openReview(items[0]!.path, event)}>{t('changes.review')}<Icon name="arrowRight" width="13" height="13" /></button>
		</div>
		{!single && <div id={listId} className="pd-composer-changes-files">{fileRows(visible)}
			{items.length > INITIAL_FILES && <button type="button" className="pd-changes-show-more" aria-expanded={showAll} aria-controls={listId} onClick={() => setShowAll(value => !value)}>{showAll ? (t('composerChanges.collapse')) : (t('composerChanges.showMore', { count: items.length - INITIAL_FILES }))}<Icon name={showAll ? 'chevronUp' : 'chevronDown'} width="13" height="13" /></button>}
		</div>}
	</section>;
}
