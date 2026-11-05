export interface OperationNotice {
	id: string;
	kind: 'success' | 'error' | 'pending' | 'warning';
	title: string;
	detail?: string;
	retry?: () => Promise<unknown>;
}

let notices: OperationNotice[] = [];
const listeners = new Set<() => void>();
const running = new Set<string>();
function emit() { for (const listener of listeners) listener(); }
export const operationFeedback = {
	getSnapshot: () => notices,
	subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
	dismiss(id: string) { notices = notices.filter(item => item.id !== id); emit(); },
	show(notice: OperationNotice) {
		notices = [...notices.filter(item => item.id !== notice.id), notice].slice(-12);
		emit();
	},
};

/** The caller captures the operation's target before closing its menu. */
export async function runWithFeedback(options: { id: string; title: string; run(): Promise<unknown>; showPending?: boolean; success?: string | ((result: unknown) => string | null); canRetry?(): boolean }): Promise<boolean> {
	if (running.has(options.id)) return false;
	running.add(options.id);
	if (options.showPending !== false) operationFeedback.show({ id: options.id, title: options.title, kind: 'pending' });
	else operationFeedback.dismiss(options.id);
	try {
		const result = await options.run();
		const success = typeof options.success === 'function' ? options.success(result) : options.success;
		if (success) operationFeedback.show({ id: options.id, title: success, kind: 'success' });
		else operationFeedback.dismiss(options.id);
		return true;
	} catch (cause) {
		operationFeedback.show({ id: options.id, title: options.title, kind: 'error', detail: cause instanceof Error ? cause.message : String(cause), retry: options.canRetry?.() === false ? undefined : async () => {
			if (options.canRetry?.() === false) return;
			await runWithFeedback(options);
		} });
		return false;
	} finally { running.delete(options.id); }
}
