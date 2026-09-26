import type { UiModelSummary } from '@pidesktop/shared';
export function imageCapability(model?: Pick<UiModelSummary, 'input'>): 'supported' | 'unsupported' | 'unknown' {
	if (!model || !Array.isArray(model.input) || !model.input.length) return 'unknown';
	return model.input.includes('image') ? 'supported' : 'unsupported';
}
