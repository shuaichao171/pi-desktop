import type { UiMessage } from '@pidesktop/shared';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function MessageItem({ message }: { message: UiMessage }) {
	if (message.role === 'user') {
		return (
			<div className="pd-message-row is-user">
				<div className="pd-message-column"><div className="pd-user-bubble"><p>{message.text}</p></div></div>
			</div>
		);
	}

	if (!message.text && message.status === 'done') return null;

	return (
		<div className="pd-message-row is-assistant">
			<div className="pd-message-column">
				<div className="pd-assistant-heading"><span className="pd-assistant-mark">π</span><span>Pi</span></div>
				<div className="pd-markdown"><Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown></div>
				{message.status === 'streaming' && <span className="pd-stream-cursor" aria-label="正在生成">▍</span>}
				{message.status === 'error' && <div className="pd-message-interrupted">{message.errorMessage || '已中断'}</div>}
			</div>
		</div>
	);
}
