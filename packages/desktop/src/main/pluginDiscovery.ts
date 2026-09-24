import type { UiPluginDiscovery, UiPluginDiscoveryItem } from '@pidesktop/shared';

const SEARCH_URL = 'https://registry.npmjs.org/-/v1/search';
const MAX_BYTES = 2 * 1024 * 1024;
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const packageVersion = /^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max).trim() : '';

/** Registry listings are untrusted metadata, never executable installation instructions. */
export function parsePluginDiscovery(value: unknown): UiPluginDiscovery {
	if (!record(value) || !Array.isArray(value.objects)) throw new Error('插件目录返回格式无效，请稍后重试');
	const items: UiPluginDiscoveryItem[] = [];
	const seen = new Set<string>();
	for (const object of value.objects.slice(0, 50)) {
		if (!record(object) || !record(object.package)) continue;
		const pkg = object.package;
		if (typeof pkg.name !== 'string' || pkg.name.length > 214 || !packageName.test(pkg.name)
			|| typeof pkg.version !== 'string' || pkg.version.length > 100 || !packageVersion.test(pkg.version)
			|| !Array.isArray(pkg.keywords) || !pkg.keywords.includes('pi-package') || seen.has(pkg.name)) continue;
		seen.add(pkg.name);
		items.push({
			name: pkg.name, version: pkg.version, source: `npm:${pkg.name}@${pkg.version}`,
			description: text(pkg.description, 800),
			author: text(record(pkg.author) ? pkg.author.name : typeof pkg.author === 'string' ? pkg.author : record(pkg.publisher) ? pkg.publisher.username : '', 120),
		});
	}
	return { items, total: typeof value.total === 'number' && Number.isSafeInteger(value.total) && value.total >= items.length ? value.total : items.length };
}

/** A small public catalog, queried only when the user opens Discover or searches. */
export function createPluginDiscovery(fetcher: typeof fetch = fetch, now: () => number = Date.now) {
	const cache = new Map<string, { at: number; value: UiPluginDiscovery }>();
	return async (query: unknown): Promise<UiPluginDiscovery> => {
		if (typeof query !== 'string' || query.length > 120 || /[\u0000-\u001f\u007f]/.test(query)) throw new Error('插件搜索内容无效');
		const normalized = query.trim();
		const cached = cache.get(normalized);
		if (cached && now() - cached.at < 60_000) return structuredClone(cached.value);
		const url = new URL(SEARCH_URL);
		url.searchParams.set('text', `keywords:pi-package ${normalized}`.trim());
		url.searchParams.set('size', '24');
		const response = await fetcher(url, { signal: AbortSignal.timeout(12_000), redirect: 'error', headers: { Accept: 'application/json' } });
		if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES) {
			await response.body?.cancel().catch(() => {});
			throw new Error(!response.ok ? `无法读取 npm 插件目录（HTTP ${response.status}），请稍后重试` : '插件目录响应过大');
		}
		const reader = response.body?.getReader();
		if (!reader) throw new Error('插件目录未返回内容');
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > MAX_BYTES) throw new Error('插件目录响应过大');
				chunks.push(value);
			}
		} finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
		let data: unknown;
		try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
		catch { throw new Error('插件目录返回格式无效，请稍后重试'); }
		const value = parsePluginDiscovery(data);
		if (cache.size >= 20) cache.delete(cache.keys().next().value!);
		cache.set(normalized, { at: now(), value });
		return structuredClone(value);
	};
}
