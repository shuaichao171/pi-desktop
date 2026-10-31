export interface ProjectCustomEntry {
	id: string;
	/** command = 在项目终端执行的 shell 命令；open = 打开文件或文件夹。 */
	kind: 'command' | 'open';
	value: string;
	/** 重命名后的自定义显示名；未设置时命令截断显示、文件/文件夹显示名字。 */
	label?: string;
	/** open 类条目的图标提示：浏览文件夹添加 → folder，其余 file。 */
	target?: 'file' | 'folder';
}

const KEY = 'pi-desktop.project-custom-entries.v1';
export const PROJECT_CUSTOM_ENTRY_LIMIT = 12;

export function readProjectCustomEntries(storage?: Pick<Storage, 'getItem'>): Record<string, ProjectCustomEntry[]> {
	try {
		const raw = (storage ?? globalThis.localStorage)?.getItem(KEY);
		const value = raw ? JSON.parse(raw) : {};
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
		const out: Record<string, ProjectCustomEntry[]> = {};
		for (const [workspaceKey, entries] of Object.entries(value as Record<string, unknown>)) {
			if (typeof workspaceKey !== 'string' || workspaceKey.length === 0 || !Array.isArray(entries)) continue;
			const valid = entries.slice(0, PROJECT_CUSTOM_ENTRY_LIMIT).flatMap((item): ProjectCustomEntry[] => {
				const candidate = item as Partial<ProjectCustomEntry> | null;
				if (typeof candidate !== 'object' || candidate === null) return [];
				if (typeof candidate.id !== 'string' || candidate.id.length === 0) return [];
				if (candidate.kind !== 'command' && candidate.kind !== 'open') return [];
				if (typeof candidate.value !== 'string' || candidate.value.trim().length === 0) return [];
				return [{
					id: candidate.id,
					kind: candidate.kind,
					value: candidate.value.trim(),
					label: typeof candidate.label === 'string' && candidate.label.trim() ? candidate.label.trim() : undefined,
					target: candidate.target === 'folder' ? 'folder' : 'file',
				}];
			});
			if (valid.length > 0) out[workspaceKey] = valid;
		}
		return out;
	} catch { return {}; }
}

export function saveProjectCustomEntries(entries: Record<string, ProjectCustomEntry[]>, storage?: Pick<Storage, 'setItem'>): void {
	try { (storage ?? globalThis.localStorage)?.setItem(KEY, JSON.stringify(entries)); } catch { /* Cosmetic. */ }
}

/** 条目显示名：重命名的自定义名优先；命令截断首行前 28 字符；文件/文件夹显示名字。 */
export function projectCustomEntryDisplayName(entry: ProjectCustomEntry): string {
	const label = entry.label?.trim();
	if (label) return label;
	if (entry.kind === 'command') {
		const line = entry.value.split(/\r?\n/)[0].trim();
		return line.length > 28 ? `${line.slice(0, 28)}…` : line || entry.value;
	}
	const parts = entry.value.replace(/[\\/]+$/, '').split(/[\\/]/);
	return parts.at(-1) || entry.value;
}
