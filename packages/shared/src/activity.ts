/**
 * Activity-bar contribution contract (reserved for the extension/plugin system).
 *
 * The activity bar is the leftmost icon rail (VS Code style). Extensions will be
 * able to register additional views there; every contribution gets an icon in
 * the rail below the builtin views and a panel rendered in the sidebar area.
 *
 * The desktop only exposes this shape now so the interface stays stable; the
 * registration channel arrives with the open plugin system. A contribution
 * never grants privileges by itself — it only describes UI to render.
 */

/** Stable, app-wide unique id for a contributed activity view. */
export type UiActivityViewId = string;

export interface UiActivityViewContribution {
	id: UiActivityViewId;
	/** Short title shown in the rail tooltip and as the panel heading. */
	title: string;
	/** Icon name from the desktop icon set, or a data: URL for a custom glyph. */
	icon: string;
	/** Panel kind: builtin hosts render these; 'custom' is an extension surface. */
	kind: 'list' | 'custom';
	/** Ordering hint; builtin views occupy 0–99. */
	order?: number;
}

/** Validate an untrusted contribution payload before it reaches the UI. */
export function requireActivityViewContribution(value: unknown): UiActivityViewContribution {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('活动栏视图无效');
	const item = value as Record<string, unknown>;
	const idOk = typeof item.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(item.id);
	if (!idOk) throw new Error('活动栏视图 ID 无效');
	const title = typeof item.title === 'string' && item.title.trim().length <= 64 ? item.title.trim() : null;
	if (!title) throw new Error('活动栏视图标题无效');
	const icon = typeof item.icon === 'string' && item.icon.length <= 8192 && (/^[a-zA-Z0-9]+$/.test(item.icon) || item.icon.startsWith('data:image/')) ? item.icon : null;
	if (!icon) throw new Error('活动栏视图图标无效');
	const kind = item.kind === 'list' || item.kind === 'custom' ? item.kind : null;
	if (!kind) throw new Error('活动栏视图类型无效');
	const order = item.order === undefined ? undefined : typeof item.order === 'number' && Number.isSafeInteger(item.order) && item.order >= 0 && item.order <= 1_000_000 ? item.order : null;
	if (order === null) throw new Error('活动栏视图顺序无效');
	return { id: item.id as string, title, icon, kind, ...(order !== undefined ? { order } : {}) };
}
