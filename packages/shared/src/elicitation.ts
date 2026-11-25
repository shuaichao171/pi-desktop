export interface UiElicitationChoice {
	value: string;
	title: string;
	description?: string;
}

export type UiElicitationField = {
	id: string;
	title: string;
	description?: string;
	required: boolean;
} & (
	| { kind: 'text'; defaultValue?: string; minLength?: number; maxLength?: number }
	| { kind: 'select'; choices: UiElicitationChoice[]; defaultValue?: string }
	| { kind: 'multi-select'; choices: UiElicitationChoice[]; defaultValue?: string[]; minItems?: number; maxItems?: number }
	| { kind: 'number' | 'integer'; defaultValue?: number; minimum?: number; maximum?: number }
	| { kind: 'boolean'; defaultValue?: boolean }
);

export interface UiElicitationForm {
	fields: UiElicitationField[];
	description?: string;
}

export type UiElicitationValue = string | string[] | number | boolean;
export type UiElicitationResponse = { action: 'accept'; content: Record<string, UiElicitationValue> } | { action: 'decline' };

export function isElicitationValue(field: UiElicitationField, value: unknown): value is UiElicitationValue {
	switch (field.kind) {
		case 'text':
			return typeof value === 'string' && value.length >= (field.minLength ?? 0) && value.length <= Math.min(field.maxLength ?? 100_000, 100_000);
		case 'select':
			return field.choices.some((choice) => choice.value === value);
		case 'multi-select':
			return Array.isArray(value) && value.length >= (field.minItems ?? 0) && value.length <= (field.maxItems ?? field.choices.length)
				&& new Set(value).size === value.length && value.every((item) => field.choices.some((choice) => choice.value === item));
		case 'number':
		case 'integer':
			return typeof value === 'number' && Number.isFinite(value) && (field.kind === 'number' || Number.isInteger(value))
				&& value >= (field.minimum ?? -Infinity) && value <= (field.maximum ?? Infinity);
		case 'boolean':
			return typeof value === 'boolean';
	}
}

export function requireElicitationResponse(form: UiElicitationForm, response: unknown): UiElicitationResponse {
	if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('表单回复无效');
	const { action, content } = response as { action?: unknown; content?: unknown };
	if (action === 'decline') return { action };
	if (action !== 'accept' || !content || typeof content !== 'object' || Array.isArray(content)) throw new Error('表单回复无效');
	const fields = new Map(form.fields.map((field) => [field.id, field]));
	const entries = Object.entries(content);
	for (const [id, value] of entries) {
		const field = fields.get(id);
		if (!field) throw new Error('表单回复包含未知字段');
		if (!isElicitationValue(field, value)) throw new Error(`答案格式有误：${field.title}`);
	}
	for (const field of form.fields) {
		if (field.required && !Object.hasOwn(content, field.id)) throw new Error(`请回答：${field.title}`);
	}
	return { action, content: Object.fromEntries(entries) };
}
