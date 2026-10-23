import { useSyncExternalStore } from 'react';
import { sessionTimeLabel } from '../sessionTime';
import { formatDate } from '../dateFormat';

// One shared minute clock for every recency label: only the labels re-render as
// time passes, never the sidebar that lists them. The snapshot is the current
// minute, so it stays stable between reads and changes at each minute boundary.
const listeners = new Set<() => void>();
let timer: number | undefined;
let minute = currentMinute();

function currentMinute(): number {
	return Math.floor(Date.now() / 60_000) * 60_000;
}

function getMinute(): number {
	const next = currentMinute();
	if (next !== minute) minute = next;
	return minute;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	if (timer === undefined) timer = window.setInterval(() => { for (const notify of listeners) notify(); }, 15_000);
	return () => {
		listeners.delete(listener);
		if (!listeners.size && timer !== undefined) { window.clearInterval(timer); timer = undefined; }
	};
}

export function SessionTime({ modified, locale }: { modified: string; locale: string }) {
	const now = useSyncExternalStore(subscribe, getMinute, getMinute);
	const label = sessionTimeLabel(modified, now, locale);
	if (!label) return null;
	return <time className="pd-session-time" dateTime={modified} title={formatDate(modified, locale, { time: true, year: 'always' })}>{label}</time>;
}
