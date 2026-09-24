import { useT } from '../i18n';
import { useChatStore } from '../store';
import { HoverTooltip } from './HoverTooltip';
import { Icon } from './Icons';

export interface HistoryNavigationProps {
	canGoBack: boolean;
	canGoForward: boolean;
	navigating: boolean;
	onGoBack(): void;
	onGoForward(): void;
}

export function HistoryNavigation({ canGoBack, canGoForward, navigating, onGoBack, onGoForward }: HistoryNavigationProps) {
	const { t } = useT();
	const platform = useChatStore((state) => state.appInfo?.platform);
	return <div className="pd-history-navigation" role="group" aria-label={t('sidebar.historyNavigation')} aria-busy={navigating}>
		<HoverTooltip title={t('sidebar.historyBack')} shortcut={platform === 'darwin' ? '⌘[' : 'Ctrl+['}><button type="button" className="pd-icon-button pd-history-back" aria-label={t('sidebar.historyBack')} disabled={!canGoBack || navigating} onClick={onGoBack}><Icon name="arrowLeft" width="16" height="16" /></button></HoverTooltip>
		<HoverTooltip title={t('sidebar.historyForward')} shortcut={platform === 'darwin' ? '⌘]' : 'Ctrl+]'}><button type="button" className="pd-icon-button pd-history-forward" aria-label={t('sidebar.historyForward')} disabled={!canGoForward || navigating} onClick={onGoForward}><Icon name="arrowRight" width="16" height="16" /></button></HoverTooltip>
	</div>;
}
