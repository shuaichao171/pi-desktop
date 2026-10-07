import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { UiFileChange, UiFileDiffScope } from '@pidesktop/shared';
import { useT } from '../i18n';
import { Icon } from './Icons';
import { ChangeStats, FileLabel } from './FileChangePresentation';
import './composerChanges.css';

const INITIAL_FILES = 3;

/** One shared review dialog for every changes entry; ChatView owns the dialog. */
export type ChangesReviewApi = (scope: UiFileDiffScope, path: string, trigger?: HTMLElement | null) => void;

const composerFocus = () => document.querySelector<HTMLTextAreaElement>('.pd-composer-shell textarea');

const trackBlur = (event: FocusEvent<HTMLElement>, entry: { current: boolean }) => {
	entry.current = event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget);
};

/** Restore focus we own after the live strip swaps for settled cards (or back). */
function useSwapFocus(entry: { current: boolean }, alternative: () => HTMLElement | null) {
	useEffect(() => () => {
		if (!entry.current || document.activeElement !== document.body) return;
		(alternative() ?? composerFocus())?.focus({ preventScroll: true });
	}, []);
}

/**
 * Settled changes card. One per completed turn (variant 'turn', scope that run);
 * the conversation variant stays at the transcript end for changes recorded
 * before run tracking existed (legacy sessions).
 */
export function ChangesCard({ items, scope, variant, review }: { items: UiFileChange[]; scope: UiFileDiffScope; variant: 'turn' | 'conversation'; review: ChangesReviewApi }) {
	const { t, locale } = useT(), zh = locale === 'zh-CN';
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
	useSwapFocus(entryHasFocus, () => document.querySelector<HTMLElement>('.pd-composer-changes.is-running .pd-changes-live-main'));
	if (!items.length) return null;
	const single = items.length === 1 ? items[0]! : null;
	const title = single ? (zh ? `已修改 ${single.path.split(/[\\/]/).at(-1)}` : `Edited ${single.path.split(/[\\/]/).at(-1)}`) : t('changes.count', { count: items.length });
	const visible = showAll ? items : items.slice(0, INITIAL_FILES);
	const openReview = (path: string, event: MouseEvent<HTMLButtonElement>) => review(scope, path, event.currentTarget);
	const fileRows = (files: UiFileChange[]) => files.map(item => <button key={item.path} type="button" className="pd-composer-changes-file" data-change-path={item.path} title={item.path} aria-label={t('changes.diffFor', { path: item.path })} aria-haspopup="dialog" onClick={event => openReview(item.path, event)}>
		<FileLabel item={item} /><ChangeStats items={[item]} /><Icon name="chevronRight" width="12" height="12" />
	</button>);
	return <section className="pd-composer-changes pd-conversation-changes" aria-label={t('changes.files')} onFocusCapture={() => { entryHasFocus.current = true; }} onBlurCapture={event => trackBlur(event, entryHasFocus)}>
		<div className="pd-changes-card-header">
			<button ref={primary} type="button" className="pd-changes-card-main" aria-haspopup="dialog" onClick={event => openReview(items[0]!.path, event)}>
				<span className="pd-changes-card-icon"><Icon name="file" width="21" height="21" /></span>
				<span className="pd-changes-card-copy"><strong title={single?.path}>{title}</strong><span className="pd-changes-card-subtitle"><span>{variant === 'turn' ? (zh ? '本轮' : 'This turn') : (zh ? '本次对话' : 'This conversation')}</span><ChangeStats items={items} /></span></span>
			</button>
			<button type="button" className="pd-composer-changes-review" aria-haspopup="dialog" onClick={event => openReview(items[0]!.path, event)}>{t('changes.review')}<Icon name="arrowRight" width="13" height="13" /></button>
		</div>
		{!single && <div id={listId} className="pd-composer-changes-files">{fileRows(visible)}
			{items.length > INITIAL_FILES && <button type="button" className="pd-changes-show-more" aria-expanded={showAll} aria-controls={listId} onClick={() => setShowAll(value => !value)}>{showAll ? (zh ? '收起文件列表' : 'Collapse files') : (zh ? `显示其余 ${items.length - INITIAL_FILES} 个文件` : `Show ${items.length - INITIAL_FILES} more files`)}<Icon name={showAll ? 'chevronUp' : 'chevronDown'} width="13" height="13" /></button>}
		</div>}
	</section>;
}

/** Compact running summary above the input: the active turn's changes so far. */
export function LiveChangesSummary({ items, scope, target, review }: { items: UiFileChange[]; scope: UiFileDiffScope; target: HTMLElement | null; review: ChangesReviewApi }) {
	const { t, locale } = useT(), zh = locale === 'zh-CN';
	const [liveFilesOpen, setLiveFilesOpen] = useState(false);
	const primary = useRef<HTMLButtonElement | null>(null);
	const popupToggle = useRef<HTMLButtonElement | null>(null);
	const liveRoot = useRef<HTMLElement | null>(null);
	const entryHasFocus = useRef(false);
	const listId = useId();
	useEffect(() => { if (items.length === 0) setLiveFilesOpen(false); }, [items.length]);
	useLayoutEffect(() => {
		if (entryHasFocus.current && document.activeElement === document.body) {
			entryHasFocus.current = false;
			(primary.current ?? composerFocus())?.focus({ preventScroll: true });
		}
	}, [items]);
	useSwapFocus(entryHasFocus, () => document.querySelector<HTMLElement>('.pd-conversation-changes .pd-changes-card-main'));
	useEffect(() => {
		if (!liveFilesOpen) return;
		const outside = (event: PointerEvent) => { if (event.target instanceof Node && !liveRoot.current?.contains(event.target)) setLiveFilesOpen(false); };
		const key = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			event.preventDefault(); event.stopPropagation(); setLiveFilesOpen(false); popupToggle.current?.focus();
		};
		document.addEventListener('pointerdown', outside);
		document.addEventListener('keydown', key, true);
		return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key, true); };
	}, [liveFilesOpen]);
	if (!items.length || !target) return null;
	const openReview = (path: string, event: MouseEvent<HTMLButtonElement>) => {
		review(scope, path, event.currentTarget);
		setLiveFilesOpen(false);
	};
	const fileRows = (files: UiFileChange[]) => files.map(item => <button key={item.path} type="button" className="pd-composer-changes-file" data-change-path={item.path} title={item.path} aria-label={t('changes.diffFor', { path: item.path })} aria-haspopup="dialog" onClick={event => openReview(item.path, event)}>
		<FileLabel item={item} /><ChangeStats items={[item]} /><Icon name="chevronRight" width="12" height="12" />
	</button>);
	return createPortal(<section ref={liveRoot} className="pd-composer-changes is-running" aria-label={t('changes.files')} onFocusCapture={() => { entryHasFocus.current = true; }} onBlurCapture={event => trackBlur(event, entryHasFocus)}>
		<div className="pd-composer-changes-summary">
			<button ref={primary} type="button" className="pd-composer-changes-review pd-changes-live-main" aria-haspopup="dialog" title={t('changes.files')} onClick={event => openReview(items[0]!.path, event)}>
				<Icon name="file" width="15" height="15" /><span>{t('changes.count', { count: items.length })}</span><ChangeStats items={items} />
			</button>
			<button ref={popupToggle} type="button" className="pd-composer-changes-toggle" aria-expanded={liveFilesOpen} aria-controls={listId} aria-label={zh ? '查看已修改的文件列表' : 'Show changed files'} onClick={() => setLiveFilesOpen(value => !value)}><Icon name="chevronDown" width="14" height="14" /></button>
		</div>
		{liveFilesOpen && <div id={listId} className="pd-changes-live-popover" role="region" aria-label={t('changes.files')}><div className="pd-changes-live-scope">{zh ? '本轮' : 'This turn'}</div>{fileRows(items)}</div>}
	</section>, target);
}
