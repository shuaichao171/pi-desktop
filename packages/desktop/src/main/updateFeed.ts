/** A release feed is a public HTTPS directory containing latest*.yml and installers. */
export function parseUpdateFeedUrl(value: unknown): string | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	try {
		const url = new URL(value.trim());
		if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/')) return null;
		if (/^(localhost|.+\.localhost)$/i.test(url.hostname) || /^[\d.]+$/.test(url.hostname) || url.hostname.startsWith('[')) return null;
		return url.toString();
	} catch {
		return null;
	}
}
