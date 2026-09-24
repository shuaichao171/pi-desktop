import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { UiExtensionDialogRequest } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { Icon } from './Icons';

function mergeRequests(current: UiExtensionDialogRequest[], incoming: UiExtensionDialogRequest[]): UiExtensionDialogRequest[] {
	const byId = new Map(current.map((request) => [request.id, request]));
	for (const request of incoming) byId.set(request.id, request);
	return [...byId.values()];
}

function NotificationToast({ request, onDismiss }: { request: UiExtensionDialogRequest; onDismiss(id: string): void }) {
	const { t } = useT();
	useEffect(() => {
		const timer = window.setTimeout(() => onDismiss(request.id), request.timeout && request.timeout > 0 ? request.timeout : 6000);
		return () => window.clearTimeout(timer);
	}, [request.id, request.timeout]);
	return <div className={`pd-extension-notice is-${request.notificationType ?? 'info'}`} role={request.notificationType === 'error' ? 'alert' : 'status'}><div><strong>{request.title}</strong>{request.message && <p>{request.message}</p>}</div><button type="button" onClick={() => onDismiss(request.id)} aria-label={t('extension.noticeClose', { title: request.title })}><Icon name="close" width="15" height="15" /></button></div>;
}

export function ExtensionDialogHost() {
	const { t } = useT();
	const bridge = useChatStore((s) => s.bridge);
	const [requests, setRequests] = useState<UiExtensionDialogRequest[]>([]);
	const [value, setValue] = useState('');
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const dialogRef = useRef<HTMLDialogElement>(null);
	const pendingId = useRef<string | null>(null);
	const activeId = useRef<string | null>(null);
	const fieldRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
	const closedIds = useRef(new Set<string>());
	const previousFocus = useRef<HTMLElement | null>(null);
	const active = requests.find((request) => request.kind !== 'notify');
	activeId.current = active?.id ?? null;
	const notices = requests.filter((request) => request.kind === 'notify');

	useEffect(() => {
		if (!active || !bridge) return;
		// Initialization can wait for extension input. Reveal its committed dialog
		// instead of waiting for the agent to become idle and deadlocking startup.
		let revealFrame: number | undefined;
		const frame = window.requestAnimationFrame(() => {
			revealFrame = window.requestAnimationFrame(() => {
				void bridge.notifyRendererReady().catch((reason: unknown) => {
					console.error('Failed to show the extension dialog', reason);
				});
			});
		});
		return () => {
			window.cancelAnimationFrame(frame);
			if (revealFrame !== undefined) window.cancelAnimationFrame(revealFrame);
		};
	}, [active?.id, bridge]);

	useEffect(() => {
		if (!bridge) return;
		let mounted = true;
		const unsubscribe = bridge.onExtensionDialog((request) => {
			if (mounted && !closedIds.current.has(request.id)) setRequests((current) => mergeRequests(current, [request]));
		});
		const unsubscribeClosed = bridge.onExtensionDialogClosed((id) => {
			closedIds.current.add(id);
			if (closedIds.current.size > 500) closedIds.current.delete(closedIds.current.values().next().value!);
			if (mounted) setRequests((current) => current.filter((request) => request.id !== id));
		});
		void bridge.getPendingExtensionDialogs().then((pendingRequests) => {
			if (mounted) setRequests((current) => mergeRequests(current, pendingRequests.filter((request) => !closedIds.current.has(request.id))));
		}).catch(() => {});
		return () => { mounted = false; unsubscribe(); unsubscribeClosed(); };
	}, [bridge]);

	useLayoutEffect(() => {
		setValue(active?.defaultValue ?? '');
		setError(null);
		setPending(false);
		pendingId.current = null;
		if (active) {
			if (!previousFocus.current && document.activeElement instanceof HTMLElement) previousFocus.current = document.activeElement;
			const dialog = dialogRef.current;
			// 插件安装会保持自己的原生模态框打开；扩展请求必须进入同一 top layer，
			// 否则普通 overlay 会被浏览器置为 inert，安装与确认就会互相等待。
			dialog?.showModal();
			const timer = window.setTimeout(() => (fieldRef.current ?? dialogRef.current)?.focus(), 0);
			return () => { window.clearTimeout(timer); dialog?.close(); };
		}
		if (previousFocus.current?.isConnected) previousFocus.current.focus();
		previousFocus.current = null;
	}, [active?.id]);

	useEffect(() => {
		if (!active?.timeout || active.timeout <= 0) return;
		const id = active.id;
		const timer = window.setTimeout(() => {
			setRequests((current) => current.filter((request) => request.id !== id));
			void bridge?.respondExtensionDialog(id, null).catch(() => {});
		}, active.timeout);
		return () => window.clearTimeout(timer);
	}, [active?.id, active?.timeout, bridge]);

	async function respond(id: string, response: string | boolean | null) {
		if (!bridge || pendingId.current !== null || activeId.current !== id) return;
		pendingId.current = id;
		setPending(true);
		setError(null);
		try {
			await bridge.respondExtensionDialog(id, response);
			setRequests((current) => current.filter((request) => request.id !== id));
		} catch (reason) {
			if (activeId.current === id) setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			if (pendingId.current === id) { pendingId.current = null; setPending(false); }
		}
	}

	function dismissNotice(id: string) {
		setRequests((current) => current.filter((request) => request.id !== id));
		void bridge?.respondExtensionDialog(id, null).catch(() => {});
	}

	function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (active) void respond(active.id, value);
	}

	function onDialogKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
		if (!active) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			void respond(active.id, active.kind === 'confirm' ? false : null);
			return;
		}
		if (event.key !== 'Tab') return;
		const elements = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])');
		if (!elements?.length) return;
		const first = elements[0];
		const last = elements[elements.length - 1];
		if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
		else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
	}

	return <>
		{notices.length > 0 && <div className="pd-extension-notifications" aria-label={t('extension.notifications')}>{notices.map((request) => <NotificationToast key={request.id} request={request} onDismiss={dismissNotice} />)}</div>}
		{active && <dialog ref={dialogRef} className="pd-extension-dialog" role="dialog" aria-modal="true" aria-labelledby="pd-extension-title" aria-describedby={active.message ? 'pd-extension-message' : undefined} tabIndex={-1} onKeyDown={onDialogKeyDown} onCancel={(event) => { event.preventDefault(); void respond(active.id, active.kind === 'confirm' ? false : null); }}>
		<header className="pd-extension-dialog-head"><span>{t('extension.request')}</span><h2 id="pd-extension-title">{active.title}</h2></header>
			{active.message && <p id="pd-extension-message" className="pd-extension-dialog-message">{active.message}</p>}
			{error && <div className="pd-extension-dialog-error" role="alert">{error}</div>}
			{active.kind === 'select' && <div className="pd-extension-options">{active.options?.length ? active.options.map((option, index) => <button key={`${index}-${option}`} type="button" disabled={pending} onClick={() => void respond(active.id, option)}>{option}</button>) : <p>{t('extension.noOptions')}</p>}</div>}
			{active.kind === 'confirm' && <div className="pd-extension-actions"><button type="button" disabled={pending} onClick={() => void respond(active.id, false)}>{t('extension.cancel')}</button><button type="button" className="is-primary" disabled={pending} onClick={() => void respond(active.id, true)}>{t('extension.confirm')}</button></div>}
			{(active.kind === 'input' || active.kind === 'editor') && <form onSubmit={onSubmit}>
				{active.kind === 'editor' ? <textarea ref={(node) => { fieldRef.current = node; }} value={value} onChange={(event) => setValue(event.target.value)} placeholder={active.placeholder} rows={10} aria-label={active.title} /> : <input ref={(node) => { fieldRef.current = node; }} value={value} onChange={(event) => setValue(event.target.value)} placeholder={active.placeholder} aria-label={active.title} />}
				<div className="pd-extension-actions"><button type="button" disabled={pending} onClick={() => void respond(active.id, null)}>{t('extension.cancel')}</button><button type="submit" className="is-primary" disabled={pending}>{t('extension.submit')}</button></div>
			</form>}
			{active.kind === 'select' && <div className="pd-extension-actions"><button type="button" disabled={pending} onClick={() => void respond(active.id, null)}>{t('extension.cancel')}</button></div>}
		</dialog>}
	</>;
}
