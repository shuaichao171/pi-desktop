import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { UiMessage } from '@pidesktop/shared';
import { useT } from '../i18n';
import { useDisclosureChoice } from '../conversationDisclosure';
import { ActivityDisclosure, ActivityLabel } from './ActivityDisclosure';
import { Icon } from './Icons';
import { ConversationMarkdown } from './ConversationMarkdown';
import { StreamingContentContext } from '../streamingContent';

/** The collapsed summary follows the newest line, zcode-style. */
export function thinkingPreviewLine(thinking: string): string | null {
	const lines = thinking.replace(/\r\n?/g, '\n').split('\n');
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const text = lines[index]!.trim();
		if (text.length > 0) return text;
	}
	return null;
}

export function ThinkingActivity({ message }: { message: UiMessage }) {
	const { t } = useT();
	const detailId = useId();
	const [userExpanded, setUserExpanded] = useDisclosureChoice(`thinking:${message.id}`);
	const outputRef = useRef<HTMLDivElement>(null);
	const followsOutput = useRef(true);
	const previewRef = useRef<HTMLSpanElement>(null);
	const [previewOverflows, setPreviewOverflows] = useState(false);
	const thinking = message.thinking ?? '';
	const status = message.thinkingStatus ?? (message.status === 'streaming' ? 'streaming' : 'done');
	const active = status === 'streaming';
	const hasContent = Boolean(thinking.trim());
	// Reasoning stays folded by default, including while streaming; the
	// collapsed row previews the newest line so the thought stays visible.
	const expanded = hasContent && (userExpanded ?? false);
	const label = t('message.thinking.' + status);
	const preview = !expanded ? thinkingPreviewLine(thinking) : null;
	useLayoutEffect(() => {
		if (active && expanded && followsOutput.current && outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
	}, [active, expanded, thinking]);
	useLayoutEffect(() => {
		const viewport = previewRef.current;
		if (!viewport || preview === null) { setPreviewOverflows(false); return; }
		// Completed previews read from the line start; live previews keep the
		// newest tokens visible by holding the single-line viewport at its end.
		viewport.scrollLeft = active ? viewport.scrollWidth : 0;
		setPreviewOverflows(viewport.scrollWidth > viewport.clientWidth + 1);
	}, [active, preview]);
	return (
		<div className={'pd-thinking-activity is-' + status}>
			{hasContent ? <button type="button" className="pd-thinking-summary" aria-expanded={expanded} aria-controls={detailId} onClick={() => setUserExpanded(!expanded)}>
				<Icon name="brain" width="15" height="15" />
				<ActivityLabel active={active}>{label}</ActivityLabel>
				{preview !== null && <span ref={previewRef} className={'pd-thinking-preview' + (previewOverflows ? ' is-overflow' : '')}><span>{preview}</span></span>}
				<Icon name="chevronDown" className={'pd-chevron' + (expanded ? ' is-open' : '')} width="14" height="14" />
			</button> : <div className="pd-thinking-summary" role="status"><Icon name="brain" width="15" height="15" /><ActivityLabel active={active}>{label}</ActivityLabel></div>}
			<ActivityDisclosure id={detailId} expanded={expanded}>
				<div className="pd-thinking-content">
					<div ref={outputRef} className="pd-markdown pd-thinking-markdown" onScroll={() => {
						const node = outputRef.current;
						if (node) followsOutput.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
					}}><StreamingContentContext.Provider value={active}><ConversationMarkdown>{thinking}</ConversationMarkdown></StreamingContentContext.Provider></div>
					{message.thinkingTruncated && <p className="pd-activity-note">{t('message.thinking.truncated')}</p>}
				</div>
			</ActivityDisclosure>
		</div>
	);
}
