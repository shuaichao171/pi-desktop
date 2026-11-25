import { useState, type FormEvent } from 'react';
import { requireElicitationResponse, type UiElicitationField, type UiElicitationForm, type UiElicitationValue, type UiExtensionDialogResponse } from '@pidesktop/shared';
import { useT } from '../i18n';

function readField(values: FormData, field: UiElicitationField, name: string): UiElicitationValue | undefined {
	const value = values.get(name);
	if (field.kind === 'multi-select') {
		const selected = values.getAll(name).map((index) => field.choices[Number(index)]!.value);
		return selected.length || field.required ? selected : undefined;
	}
	if (typeof value !== 'string' || value === '') return undefined;
	switch (field.kind) {
		case 'select': return field.choices[Number(value)]?.value;
		case 'number':
		case 'integer': return Number(value);
		case 'boolean': return value === 'true';
		case 'text': return value;
	}
}

export function ElicitationForm({ form, pending, onRespond }: { form: UiElicitationForm; pending: boolean; onRespond: (response: UiExtensionDialogResponse) => void }) {
	const { t } = useT();
	const [error, setError] = useState('');
	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const values = new FormData(event.currentTarget);
		const content = Object.fromEntries(form.fields.flatMap((field, index) => {
			const value = readField(values, field, String(index));
			return value === undefined ? [] : [[field.id, value]];
		}));
		try {
			const response = requireElicitationResponse(form, { action: 'accept', content });
			setError('');
			onRespond(response);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	}
	return <form className="pd-elicitation-form" onSubmit={submit} onChange={() => { if (error) setError(''); }}>
		{form.description && <p className="pd-extension-request-message">{form.description}</p>}
		{form.fields.map((field, index) => {
			const name = String(index);
			const title = <>{field.title}{field.required && <span className="pd-elicitation-required">{t('extension.formRequired')}</span>}</>;
			const description = field.description && <span className="pd-elicitation-description">{field.description}</span>;
			if (field.kind === 'select' || field.kind === 'multi-select') {
				return <fieldset key={field.id} className="pd-elicitation-field" disabled={pending}>
					<legend>{title}</legend>
					{description}
					{field.choices.map((choice, optionIndex) => <label key={choice.value} className="pd-elicitation-choice">
						<input name={name} type={field.kind === 'select' ? 'radio' : 'checkbox'} value={optionIndex}
							required={field.kind === 'select' && field.required}
							defaultChecked={field.kind === 'select' ? field.defaultValue === choice.value : field.defaultValue?.includes(choice.value)} />
						<span>{choice.title}{choice.description && <span className="pd-elicitation-description">{choice.description}</span>}</span>
					</label>)}
					{field.kind === 'select' && !field.required && <label className="pd-elicitation-choice"><input name={name} type="radio" value="" />{t('extension.formUnanswered')}</label>}
				</fieldset>;
			}
			return <label key={field.id} className="pd-elicitation-field">
				<span>{title}</span>
				{description}
				{field.kind === 'boolean' ? <select name={name} defaultValue={String(field.defaultValue ?? '')} required={field.required} disabled={pending}>
					<option value="">{t('extension.formUnanswered')}</option><option value="true">{t('extension.formYes')}</option><option value="false">{t('extension.formNo')}</option>
				</select> : field.kind === 'text' ? <input name={name} defaultValue={field.defaultValue} minLength={field.minLength} maxLength={Math.min(field.maxLength ?? 100_000, 100_000)} required={field.required} disabled={pending} />
					: <input name={name} type="number" step={field.kind === 'integer' ? 1 : 'any'} defaultValue={field.defaultValue} min={field.minimum} max={field.maximum} required={field.required} disabled={pending} />}
			</label>;
		})}
		{error && <p className="pd-extension-request-error" role="alert">{error}</p>}
		<div className="pd-extension-request-actions">
			<button type="button" className="pd-btn is-sm" disabled={pending} onClick={() => onRespond(null)}>{t('extension.cancel')}</button>
			<button type="button" className="pd-btn is-sm" disabled={pending} onClick={() => onRespond({ action: 'decline' })}>{t('extension.formDecline')}</button>
			<button type="submit" className="pd-btn is-sm is-primary" disabled={pending}>{t('extension.submit')}</button>
		</div>
	</form>;
}
