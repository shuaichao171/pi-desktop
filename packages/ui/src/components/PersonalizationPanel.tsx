import { useEffect, useState, type FormEvent } from 'react';
import type { UiInstructionDocument } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import './personalization.css';

type DocumentId = UiInstructionDocument['id'];
const editableText = (value: string) => value.replace(/\r\n/g, '\n');
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function PersonalizationPanel({ active, onDraftStateChange }: {
	active: boolean;
	onDraftStateChange(state: { dirty: boolean; saving: boolean }): void;
}) {
	const { t } = useT();
	const bridge = useChatStore((s) => s.bridge);
	const [documents, setDocuments] = useState<UiInstructionDocument[] | null>(null);
	const [drafts, setDrafts] = useState<Partial<Record<DocumentId, string>>>({});
	const [conflicts, setConflicts] = useState<Partial<Record<DocumentId, UiInstructionDocument>>>({});
	const [errors, setErrors] = useState<Partial<Record<DocumentId, string>>>({});
	const [saved, setSaved] = useState<DocumentId | null>(null);
	const [pending, setPending] = useState<DocumentId | null>(null);
	const [loading, setLoading] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const dirty = Boolean(documents?.some((doc) => drafts[doc.id] !== editableText(doc.content)));

	useEffect(() => { onDraftStateChange({ dirty, saving: pending !== null }); }, [dirty, pending, onDraftStateChange]);
	useEffect(() => {
		if (!active || documents || !bridge) return;
		let current = true;
		setLoading(true);
		setLoadError(null);
		void bridge.getPersonalization().then((items) => {
			if (!current) return;
			setDocuments(items);
			setDrafts(Object.fromEntries(items.map((doc) => [doc.id, editableText(doc.content)])));
		}).catch((error: unknown) => { if (current) setLoadError(errorText(error)); })
			.finally(() => { if (current) setLoading(false); });
		return () => { current = false; };
	}, [active, documents, bridge, attempt]);

	async function save(doc: UiInstructionDocument, revision = doc.revision) {
		if (!bridge || pending || doc.error) return;
		setPending(doc.id);
		setSaved(null);
		setErrors((previous) => ({ ...previous, [doc.id]: undefined }));
		try {
			const result = await bridge.saveInstruction({ id: doc.id, content: drafts[doc.id] ?? '', revision });
			if (result.status === 'conflict') {
				setConflicts((previous) => ({ ...previous, [doc.id]: result.document }));
				return;
			}
			setDocuments((previous) => previous?.map((item) => item.id === doc.id ? result.document : item) ?? null);
			setDrafts((previous) => ({ ...previous, [doc.id]: editableText(result.document.content) }));
			setConflicts((previous) => ({ ...previous, [doc.id]: undefined }));
			setSaved(doc.id);
		} catch (error) {
			setErrors((previous) => ({ ...previous, [doc.id]: errorText(error) }));
		} finally { setPending(null); }
	}

	function submit(event: FormEvent<HTMLFormElement>, doc: UiInstructionDocument) {
		event.preventDefault();
		if (drafts[doc.id] !== editableText(doc.content) && !conflicts[doc.id]) void save(doc);
	}

	return <section className="pd-personalization" hidden={!active}>
		<div className="pd-settings-section-head"><h2>{t('settings.personalization')}</h2><p>{t('personalization.description')}</p></div>
		{(loading || (!bridge && !documents)) && <p className="pd-settings-hint" role="status">{t('personalization.loading')}</p>}
		{loadError && <div className="pd-settings-error" role="alert">{loadError}<button type="button" className="pd-instruction-button" onClick={() => setAttempt((value) => value + 1)}>{t('personalization.retry')}</button></div>}
		{documents?.map((doc) => {
			const changed = drafts[doc.id] !== editableText(doc.content);
			const conflict = conflicts[doc.id];
			return <form className="pd-instruction-card" data-instruction-id={doc.id} key={doc.id} onSubmit={(event) => submit(event, doc)} onKeyDown={(event) => {
				if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.currentTarget.requestSubmit(); }
			}}>
				<div className="pd-instruction-heading"><h3>{t(`personalization.${doc.id}.title`)}</h3><span>{t(doc.exists ? 'personalization.file' : 'personalization.notCreated')}</span></div>
				<p className="pd-instruction-description">{t(`personalization.${doc.id}.description`)}</p>
				<code className="pd-instruction-path">{doc.path}</code>
				{doc.id === 'pi' && /AGENTS\.override\.md$/i.test(doc.path) && <p className="pd-settings-hint">{t('personalization.override')}</p>}
				{doc.error ? <p className="pd-settings-error" role="alert">{doc.error}</p> : <>
					<label className="pd-instruction-label" htmlFor={`pd-instruction-${doc.id}`}>{t('personalization.instructions')}</label>
					<textarea id={`pd-instruction-${doc.id}`} className="pd-instruction-editor" rows={7} spellCheck={false} value={drafts[doc.id] ?? ''} placeholder={t('personalization.placeholder')} disabled={pending !== null} onChange={(event) => { const value = event.target.value; setDrafts((previous) => ({ ...previous, [doc.id]: value })); setSaved(null); }} />
				</>}
				{conflict && <div className="pd-instruction-conflict" role="alert">
					<strong>{t('personalization.conflict')}</strong><p>{t('personalization.conflictHint')}</p>
					<code className="pd-instruction-path">{conflict.path}</code>
					{conflict.error ? <p>{conflict.error}</p> : <details><summary>{t('personalization.diskVersion')}</summary><pre>{conflict.content || t('personalization.emptyFile')}</pre></details>}
					{!conflict.error && <div className="pd-instruction-actions">
						<button type="button" className="pd-instruction-button" disabled={pending !== null} onClick={() => {
							setDocuments((previous) => previous?.map((item) => item.id === doc.id ? conflict : item) ?? null);
							setDrafts((previous) => ({ ...previous, [doc.id]: editableText(conflict.content) }));
							setConflicts((previous) => ({ ...previous, [doc.id]: undefined }));
							setErrors((previous) => ({ ...previous, [doc.id]: undefined }));
						}}>{t('personalization.useDisk')}</button>
						<button type="button" className="pd-instruction-button" disabled={pending !== null} onClick={() => void save(doc, conflict.revision)}>{t('personalization.overwrite')}</button>
					</div>}
				</div>}
				{errors[doc.id] && <p className="pd-settings-error" role="alert">{errors[doc.id]}</p>}
				<div className="pd-instruction-footer"><span role="status">{pending === doc.id ? t('personalization.saving') : saved === doc.id ? t('personalization.saved') : changed ? t('personalization.unsaved') : t('personalization.shortcut')}</span><button className="pd-settings-primary pd-instruction-save" type="submit" disabled={!changed || pending !== null || Boolean(doc.error) || Boolean(conflict)}>{t(pending === doc.id ? 'personalization.saving' : 'settings.save')}</button></div>
			</form>;
		})}
		{documents && <p className="pd-settings-hint">{t('personalization.applyHint')}</p>}
	</section>;
}
