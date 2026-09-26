import { useEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { operationFeedback, type OperationNotice } from '../operationFeedback';
import { useT } from '../i18n';
import { Icon } from './Icons';
import './operationFeedback.css';

function Notice({ notice }: { notice: OperationNotice }) {
	const { locale } = useT();
	const zh = locale === 'zh-CN';
	useEffect(() => {
		if (notice.kind !== 'success') return;
		const timer = setTimeout(() => operationFeedback.dismiss(notice.id), 4500);
		return () => clearTimeout(timer);
	}, [notice]);
	return <section className={`pd-operation-notice is-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'} aria-busy={notice.kind === 'pending'}>
		<div className="pd-operation-notice-heading"><strong>{notice.title}</strong><button type="button" aria-label={zh ? '关闭提示' : 'Dismiss notification'} onClick={() => operationFeedback.dismiss(notice.id)}><Icon name="close" width="14" height="14" /></button></div>
		{notice.detail && <details><summary>{zh ? '查看详情' : 'View details'}</summary><p>{notice.detail}</p></details>}
		{notice.retry && <button type="button" onClick={() => void notice.retry?.().catch(cause => operationFeedback.show({ ...notice, kind: 'error', detail: cause instanceof Error ? cause.message : String(cause) }))}>{zh ? '重试' : 'Retry'}</button>}
	</section>;
}

export function OperationFeedback() {
	const notices = useSyncExternalStore(operationFeedback.subscribe, operationFeedback.getSnapshot, operationFeedback.getSnapshot);
	return createPortal(<div className="pd-operation-feedback" aria-label="Notifications">{notices.map(notice => <Notice key={notice.id} notice={notice} />)}</div>, document.body);
}
