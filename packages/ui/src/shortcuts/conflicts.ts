import { SHORTCUT_BINDINGS, bindingKeysFor } from './bindings';

export interface ShortcutConflict {
	keys: string;
	ids: string[];
}

/**
 * Detects duplicate key specs (4.3). Window-level scopes (global +
 * transcript) share one namespace; composer entries only collide with each
 * other because they are typing semantics.
 */
export function findShortcutConflicts(overrides: Record<string, string> = {}): ShortcutConflict[] {
	const groups = new Map<string, string[]>();
	for (const binding of SHORTCUT_BINDINGS) {
		const keys = bindingKeysFor(binding.id, overrides).trim().toLowerCase();
		if (!keys) continue;
		const namespace = binding.scope === 'composer' ? 'composer' : 'window';
		const groupKey = `${namespace}::${keys}`;
		groups.set(groupKey, [...(groups.get(groupKey) ?? []), binding.id]);
	}
	return [...groups.entries()]
		.filter(([, ids]) => ids.length > 1)
		.map(([groupKey, ids]) => ({ keys: groupKey.split('::')[1], ids }));
}

/** True when assigning `keys` to `id` would create a duplicate. */
export function isShortcutTaken(id: string, keys: string, overrides: Record<string, string> = {}): boolean {
	const target = SHORTCUT_BINDINGS.find((binding) => binding.id === id);
	if (!target) return false;
	const namespace = target.scope === 'composer' ? 'composer' : 'window';
	const normalized = keys.trim().toLowerCase();
	if (!normalized) return false;
	return SHORTCUT_BINDINGS.some((binding) => binding.id !== id
		&& (binding.scope === 'composer' ? 'composer' : 'window') === namespace
		&& bindingKeysFor(binding.id, overrides).trim().toLowerCase() === normalized);
}
