import type { UiModelSummary } from '@pidesktop/shared';

export interface ModelProviderGroup {
	provider: string;
	models: UiModelSummary[];
}

/** Search the whole catalog before grouping; keep each provider's model order. */
export function groupModelsByProvider(models: UiModelSummary[], query: string, locale: string): ModelProviderGroup[] {
	const search = query.trim().toLowerCase();
	const grouped = new Map<string, UiModelSummary[]>();
	for (const model of models) {
		if (search && !`${model.provider} ${model.id} ${model.name}`.toLowerCase().includes(search)) continue;
		const group = grouped.get(model.provider);
		if (group) group.push(model);
		else grouped.set(model.provider, [model]);
	}
	return [...grouped].map(([provider, providerModels]) => ({ provider, models: providerModels }))
		.sort((left, right) => left.provider.localeCompare(right.provider, locale));
}

export function selectModelProvider(groups: ModelProviderGroup[], requested: string | null, current: string): string | null {
	if (requested !== null && groups.some((group) => group.provider === requested)) return requested;
	if (groups.some((group) => group.provider === current)) return current;
	return groups[0]?.provider ?? null;
}
