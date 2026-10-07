/**
 * Ring buffer of every outgoing cloud-sync HTTP request (WebDAV and S3),
 * exposed through the loopback debug API so connection issues can be
 * diagnosed against the running app without a debugger.
 */

export interface CloudRequestLogEntry {
	/** ISO-8601 timestamp of the request. */
	time: string;
	kind: 'webdav' | 's3';
	method: string;
	/** Request URL; credentials never appear in WebDAV/S3 URLs. */
	url: string;
	/** Response status; null when the request never completed. */
	status: number | null;
	/** Round-trip duration in milliseconds; null when unknown. */
	ms: number | null;
	/** Transport error message; null on a completed exchange. */
	error: string | null;
}

const MAX_ENTRIES = 300;
const entries: CloudRequestLogEntry[] = [];

export function recordCloudRequest(entry: CloudRequestLogEntry): void {
	entries.push(entry);
	if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

export function recentCloudRequests(): CloudRequestLogEntry[] {
	return [...entries];
}

export function clearCloudRequests(): void {
	entries.length = 0;
}
