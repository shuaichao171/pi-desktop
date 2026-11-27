import { useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { UiWindowClosePrompt, UiWindowClosePromptResponse } from '@pidesktop/shared';
import { useT } from '../i18n';
import { Icon } from './Icons';
import './windowCloseDialog.css';

export interface WindowCloseDialogProps {
	prompt: UiWindowClosePrompt;
	onRespond(response: UiWindowClosePromptResponse): void;
}

/**
 * In-app confirmation modal shown on Windows when the user closes the window
 * while conversations or automations are running. Replaces Electron's native
 * MessageBox so theme, typography, keyboard cancel, and tray options match
 * the desktop workbench.
 */
export function WindowCloseDialog({ prompt, onRespond }: WindowCloseDialogProps) {
	const { t } = useT();
	const titleId = useId();
	const descId = useId();
	const dialogRef = useRef<HTMLDialogElement>(null);
	const initialFocusRef = useRef<HTMLButtonElement>(null);
	const lockRef = useRef(false);
	const [remember, setRemember] = useState(false);

	useEffect(() => {
		const node = dialogRef.current;
		if (node && !node.open && typeof node.showModal === 'function') node.showModal();
		initialFocusRef.current?.focus();
		return () => {
			if (node?.open && typeof node.close === 'function') node.close();
		};
	}, []);

	function submit(action: UiWindowClosePromptResponse['action']) {
		if (lockRef.current) return;
		lockRef.current = true;
		if (dialogRef.current?.open && typeof dialogRef.current.close === 'function') {
			dialogRef.current.close();
		}
		onRespond({
			id: prompt.id,
			action,
			...(action !== 'cancel' && prompt.allowRemember && remember ? { remember: true } : {}),
		});
	}

	function handleBackdropClick(event: MouseEvent<HTMLDialogElement>) {
		if (event.target === dialogRef.current) submit('cancel');
	}

	const isTrayDefault = prompt.allowRemember && prompt.closeBehavior === 'tray';
	const descriptionKey = !prompt.allowRemember
		? 'closeDialog.descriptionMulti'
		: isTrayDefault
			? 'closeDialog.descriptionTray'
			: 'closeDialog.descriptionQuit';

	const content = (
		<dialog
			ref={dialogRef}
			className="pd-close-dialog"
			role="dialog"
			aria-modal="true"
			data-close-behavior={prompt.closeBehavior}
			aria-labelledby={titleId}
			aria-describedby={descId}
			onCancel={(event) => {
				event.preventDefault();
				submit('cancel');
			}}
			onClick={handleBackdropClick}
		>
			<div className="pd-close-dialog-card">
				<header className="pd-close-dialog-head">
					<span className={`pd-close-dialog-badge ${isTrayDefault ? 'is-tray' : 'is-quit'}`} aria-hidden="true">
						<Icon name={isTrayDefault ? 'dockTop' : 'alert'} width="18" height="18" />
					</span>
					<div className="pd-close-dialog-heading">
						<h2 id={titleId}>{t('closeDialog.title')}</h2>
						<p id={descId}>{t(descriptionKey)}</p>
					</div>
					<button
						type="button"
						className="pd-icon-button pd-close-dialog-dismiss"
						aria-label={t('closeDialog.cancel')}
						onClick={() => submit('cancel')}
					>
						<Icon name="close" width="15" height="15" />
					</button>
				</header>

				{prompt.allowRemember && (
					<div className="pd-close-dialog-body">
						{prompt.stopIdleAgentsOnTrayHide && (
							<div className="pd-close-dialog-note" data-role="idle-agent-note">
								<Icon name="cpu" width="14" height="14" aria-hidden="true" />
								<span>{t('closeDialog.idleAgentNote')}</span>
							</div>
						)}
						<label className="pd-close-dialog-remember">
							<input
								type="checkbox"
								checked={remember}
								onChange={(event) => setRemember(event.target.checked)}
							/>
							<span className="pd-close-dialog-check" aria-hidden="true">
								<Icon name="check" width="11" height="11" />
							</span>
							<span className="pd-close-dialog-remember-copy">
								<strong>{t('closeDialog.remember')}</strong>
								<span>{t('closeDialog.rememberHint')}</span>
							</span>
						</label>
					</div>
				)}

				<footer className="pd-close-dialog-footer">
					{prompt.allowRemember ? (
						<>
							<button
								ref={isTrayDefault ? undefined : initialFocusRef}
								type="button"
								className="pd-btn is-ghost pd-close-dialog-cancel"
								data-action="cancel"
								onClick={() => submit('cancel')}
							>
								{t('closeDialog.cancel')}
							</button>
							{isTrayDefault ? (
								<>
									<button
										type="button"
										className="pd-btn is-danger"
										data-action="quit"
										onClick={() => submit('quit')}
									>
										{t('closeDialog.quitAnyway')}
									</button>
									<button
										ref={initialFocusRef}
										type="button"
										className="pd-btn is-primary"
										data-action="tray"
										onClick={() => submit('tray')}
									>
										{t('closeDialog.minimizeToTray')}
									</button>
								</>
							) : (
								<>
									<button
										type="button"
										className="pd-btn"
										data-action="tray"
										onClick={() => submit('tray')}
									>
										{t('closeDialog.minimizeToTray')}
									</button>
									<button
										type="button"
										className="pd-btn is-danger"
										data-action="quit"
										onClick={() => submit('quit')}
									>
										{t('closeDialog.quit')}
									</button>
								</>
							)}
						</>
					) : (
						<>
							<button
								ref={initialFocusRef}
								type="button"
								className="pd-btn"
								data-action="cancel"
								onClick={() => submit('cancel')}
							>
								{t('closeDialog.cancel')}
							</button>
							<button
								type="button"
								className="pd-btn is-danger"
								data-action="quit"
								onClick={() => submit('quit')}
							>
								{t('closeDialog.quit')}
							</button>
						</>
					)}
				</footer>
			</div>
		</dialog>
	);

	return typeof document !== 'undefined' && document.body ? createPortal(content, document.body) : content;
}
