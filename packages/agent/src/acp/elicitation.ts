import { isElicitationValue, type UiElicitationChoice, type UiElicitationField, type UiElicitationForm, type UiElicitationResponse } from '@pidesktop/shared';
import { AcpRequestError } from './protocol.ts';

export interface AcpFormRequest {
	sessionId: string;
	message: string;
	title?: string;
	form: UiElicitationForm;
	async: boolean;
}

export type AcpElicitationResponse = UiElicitationResponse | { action: 'cancel' };

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown, limit = 10_000): string | undefined {
	return typeof value === 'string' && value.length <= limit ? value : undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseChoices(schema: Record<string, unknown>, key: 'oneOf' | 'anyOf'): UiElicitationChoice[] | undefined {
	const entries = schema[key] ?? schema.enum;
	if (!Array.isArray(entries) || !entries.length || entries.length > 100 || (key === 'oneOf' && schema.enum != null && schema.oneOf != null)) return undefined;
	const choices: UiElicitationChoice[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const option = record(entry);
		const value = text(option ? option.const : entry);
		if (value === undefined || seen.has(value)) return undefined;
		seen.add(value);
		choices.push({ value, title: text(option?.title) || value, description: text(option?.description) });
	}
	return choices;
}

function parseField(id: string, raw: unknown, required: boolean): UiElicitationField | undefined {
	const schema = record(raw);
	if (!schema || record(record(schema._meta)?.codex)?.isSecret === true) return undefined;
	const base = { id, title: text(schema.title) || id, description: text(schema.description), required };
	let field: UiElicitationField;
	switch (schema.type) {
		case 'string': {
			if (schema.oneOf !== undefined || schema.enum !== undefined) {
				const choices = parseChoices(schema, 'oneOf');
				if (!choices) return undefined;
				field = { ...base, kind: 'select', choices };
			} else {
				field = { ...base, kind: 'text', minLength: count(schema.minLength), maxLength: count(schema.maxLength) };
			}
			break;
		}
		case 'array': {
			const items = record(schema.items);
			const choices = items && (items.type === undefined || items.type === 'string') && parseChoices(items, 'anyOf');
			if (!choices) return undefined;
			field = { ...base, kind: 'multi-select', choices, minItems: count(schema.minItems), maxItems: count(schema.maxItems) };
			break;
		}
		case 'number':
		case 'integer':
			field = { ...base, kind: schema.type, minimum: number(schema.minimum), maximum: number(schema.maximum) };
			break;
		case 'boolean':
			field = { ...base, kind: 'boolean' };
			break;
		default:
			return undefined;
	}
	return isElicitationValue(field, schema.default) ? { ...field, defaultValue: schema.default } as UiElicitationField : field;
}

export function parseElicitationForm(params: unknown): AcpFormRequest {
	const invalid = () => new AcpRequestError({ code: -32602, message: 'Invalid or unsupported elicitation form' });
	const request = record(params);
	const schema = record(request?.requestedSchema);
	const properties = record(schema?.properties);
	const required = schema?.required ?? [];
	const sessionId = text(request?.sessionId);
	const message = text(request?.message);
	if (request?.mode !== 'form' || !sessionId || request.requestId != null || message === undefined || schema?.type !== 'object' || !properties
		|| !Array.isArray(required) || !required.every((id) => typeof id === 'string' && Object.hasOwn(properties, id))) throw invalid();
	const entries = Object.entries(properties);
	if (entries.length > 50) throw invalid();
	const fields: UiElicitationField[] = [];
	for (const [id, value] of entries) {
		const isRequired = required.includes(id);
		const field = parseField(id, value, isRequired);
		if (field) fields.push(field);
		else if (isRequired) throw invalid();
	}
	if (entries.length && !fields.length) throw invalid();
	return { sessionId, message, title: text(schema.title), form: { fields, description: text(schema.description) }, async: record(record(request._meta)?.codex)?.delivery === 'async' };
}
