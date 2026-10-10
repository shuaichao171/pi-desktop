import type { ReactNode } from 'react';
import './settingsRows.css';

/** A titled card that groups related settings rows. */
export function SettingsGroup({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
	return <section className="pd-settings-group" aria-label={title}>
		<div className="pd-settings-group-head"><h3>{title}</h3>{description && <p>{description}</p>}</div>
		<div className="pd-settings-group-body">{children}</div>
	</section>;
}

/**
 * One setting: label and description on the left, the control on the right.
 * `stacked` puts wide controls (paths, sliders, grids) underneath instead.
 */
export function SettingsRow({ title, description, children, stacked = false, setting, labelFor, footer }: {
	title: string;
	description?: ReactNode;
	children?: ReactNode;
	stacked?: boolean;
	setting?: string;
	/** Renders the title as a <label> for this control id. */
	labelFor?: string;
	footer?: ReactNode;
}) {
	return <div className={`pd-settings-row${stacked ? ' is-stacked' : ''}`} data-setting={setting}>
		<div className="pd-settings-row-copy">
			{labelFor ? <label htmlFor={labelFor}>{title}</label> : <strong>{title}</strong>}
			{description && <p>{description}</p>}
		</div>
		{children !== undefined && <div className="pd-settings-row-control">{children}</div>}
		{footer && <div className="pd-settings-row-footer">{footer}</div>}
	</div>;
}

export function SettingsSwitch({ checked, label, disabled, setting, onChange }: { checked: boolean; label: string; disabled?: boolean; setting?: string; onChange(next: boolean): void }) {
	return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="pd-settings-switch" data-setting={setting} disabled={disabled} onClick={() => onChange(!checked)}>
		<span aria-hidden="true" />
	</button>;
}
