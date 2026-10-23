import { useSyncExternalStore } from 'react';

export interface ConversationMetricsPreferences { speed: boolean; tokens: boolean; duration: boolean }
export const CONVERSATION_METRICS_STORAGE_KEY = 'pi-desktop:conversation-metrics';
export const DEFAULT_CONVERSATION_METRICS: Readonly<ConversationMetricsPreferences> = Object.freeze({ speed: true, tokens: true, duration: true });
const listeners = new Set<() => void>();

export function normalizeConversationMetrics(value: unknown): ConversationMetricsPreferences {
	const saved = value && typeof value === 'object' ? value as Partial<ConversationMetricsPreferences> : {};
	return { speed: typeof saved.speed === 'boolean' ? saved.speed : true, tokens: typeof saved.tokens === 'boolean' ? saved.tokens : true, duration: typeof saved.duration === 'boolean' ? saved.duration : true };
}
function parsePreferences(value: string | null): ConversationMetricsPreferences {
	try { return normalizeConversationMetrics(value ? JSON.parse(value) : null); }
	catch { return { ...DEFAULT_CONVERSATION_METRICS }; }
}
function readPreferences(): ConversationMetricsPreferences {
	try { return parsePreferences(typeof window === 'undefined' ? null : window.localStorage.getItem(CONVERSATION_METRICS_STORAGE_KEY)); }
	catch { return { ...DEFAULT_CONVERSATION_METRICS }; }
}
let activePreferences = readPreferences();
function publish(next: ConversationMetricsPreferences): void {
	if (Object.keys(DEFAULT_CONVERSATION_METRICS).every(key => activePreferences[key as keyof ConversationMetricsPreferences] === next[key as keyof ConversationMetricsPreferences])) return;
	activePreferences = next;
	for (const listener of listeners) listener();
}
export function getConversationMetricsPreferences(): ConversationMetricsPreferences { return activePreferences; }
/** Apply locally even if storage is unavailable; the return value reports persistence. */
export function setConversationMetricsPreferences(patch: Partial<ConversationMetricsPreferences>): boolean {
	const next = normalizeConversationMetrics({ ...activePreferences, ...patch });
	let saved = false;
	try { if (typeof window !== 'undefined') { window.localStorage.setItem(CONVERSATION_METRICS_STORAGE_KEY, JSON.stringify(next)); saved = true; } } catch { /* Keep the current session preference. */ }
	publish(next);
	return saved;
}
export function subscribeConversationMetricsPreferences(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
	if (event.key !== null && event.key !== CONVERSATION_METRICS_STORAGE_KEY) return;
	try { if (event.storageArea && event.storageArea !== window.localStorage) return; } catch { return; }
	publish(parsePreferences(event.key === null ? null : event.newValue));
});
export function useConversationMetricsPreferences(): [ConversationMetricsPreferences, typeof setConversationMetricsPreferences] {
	return [useSyncExternalStore(subscribeConversationMetricsPreferences, getConversationMetricsPreferences, () => DEFAULT_CONVERSATION_METRICS), setConversationMetricsPreferences];
}
