import { useEffect, useRef, useState } from 'react';
import { HIDDEN_CONTEXT_MAX_CHARS } from '@pidesktop/shared';
import { useT } from '../i18n';
import { useChatStore } from '../store';
import { HoverTooltip } from './HoverTooltip';
import { Icon } from './Icons';
import './hiddenContext.css';

/**
 * Transparency indicator for the composer edge. Rendered whenever the
 * conversation has a session file: an open eye while a hidden instruction is
 * active, a dimmed eye-off that still opens the editor when none is set — the
 * write path must stay reachable, otherwise the first instruction could never
 * be created.
 */
export function HiddenContextIndicator({ onToggle, open }: { onToggle(): void; open: boolean }) {
	const { t } = useT();
	const sessionPath = useChatStore((s) => s.sessionPath);
	const hiddenContext = useChatStore((s) => s.hiddenContext);
	const available = sessionPath !== null && hiddenContext !== null;
	const active = available && hiddenContext.trim().length > 0;
	if (!available && !open) return null;
	return (
		<HoverTooltip
			title={t(active ? 'hiddenContext.indicatorTitle' : 'hiddenContext.indicatorInactiveTitle')}
			description={t(active ? 'hiddenContext.indicatorDescription' : 'hiddenContext.indicatorInactiveDescription')}>
			<button type="button" className={`pd-hidden-context-toggle${active ? '' : ' is-inactive'}${open ? ' is-open' : ''}`} onMouseDown={(event) => event.preventDefault()} onClick={onToggle} aria-label={t(active ? 'hiddenContext.open' : 'hiddenContext.add')} aria-pressed={open} aria-haspopup="dialog" aria-expanded={open}><Icon name={active ? 'eye' : 'eyeOff'} width="16" height="16" /></button>
		</HoverTooltip>
	);
}

/** Inline editor above the composer toolbar; explicit user action is the only way in. */
export function HiddenContextEditor({ onClose }: { onClose(): void }) {
	const { t } = useT();
	const sessionPath = useChatStore((s) => s.sessionPath);
	const hiddenContext = useChatStore((s) => s.hiddenContext);
	const saveHiddenContext = useChatStore((s) => s.saveHiddenContext);
	const [draft, setDraft] = useState('');
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	// The stored value arrives asynchronously (ready-time fetch); seed once it lands.
	const seeded = useRef(false);
	useEffect(() => {
		if (seeded.current || hiddenContext === null) return;
		seeded.current = true;
		setDraft(hiddenContext);
	}, [hiddenContext]);
	useEffect(() => { textareaRef.current?.focus(); }, []);
	const tooLong = draft.length > HIDDEN_CONTEXT_MAX_CHARS;
	async function save(text: string) {
		if (saving) return;
		setSaving(true);
		setError(null);
		try {
			await saveHiddenContext(text);
			onClose();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	}
	return (
		<div className="pd-hidden-context-editor" role="dialog" aria-label={t('hiddenContext.title')}>
			<p className="pd-hidden-context-heading"><Icon name="eye" width="14" height="14" />{t('hiddenContext.title')}</p>
			<p className="pd-hidden-context-note">{t('hiddenContext.description')}</p>
			<textarea ref={textareaRef} value={draft} rows={5} aria-label={t('hiddenContext.title')} placeholder={t('hiddenContext.placeholder')} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }} disabled={!sessionPath || saving} />
			{error && <p className="pd-hidden-context-error" role="alert">{error}</p>}
			<div className="pd-hidden-context-actions">
				<span className={tooLong ? 'pd-hidden-context-count is-over' : 'pd-hidden-context-count'} aria-live="polite">{draft.length}/{HIDDEN_CONTEXT_MAX_CHARS}</span>
				<button type="button" className="pd-hidden-context-clear" onClick={() => void save('')} disabled={!sessionPath || saving || !hiddenContext?.trim()}>{t('hiddenContext.clear')}</button>
				<button type="button" onClick={onClose} disabled={saving}>{t('hiddenContext.cancel')}</button>
				<button type="button" className="pd-hidden-context-save" onClick={() => void save(draft)} disabled={!sessionPath || saving || tooLong || draft === (hiddenContext ?? '')}>{t('hiddenContext.save')}</button>
			</div>
		</div>
	);
}
