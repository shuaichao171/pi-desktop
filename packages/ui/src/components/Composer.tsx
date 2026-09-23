import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useChatStore } from '../store';
import { Icon } from './Icons';

type BusyBehavior = 'steer' | 'followUp';

export function Composer() {
	const [text, setText] = useState('');
	const [sending, setSending] = useState(false);
	const [submissionError, setSubmissionError] = useState<string | null>(null);
	const textRef = useRef('');
	const draftsRef = useRef(new Map<string, string>());
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const status = useChatStore((s) => s.status);
	const model = useChatStore((s) => s.model);
	const queuedCount = useChatStore((s) => s.queuedCount);
	const sessionPath = useChatStore((s) => s.sessionPath);
	const sessionId = useChatStore((s) => s.sessionId);
	const send = useChatStore((s) => s.send);
	const abort = useChatStore((s) => s.abort);
	const draftKey = sessionPath ?? sessionId ?? 'new';
	const currentKeyRef = useRef(draftKey);
	const busy = status === 'busy';
	const unavailable = status === 'starting' || status === 'uninitialized' || status === 'error';
	const canSubmit = Boolean(text.trim()) && !sending && !unavailable;

	useEffect(() => {
		if (currentKeyRef.current === draftKey) return;
		draftsRef.current.set(currentKeyRef.current, textRef.current);
		const nextText = draftsRef.current.get(draftKey) ?? '';
		currentKeyRef.current = draftKey;
		textRef.current = nextText;
		setText(nextText);
		setSubmissionError(null);
	}, [draftKey]);

	useLayoutEffect(() => {
		const textarea = textareaRef.current;
		if (!textarea) return;
		textarea.style.height = 'auto';
		textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
	}, [text]);

	async function submit(behavior?: BusyBehavior): Promise<void> {
		const value = textRef.current.trim();
		if (!value || sending || unavailable) return;
		const submittedKey = currentKeyRef.current;
		setSending(true);
		setSubmissionError(null);
		try {
			await send(value, busy ? (behavior ?? 'followUp') : undefined);
			draftsRef.current.set(submittedKey, '');
			if (currentKeyRef.current === submittedKey && textRef.current.trim() === value) {
				textRef.current = '';
				setText('');
			}
		} catch (error) {
			setSubmissionError(error instanceof Error ? error.message : String(error));
		} finally {
			setSending(false);
		}
	}

	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
		if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
		event.preventDefault();
		void submit(busy && (event.ctrlKey || event.metaKey) ? 'steer' : undefined);
	}

	return (
		<div className="pd-composer-dock">
			<div className="pd-composer-wrap">
				{submissionError && <div className="pd-composer-error" role="alert">发送失败：{submissionError}</div>}
				<div className="pd-composer-shell">
					<textarea
						ref={textareaRef}
						value={text}
						rows={2}
						placeholder={unavailable ? '正在连接 Pi…' : busy ? '继续输入。发送后排队，或立即引导当前任务…' : '描述你想完成的工作…'}
						aria-label="给 Pi 发消息"
						disabled={unavailable}
						onChange={(event) => {
							textRef.current = event.target.value;
							setText(event.target.value);
						}}
						onKeyDown={onKeyDown}
					/>
					<div className="pd-composer-toolbar">
						<div className="pd-composer-meta">
							{model && <span className="pd-model-chip" title={model}>{model}</span>}
							<span className="pd-keyboard-hint">{busy ? queuedCount > 0 ? `已排队 ${queuedCount} 条 · Ctrl+Enter 立即引导` : 'Enter 排队 · Ctrl+Enter 立即引导' : 'Enter 发送 · Shift+Enter 换行'}</span>
						</div>
						<div className="pd-composer-actions">
							{busy && (
								<>
									<button type="button" className="pd-composer-action" onClick={() => void abort().catch((error: unknown) => setSubmissionError(error instanceof Error ? error.message : String(error)))} title="停止当前任务" aria-label="停止当前任务"><Icon name="square" width="16" height="16" /><span>停止</span></button>
									<button type="button" className="pd-composer-action pd-steer-action" onClick={() => void submit('steer')} disabled={!canSubmit} title="立即引导当前任务（Ctrl+Enter）">立即引导</button>
								</>
							)}
							<button type="button" className="pd-send-button" onClick={() => void submit(busy ? 'followUp' : undefined)} disabled={!canSubmit} title={busy ? '排队发送（Enter）' : '发送（Enter）'}><span>{sending ? '发送中' : busy ? '排队发送' : '发送'}</span><Icon name="arrowUp" width="16" height="16" /></button>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
