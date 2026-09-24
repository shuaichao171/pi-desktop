import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { UiSlashCommand } from '@pidesktop/shared';
import { useT } from '../i18n';
import { HoverTooltip } from './HoverTooltip';
import { Icon } from './Icons';
import './composerSlashPicker.css';

interface ComposerSlashPickerProps {
	anchor: HTMLElement;
	query: string;
	commands: UiSlashCommand[];
	loading: boolean;
	error: string | null;
	busy: boolean;
	onSelect(command: UiSlashCommand): void;
	onClose(): void;
	onRetry(): void;
}

export interface ComposerSlashPickerHandle {
	handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean;
}

type Source = UiSlashCommand['source'];
type CommandRow = { id: string; command: UiSlashCommand; description: string; score: number; index: number };
const SOURCES: Source[] = ['builtin', 'extension', 'prompt', 'skill'];
const SOURCE_LABELS: Record<Source, string> = {
	builtin: 'composer.slashBuiltin', extension: 'composer.slashExtension',
	prompt: 'composer.slashPrompt', skill: 'composer.slashSkill',
};
const RESULT_LIMIT = 200;
const LOCALIZED_BUILTINS = new Set(['new', 'compact', 'name', 'reload']);

/** Literal, case-insensitive subsequence matching; a command name outranks prose. */
function matchScore(value: string, query: string): number | null {
	const text = value.trim().toLocaleLowerCase();
	if (!query) return 0;
	if (text === query) return 0;
	if (text.startsWith(query)) return 10 + (text.length - query.length) / 100;
	const substring = text.indexOf(query);
	if (substring >= 0) return 80 + substring;
	let offset = 0;
	let gaps = 0;
	for (const character of query) {
		const next = text.indexOf(character, offset);
		if (next < 0) return null;
		gaps += next - offset;
		offset = next + character.length;
	}
	return 180 + gaps + (text.length - query.length) / 100;
}

/** The agent supplies the catalog; selecting a row only asks the composer to complete it. */
export const ComposerSlashPicker = forwardRef<ComposerSlashPickerHandle, ComposerSlashPickerProps>(function ComposerSlashPicker({ anchor, query, commands, loading, error, busy, onSelect, onClose, onRetry }, ref) {
	const { t, locale } = useT();
	const id = useId();
	const panelRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	const [position, setPosition] = useState<CSSProperties | null>(null);
	const [selection, setSelection] = useState<{ query: string; id: string } | null>(null);
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const ranked = useMemo(() => {
		const seen = new Set<string>();
		const result: CommandRow[] = [];
		commands.forEach((command, index) => {
			const key = `${command.source}:${command.name}`;
			if (!command.name || !SOURCES.includes(command.source) || seen.has(key)) return;
			seen.add(key);
			const description = command.source === 'builtin' && LOCALIZED_BUILTINS.has(command.name)
				? t(`composer.slashCommand.${command.name}`) : command.description;
			const nameScore = matchScore(command.name, normalizedQuery);
			const descriptionScore = matchScore(description, normalizedQuery);
			const score = Math.min(nameScore ?? Infinity, descriptionScore === null ? Infinity : descriptionScore + 350);
			if (Number.isFinite(score)) result.push({ id: key, command, description, score, index });
		});
		return result.sort((a, b) => a.score - b.score || a.index - b.index);
	}, [commands, normalizedQuery, locale]);
	const limited = ranked.slice(0, RESULT_LIMIT);
	const groups = SOURCES.map((source) => ({ source, rows: limited.filter((row) => row.command.source === source) })).filter((group) => group.rows.length);
	const rows = groups.flatMap((group) => group.rows);
	const defaultRow = limited.find((row) => !busy || !row.command.requiresIdle) ?? limited[0];
	const selectedRow = selection?.query === query ? rows.find((row) => row.id === selection.id) : undefined;
	const activeId = (selectedRow ?? defaultRow)?.id;
	const optionId = (key: string) => `${id}-${encodeURIComponent(key)}`;
	const isDisabled = (command: UiSlashCommand) => loading || Boolean(error) || busy && command.requiresIdle;

	useEffect(() => {
		setSelection(null);
		if (listRef.current) listRef.current.scrollTop = 0;
	}, [query]);
	useEffect(() => {
		if (activeId) document.getElementById(optionId(activeId))?.scrollIntoView({ block: 'nearest' });
	}, [activeId]);

	useLayoutEffect(() => {
		const place = () => {
			const bounds = anchor.getBoundingClientRect();
			const viewportWidth = document.documentElement.clientWidth;
			const viewportHeight = document.documentElement.clientHeight;
			const chrome = document.querySelector<HTMLElement>('.pd-window-controls')?.getBoundingClientRect();
			const topPadding = chrome?.width && chrome.height ? Math.max(8, chrome.bottom + 8) : 8;
			const above = Math.max(0, bounds.top - topPadding - 6);
			const below = Math.max(0, viewportHeight - bounds.bottom - 14);
			const side = above >= 200 || above >= below ? 'top' : 'bottom';
			const width = Math.min(bounds.width, Math.max(0, viewportWidth - 16));
			const next: CSSProperties = {
				width, maxHeight: Math.min(420, side === 'top' ? above : below),
				left: Math.max(8, Math.min(bounds.left, viewportWidth - width - 8)),
				...(side === 'top' ? { bottom: viewportHeight - bounds.top + 6 } : { top: bounds.bottom + 6 }),
			};
			setPosition((current) => current && Object.keys(current).length === Object.keys(next).length && Object.entries(next).every(([key, value]) => current[key as keyof CSSProperties] === value) ? current : next);
		};
		place();
		const observer = new ResizeObserver(place);
		observer.observe(anchor);
		const chrome = document.querySelector<HTMLElement>('.pd-window-controls');
		if (chrome) observer.observe(chrome);
		window.addEventListener('resize', place);
		window.addEventListener('scroll', place, true);
		return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
	}, [anchor]);

	useEffect(() => {
		window.dispatchEvent(new CustomEvent('pd:hover-tooltip-open', { detail: id }));
		const outside = (event: Event) => {
			const target = event.target;
			if (!(target instanceof Node) || panelRef.current?.contains(target)) return;
			if (target instanceof HTMLTextAreaElement && anchor.contains(target)) return;
			closeRef.current();
		};
		document.addEventListener('pointerdown', outside);
		document.addEventListener('focusin', outside);
		return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); };
	}, [anchor, id]);

	useLayoutEffect(() => {
		const editor = anchor.querySelector<HTMLTextAreaElement>('textarea');
		if (!editor) return;
		const previous: Record<string, string | null> = {};
		for (const [name, value] of Object.entries({ 'aria-controls': `${id}-list`, 'aria-expanded': 'true', 'aria-autocomplete': 'list', 'aria-activedescendant': activeId ? optionId(activeId) : '' })) {
			previous[name] = editor.getAttribute(name);
			if (value) editor.setAttribute(name, value);
			else editor.removeAttribute(name);
		}
		return () => {
			for (const [name, value] of Object.entries(previous)) {
				if (value === null) editor.removeAttribute(name);
				else editor.setAttribute(name, value);
			}
		};
	}, [anchor, activeId, id]);

	function select(command: UiSlashCommand) { if (!isDisabled(command)) onSelect(command); }
	function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>): boolean {
		if (event.key === 'Enter' && event.shiftKey) return false;
		if (event.nativeEvent.isComposing || event.keyCode === 229) {
			if (event.key !== 'Enter' && event.key !== 'Tab') return false;
			event.stopPropagation();
			return true;
		}
		if (!['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(event.key)) return false;
		event.preventDefault();
		event.stopPropagation();
		if (event.key === 'Escape') { onClose(); return true; }
		if (event.key === 'Enter' || event.key === 'Tab') {
			const row = rows.find((item) => item.id === activeId);
			if (row) select(row.command);
			return true;
		}
		if (!loading && !error && rows.length) {
			const current = rows.findIndex((row) => row.id === activeId);
			const direction = event.key === 'ArrowDown' ? 1 : -1;
			for (let step = 1; step <= rows.length; step += 1) {
				const row = rows[(Math.max(0, current) + direction * step + rows.length) % rows.length]!;
				if (!isDisabled(row.command)) { setSelection({ query, id: row.id }); break; }
			}
		}
		return true;
	}
	useImperativeHandle(ref, () => ({ handleKeyDown }));

	return createPortal(<div ref={panelRef} className="pd-slash-picker" role="dialog" aria-label={t('composer.slashTitle')} style={{ ...position, visibility: position ? 'visible' : 'hidden' }} onKeyDown={(event) => {
		if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
	}}>
		<div className="pd-slash-header"><span className="pd-slash-mark" aria-hidden="true">/</span><span className="pd-slash-title">{t('composer.slashTitle')}</span><span className="pd-slash-query">{query || t('composer.slashHint')}</span><HoverTooltip title={t('window.closeShort')} shortcut="Esc"><button type="button" className="pd-slash-close" aria-label={t('window.closeShort')} onPointerDown={(event) => event.preventDefault()} onClick={onClose}><Icon name="close" width="15" height="15" /></button></HoverTooltip></div>
		<div ref={listRef} id={`${id}-list`} className="pd-slash-list" role="listbox" aria-label={t('composer.slashTitle')} aria-busy={loading}>
			{groups.map((group) => <div key={group.source} role="group" aria-labelledby={`${id}-${group.source}`} className="pd-slash-section">
				<div className="pd-slash-section-title" id={`${id}-${group.source}`}>{t(SOURCE_LABELS[group.source])}<span>{group.rows.length}</span></div>
				{group.rows.map((row) => {
					const unavailable = busy && row.command.requiresIdle;
					const description = unavailable ? `${row.description}\n${t('composer.slashBusyHint')}` : row.description;
					return <HoverTooltip key={row.id} title={`/${row.command.name}`} description={description || undefined} align="start"><button
						type="button" role="option" id={optionId(row.id)} aria-selected={activeId === row.id} aria-disabled={isDisabled(row.command)} tabIndex={-1}
						className={`pd-slash-option${activeId === row.id ? ' is-active' : ''}`}
						onPointerMove={() => setSelection({ query, id: row.id })} onPointerDown={(event) => event.preventDefault()} onClick={() => select(row.command)}
					><span className="pd-slash-option-name">/{row.command.name}</span><span className="pd-slash-option-description">{unavailable ? t('composer.slashBusyHint') : row.description}</span>{row.command.acceptsArguments && !unavailable && <span className="pd-slash-arguments">{t('composer.slashArguments')}</span>}</button></HoverTooltip>;
				})}
			</div>)}
			{loading && <div className="pd-slash-status" role="status">{t('composer.slashLoading')}</div>}
			{error && <div className="pd-slash-error" role="status"><span>{error}</span><button type="button" onPointerDown={(event) => event.preventDefault()} onClick={onRetry}>{t('composer.slashRetry')}</button></div>}
			{!loading && !error && !rows.length && <div className="pd-slash-status">{t(commands.length ? 'composer.slashEmpty' : 'composer.slashUnavailable')}</div>}
			{ranked.length > RESULT_LIMIT && <div className="pd-slash-status">{t('search.truncated')}</div>}
		</div>
		<div className="pd-slash-footer"><span>{t('composer.slashKeyboard')}</span><kbd>Esc</kbd></div>
	</div>, document.body);
});
