import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { UiExtensionDialogRequest, UiExtensionDialogResponse } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { useExtensionNoticeDisplayEnabled } from '../extensionNoticeDisplay';
import { useQuestionAutoResolutionEnabled, isQuestionAutoResolutionKind, planQuestionAutoResolution, formatQuestionCountdown } from '../extensionQuestionTimeout';
import { Icon } from './Icons';
import { ExtensionNotifications } from './ExtensionNotifications';
import { ApprovalCard } from './ApprovalCard';
import { ErrorDetails } from './ErrorDetails';
import './extensionRequests.css';

const ExtensionDialogContext = createContext<ReactNode>(null);

// Pending signal as a module-level store: AppShell sits ABOVE the context
// provider, so a context-only signal could never reach its own hook call.
// One host per window keeps the module state unambiguous.
let pendingRequest = false;
let anyPendingRequest = false;
const pendingListeners = new Set<() => void>();
function publishPendingRequests(current: boolean, any: boolean): void {
	pendingRequest = current;
	anyPendingRequest = any;
	for (const notify of pendingListeners) notify();
}
function subscribePendingRequest(listener: () => void): () => void {
	pendingListeners.add(listener);
	return () => { pendingListeners.delete(listener); };
}

/** True while a plugin/extension question for the OPEN conversation waits for an answer. */
export function useExtensionRequestPending(): boolean {
	return useSyncExternalStore(subscribePendingRequest, () => pendingRequest, () => false);
}

/** True while any conversation has a question waiting (attention chime; zcode per-task pending interactions). */
export function useAnyExtensionRequestPending(): boolean {
	return useSyncExternalStore(subscribePendingRequest, () => anyPendingRequest, () => false);
}

/** zcode per-task interactions: a question shows only while its conversation is open. */
function requestBelongsToConversation(request: UiExtensionDialogRequest, scope: { cwd: string; sessionId: string | null; sessionPath: string | null }): boolean {
	if (!request.scope) return true;
	if (request.scope.cwd !== scope.cwd) return false;
	if (request.scope.sessionPath && scope.sessionPath) return request.scope.sessionPath === scope.sessionPath;
	// The sessionId is stable across fresh-session persistence (sessionPath null → real path).
	return request.scope.sessionId == null || request.scope.sessionId === scope.sessionId;
}

function getActiveModal(): HTMLElement | null {
	const native = document.querySelectorAll<HTMLDialogElement>('dialog:modal');
	if (native.length) return native.item(native.length - 1);
	return [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')]
		.filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden' && !element.closest('[hidden], [inert], [aria-hidden="true"]')).at(-1) ?? null;
}

function mergeRequests(current: UiExtensionDialogRequest[], incoming: UiExtensionDialogRequest[]): UiExtensionDialogRequest[] {
	const byId = new Map(current.map((request) => [request.id, request]));
	for (const request of incoming) byId.set(request.id, request);
	return [...byId.values()];
}

/** Mount inside the composer so requests take up normal layout space above it. */
export function ExtensionDialogSlot() {
	const card = useContext(ExtensionDialogContext);
	return card ? <div className="pd-extension-slot">{card}</div> : null;
}

export function ExtensionDialogHost({ children, chatVisible, notificationTarget }: { children: ReactNode; chatVisible: boolean; notificationTarget: HTMLElement | null }) {
	const { t } = useT();
	const bridge = useChatStore((s) => s.bridge);
	const [queue, setQueue] = useState({ bridge, requests: [] as UiExtensionDialogRequest[] });
	const requests = queue.bridge === bridge ? queue.requests : [];
	const [value, setValue] = useState('');
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [collapsed, setCollapsed] = useState(false);
	const [modalTarget, setModalTarget] = useState<HTMLElement | null>(null);
	const cardRef = useRef<HTMLElement>(null);
	const pendingId = useRef<string | null>(null);
	const pendingFocus = useRef<{ id: string; scope: number; inside: boolean; version: number } | null>(null);
	const activeId = useRef<string | null>(null);
	const closedIds = useRef(new Set<string>());
	const generation = useRef(0);
	const currentBridge = useRef(bridge);
	currentBridge.current = bridge;
	const focusVersion = useRef(0);
	const titleId = useId();
	const messageId = useId();
	const bodyId = useId();
	const conversationCwd = useChatStore((s) => s.cwd);
	const conversationSessionId = useChatStore((s) => s.sessionId);
	const conversationSessionPath = useChatStore((s) => s.sessionPath);
	const belongsHere = (request: UiExtensionDialogRequest) => requestBelongsToConversation(request, { cwd: conversationCwd, sessionId: conversationSessionId, sessionPath: conversationSessionPath });
	const active = requests.find((request) => request.kind !== 'notify' && belongsHere(request));
	activeId.current = active?.id ?? null;
	const notices = requests.filter((request) => request.kind === 'notify');
	// The plugin-notice display setting governs toasts as well: turned off,
	// transient notifications never surface; dismissal state is untouched.
	const [noticesVisible] = useExtensionNoticeDisplayEnabled();
	const shownNotices = noticesVisible ? notices : [];
	const queuedCount = requests.filter((request) => request.kind !== 'notify' && belongsHere(request)).length - 1;
	// Question auto-resolution (zcode): only requests armed on arrival count;
	// turning the preference off disarms everything currently waiting.
	const [questionAutoResolution] = useQuestionAutoResolutionEnabled();
	const questionAutoResolutionRef = useRef(questionAutoResolution);
	questionAutoResolutionRef.current = questionAutoResolution;
	const autoEligibleIds = useRef(new Set<string>());
	const [autoCancelRemaining, setAutoCancelRemaining] = useState<number | null>(null);
	const respondRef = useRef((_id: string, _response: UiExtensionDialogResponse) => {});

	useEffect(() => {
		const onFocus = () => { focusVersion.current += 1; };
		document.addEventListener('focusin', onFocus);
		return () => document.removeEventListener('focusin', onFocus);
	}, []);

	useLayoutEffect(() => {
		// An open modal (settings, plugin install) makes the chat composer inert
		// and may itself be waiting for this answer. Render the card inside it.
		const updateTarget = () => setModalTarget(getActiveModal());
		updateTarget();
		const observer = new MutationObserver(updateTarget);
		observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'aria-modal', 'hidden', 'aria-hidden', 'inert'] });
		return () => observer.disconnect();
	}, []);

	function closeRequest(id: string, scope: number, submittedFocus?: { inside: boolean; version: number }) {
		if (generation.current !== scope || currentBridge.current !== bridge || closedIds.current.has(id)) return;
		// The backend may emit "closed" before the response promise resolves.
		const origin = submittedFocus ?? (pendingFocus.current?.id === id && pendingFocus.current.scope === scope ? pendingFocus.current : null);
		const focusedInside = activeId.current === id && (cardRef.current?.contains(document.activeElement)
			|| (origin?.inside && origin.version === focusVersion.current && document.activeElement === document.body));
		const lastFocusVersion = focusVersion.current;
		closedIds.current.add(id);
		if (closedIds.current.size > 500) closedIds.current.delete(closedIds.current.values().next().value!);
		setQueue((current) => current.bridge === bridge ? { ...current, requests: current.requests.filter((request) => request.id !== id) } : current);
		if (focusedInside) window.requestAnimationFrame(() => {
			// Only replace focus lost by removing this card. Do not interrupt a
			// user who has already moved on to typing in another field.
			if (generation.current !== scope || currentBridge.current !== bridge || focusVersion.current !== lastFocusVersion || document.activeElement !== document.body) return;
			const composer = document.querySelector<HTMLTextAreaElement>('.pd-composer-shell > textarea:not(:disabled)');
			if (composer?.getClientRects().length && !getActiveModal()) composer.focus({ preventScroll: true });
		});
	}

	useLayoutEffect(() => {
		const scope = ++generation.current;
		closedIds.current.clear();
		pendingId.current = null;
		pendingFocus.current = null;
		setPending(false);
		setQueue({ bridge, requests: [] });
		if (!bridge) return;
		let mounted = true;
		const isCurrent = () => mounted && scope === generation.current && currentBridge.current === bridge;
		const unsubscribe = bridge.onExtensionDialog((request) => {
			if (questionAutoResolutionRef.current && isQuestionAutoResolutionKind(request.kind)) autoEligibleIds.current.add(request.id);
			if (isCurrent() && !closedIds.current.has(request.id)) setQueue((current) => ({ bridge, requests: mergeRequests(current.bridge === bridge ? current.requests : [], [request]) }));
		});
		const unsubscribeClosed = bridge.onExtensionDialogClosed((id) => {
			if (isCurrent()) closeRequest(id, scope);
		});
		void bridge.getPendingExtensionDialogs().then((pendingRequests) => {
			if (isCurrent()) {
				for (const request of pendingRequests) {
					if (questionAutoResolutionRef.current && isQuestionAutoResolutionKind(request.kind)) autoEligibleIds.current.add(request.id);
				}
				setQueue((current) => ({ bridge, requests: mergeRequests(current.bridge === bridge ? current.requests : [], pendingRequests.filter((request) => !closedIds.current.has(request.id))) }));
			}
		}).catch(() => {});
		return () => {
			mounted = false;
			++generation.current;
			unsubscribe();
			unsubscribeClosed();
		};
	}, [bridge]);

	useLayoutEffect(() => {
		setValue(active?.defaultValue ?? '');
		setError(null);
		setPending(false);
		setCollapsed(false);
		pendingId.current = null;
		pendingFocus.current = null;
	}, [active?.id, bridge]);

	useEffect(() => {
		if (!active || !bridge) return;
		// Initialization can wait for input. Reveal the committed request before
		// the agent becomes idle so startup cannot deadlock.
		let revealFrame: number | undefined;
		const frame = window.requestAnimationFrame(() => {
			revealFrame = window.requestAnimationFrame(() => {
				void bridge.notifyRendererReady().catch((reason: unknown) => {
					console.error('Failed to show the extension request', reason);
				});
			});
		});
		return () => {
			window.cancelAnimationFrame(frame);
			if (revealFrame !== undefined) window.cancelAnimationFrame(revealFrame);
		};
	}, [active?.id, bridge]);

	useEffect(() => {
		if (!active?.timeout || active.timeout <= 0 || !bridge) return;
		const id = active.id;
		const scope = generation.current;
		const timer = window.setTimeout(() => {
			if (scope !== generation.current || currentBridge.current !== bridge || closedIds.current.has(id)) return;
			const responding = pendingId.current === id;
			closeRequest(id, scope);
			if (!responding) void bridge.respondExtensionDialog(id, null).catch(() => {});
		}, active.timeout);
		return () => window.clearTimeout(timer);
	}, [active?.id, active?.timeout, bridge]);

	useEffect(() => {
		// zcode semantics: the preference off cancels every pending countdown;
		// re-enabling only arms questions that arrive afterwards.
		if (!questionAutoResolution) {
			autoEligibleIds.current.clear();
			setAutoCancelRemaining(null);
		}
	}, [questionAutoResolution]);

	useEffect(() => {
		const request = active;
		if (!request || !bridge || !questionAutoResolution || !autoEligibleIds.current.has(request.id)) { setAutoCancelRemaining(null); return; }
		const startedAt = Date.now();
		let snoozed = false;
		let ticker: number | undefined;
		const stop = () => {
			if (ticker !== undefined) window.clearInterval(ticker);
			ticker = undefined;
			setAutoCancelRemaining(null);
		};
		const tick = () => {
			if (snoozed) return;
			const plan = planQuestionAutoResolution(Date.now() - startedAt);
			if (plan.state === 'expired') {
				stop();
				void Promise.resolve(respondRef.current(request.id, null)).catch(() => {});
				return;
			}
			setAutoCancelRemaining(plan.state === 'countdown' ? plan.remainingMs : null);
		};
		tick();
		ticker = window.setInterval(tick, 500);
		// The first interaction with the question permanently pauses its countdown.
		const onInteract = (event: Event) => {
			if (snoozed) return;
			const node = event.target;
			if (node instanceof Node && cardRef.current?.contains(node)) { snoozed = true; stop(); }
		};
		document.addEventListener('pointerdown', onInteract, true);
		document.addEventListener('focusin', onInteract, true);
		return () => {
			stop();
			document.removeEventListener('pointerdown', onInteract, true);
			document.removeEventListener('focusin', onInteract, true);
		};
	}, [active?.id, bridge, questionAutoResolution]);

	async function respond(id: string, response: UiExtensionDialogResponse) {
		if (!bridge || pendingId.current !== null || activeId.current !== id || closedIds.current.has(id)) return;
		const scope = generation.current;
		const submittedFocus = { inside: cardRef.current?.contains(document.activeElement) ?? false, version: focusVersion.current };
		pendingId.current = id;
		pendingFocus.current = { id, scope, ...submittedFocus };
		setPending(true);
		setError(null);
		try {
			await bridge.respondExtensionDialog(id, response);
			closeRequest(id, scope, submittedFocus);
		} catch (reason) {
			if (scope === generation.current && currentBridge.current === bridge && activeId.current === id && !closedIds.current.has(id)) setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			if (scope === generation.current && currentBridge.current === bridge && pendingId.current === id) { pendingId.current = null; pendingFocus.current = null; setPending(false); }
		}
	}
	respondRef.current = respond;

	function dismissNotice(id: string) {
		if (!bridge || closedIds.current.has(id)) return;
		closeRequest(id, generation.current);
		void bridge.respondExtensionDialog(id, null).catch(() => {});
	}

	function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (active) void respond(active.id, value);
	}

	function onCardKeyDown(event: KeyboardEvent<HTMLElement>) {
		if (!active || event.nativeEvent.isComposing) return;
		// Portals bypass the destination's React handlers. Preserve a custom
		// (non-<dialog>) modal's focus boundary while the card lives inside it.
		if (event.key === 'Tab' && modalTarget && !modalTarget.matches('dialog:modal')) {
			const elements = [...modalTarget.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], summary, [tabindex]')]
				.filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0
					&& getComputedStyle(element).visibility !== 'hidden' && !element.closest('[hidden], [inert], [aria-hidden="true"]'));
			const first = elements[0], last = elements.at(-1);
			if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
			else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
			return;
		}
		if (event.key !== 'Escape') return;
		event.preventDefault();
		event.stopPropagation();
		void respond(active.id, active.kind === 'confirm' ? false : null);
	}

	const card = active ? <section ref={cardRef} className={`pd-extension-request${collapsed ? ' is-collapsed' : ''}`} role="region" aria-labelledby={titleId} aria-describedby={!collapsed && active.message ? messageId : undefined} aria-busy={pending} onKeyDown={onCardKeyDown}>
		<header className="pd-extension-request-head">
			<Icon name="message" width="16" height="16" />
			<div className="pd-extension-request-heading"><span>{t('extension.request')}</span><h2 id={titleId}>{active.title}</h2></div>
			{queuedCount > 0 && <span className="pd-extension-request-count">{t('extension.queued', { count: queuedCount })}</span>}
			{autoCancelRemaining !== null && <span className="pd-extension-request-count" data-auto-cancel="question" title={t('extension.autoCancelTitle')}>{t('extension.autoCancelIn', { time: formatQuestionCountdown(autoCancelRemaining) })}</span>}
			<button type="button" className="pd-extension-request-toggle" aria-label={t(collapsed ? 'extension.expand' : 'extension.collapse')} aria-expanded={!collapsed} aria-controls={bodyId} onClick={() => setCollapsed((current) => !current)}><Icon name={collapsed ? 'chevronDown' : 'chevronUp'} width="16" height="16" /></button>
		</header>
		<div id={bodyId} className="pd-extension-request-body" hidden={collapsed}>
			{active.message && <p id={messageId} className="pd-extension-request-message">{active.message}</p>}
			{error && <div className="pd-extension-request-error" role="alert">{error}<ErrorDetails error={error} scope="approval" /></div>}
			{active.kind === 'select' && <div className="pd-extension-request-options">{active.options?.length ? active.options.map((option, index) => <button key={`${index}-${option}`} type="button" disabled={pending} onClick={() => void respond(active.id, option)}><span className="pd-extension-request-option-number" aria-hidden="true">{index + 1}</span><span>{option}</span><Icon name="chevronRight" width="14" height="14" /></button>) : <p>{t('extension.noOptions')}</p>}</div>}
			{active.kind === 'confirm' && (active.approval ? <ApprovalCard key={active.id} approval={active.approval} pending={pending} onRespond={decision => void respond(active.id, decision)} /> : <div className="pd-extension-request-actions"><button type="button" disabled={pending} onClick={() => void respond(active.id, false)}>{t('extension.cancel')}</button><button type="button" className="is-primary" disabled={pending} onClick={() => void respond(active.id, true)}>{t('extension.confirm')}</button></div>)}
			{(active.kind === 'input' || active.kind === 'editor') && <form onSubmit={onSubmit}>
				{active.kind === 'editor' ? <textarea value={value} onChange={(event) => setValue(event.target.value)} placeholder={active.placeholder} rows={3} aria-label={active.title} disabled={pending} /> : <input value={value} onChange={(event) => setValue(event.target.value)} placeholder={active.placeholder} aria-label={active.title} disabled={pending} />}
				<div className="pd-extension-request-actions"><button type="button" disabled={pending} onClick={() => void respond(active.id, null)}>{t('extension.cancel')}</button><button type="submit" className="is-primary" disabled={pending}>{t('extension.submit')}</button></div>
			</form>}
			{active.kind === 'select' && <div className="pd-extension-request-actions"><button type="button" disabled={pending} onClick={() => void respond(active.id, null)}>{t('extension.cancel')}</button></div>}
		</div>
	</section> : null;

	// The option card renders in the chat composer slot, or inside an open modal
	// that would otherwise leave the composer inert. Other main views never show
	// it; the pending signal stays independent of chatVisible so AppShell can
	// return to the conversation even while the card is hidden.
	const hasActiveRequest = Boolean(active);
	const hasAnyRequest = requests.some((request) => request.kind !== 'notify');
	useEffect(() => { publishPendingRequests(hasActiveRequest, hasAnyRequest); return () => publishPendingRequests(false, false); }, [hasActiveRequest, hasAnyRequest]);
	return <ExtensionDialogContext.Provider value={hasActiveRequest && chatVisible && !modalTarget ? card : null}>
		{children}
		{shownNotices.length > 0 && notificationTarget && createPortal(<ExtensionNotifications requests={shownNotices} onDismiss={dismissNotice} />, notificationTarget)}
		{card && modalTarget && createPortal(<div className="pd-extension-modal-slot">{card}</div>, modalTarget)}
	</ExtensionDialogContext.Provider>;
}
