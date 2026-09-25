import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { UiMessage } from '@pidesktop/shared';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useT } from '../i18n';
import { ActivityDisclosure, ActivityLabel } from './ActivityDisclosure';
import { Icon } from './Icons';

export function ThinkingActivity({ message }: { message: UiMessage }) {
	const { t } = useT();
	const detailId = useId();
	const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
	const outputRef = useRef<HTMLDivElement>(null);
	const followsOutput = useRef(true);
	const thinking = message.thinking ?? '';
	const status = message.thinkingStatus ?? (message.status === 'streaming' ? 'streaming' : 'done');
	const active = status === 'streaming';
	const hasContent = Boolean(thinking.trim());
	const expanded = hasContent && (userExpanded ?? active);
	const label = t('message.thinking.' + status);
	useLayoutEffect(() => {
		if (active && expanded && followsOutput.current && outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
	}, [active, expanded, thinking]);
	return (
		<div className={'pd-thinking-activity is-' + status}>
			{hasContent ? <button type="button" className="pd-thinking-summary" aria-expanded={expanded} aria-controls={detailId} onClick={() => setUserExpanded(!expanded)}>
				<Icon name="brain" width="15" height="15" />
				<ActivityLabel active={active}>{label}</ActivityLabel>
				<Icon name="chevronDown" className={'pd-chevron' + (expanded ? ' is-open' : '')} width="14" height="14" />
			</button> : <div className="pd-thinking-summary" role="status"><Icon name="brain" width="15" height="15" /><ActivityLabel active={active}>{label}</ActivityLabel></div>}
			<ActivityDisclosure id={detailId} expanded={expanded}>
				<div className="pd-thinking-content">
					<div ref={outputRef} className="pd-markdown pd-thinking-markdown" onScroll={() => {
						const node = outputRef.current;
						if (node) followsOutput.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
					}}><Markdown remarkPlugins={[remarkGfm]}>{thinking}</Markdown></div>
					{message.thinkingTruncated && <p className="pd-activity-note">{t('message.thinking.truncated')}</p>}
				</div>
			</ActivityDisclosure>
		</div>
	);
}
