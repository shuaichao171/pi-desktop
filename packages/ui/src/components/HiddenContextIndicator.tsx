import { useEffect, useRef, useState } from 'react';
import { HIDDEN_CONTEXT_MAX_CHARS } from '@pidesktop/shared';
import { useT } from '../i18n';
import { useChatStore } from '../store';
import { HoverTooltip } from './HoverTooltip';
import { Icon } from './Icons';
import './hiddenContext.css';

/** True when the open conversation carries a hidden instruction. */
function useHiddenContextActive(): boolean {
	const sessionPath = useChatStore((s) => s.sessionPath);
	const hiddenContext = useChatStore((s) => s.hiddenContext);
	return sessionPath !== null && hiddenContext !== null && hiddenContext.trim().length > 0;
}

/**
 * Transparency indicator for the composer edge: a small eye that appears only
 * while a hidden instruction is active. Hovering says what it means; clicking
 * reveals the editor — the content stays out of the transcript either way.
 */
export function HiddenContextIndicator({ onToggle, open }: { onToggle(): void; open: boolean }) {
	const { t } = useT();
	const active = useHiddenContextActive();
	if (!active && !open) return null;
	return (
		<HoverTooltip title={t('hiddenContext.indicatorTitle')} description={t('hiddenContext.indicatorDescription')}>
			<button type="button" className={`pd-hidden-context-toggle${open ? ' is-open' : ''}`} onMouseDown={(event) => event.preventDefault()} onClick={onToggle} aria-label={t('hiddenContext.open')} aria-pressed={open} aria-haspopup="dialog" aria-expanded={open}><Icon name="eye" width="16" height="16" /></button>
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
