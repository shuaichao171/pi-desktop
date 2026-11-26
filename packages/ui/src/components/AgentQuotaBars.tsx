import type { UiAgentQuotaWindow } from '@pidesktop/shared';
import { useT } from '../i18n';
import { agentQuotaLevel, agentQuotaWindowLabel, formatAgentQuotaPercent, formatAgentQuotaReset } from '../agentQuotaDisplay';
import './agentQuotaBars.css';

/**
 * Plan limit windows as aligned rows: name, usage bar, share used and reset time.
 * Shared by the Agents settings card and the line under the composer.
 * Spans only, so it can sit inside the composer's refresh button.
 */
export function AgentQuotaBars({ windows, className }: { windows: UiAgentQuotaWindow[]; className?: string }) {
	const { t, locale } = useT();
	return <span className={`pd-agent-quota-bars${className ? ` ${className}` : ''}`} role="list">
		{windows.map((window, index) => {
			const label = agentQuotaWindowLabel(window, t);
			return <span key={`${window.kind}-${window.group ?? ''}-${window.label ?? ''}-${index}`} role="listitem" className={`pd-agent-quota-row is-${agentQuotaLevel(window)}`} data-kind={window.kind}>
				<span className="pd-agent-quota-label">{label}</span>
				<span className="pd-agent-quota-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(window.usedPercent)} aria-label={label}><span style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }} /></span>
				<span className="pd-agent-quota-value">{t('agentQuota.used', { percent: formatAgentQuotaPercent(window.usedPercent) })}</span>
				<span className="pd-agent-quota-reset">{window.resetsAt ? t('agentQuota.resets', { time: formatAgentQuotaReset(window.resetsAt, locale) }) : ''}</span>
			</span>;
		})}
	</span>;
}
