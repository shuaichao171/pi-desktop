import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	encodeQrMatrix,
	renderQrSvgPath,
	type RemoteAccessRole,
	type RemoteCloudflareMode,
	type RemotePairingCreated,
	type UiRemoteAccessConfig,
	type UiRemoteAccessState,
} from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT } from '../i18n';
import { Icon } from './Icons';
import { SettingsGroup, SettingsRow, SettingsSwitch } from './SettingsRows';
import { formatDate } from '../dateFormat';
import './remoteAccessPanel.css';

function QrCodeSvg({ value, label }: { value: string; label: string }) {
	const qr = useMemo(() => {
		try {
			const matrix = encodeQrMatrix(value);
			return { size: matrix.size, path: renderQrSvgPath(matrix) };
		} catch {
			return null;
		}
	}, [value]);

	if (!qr) return null;
	const quiet = 4;
	const viewSize = qr.size + quiet * 2;
	return (
		<div className="pd-remote-qr-frame">
			<svg
				role="img"
				aria-label={label}
				viewBox={`${-quiet} ${-quiet} ${viewSize} ${viewSize}`}
				xmlns="http://www.w3.org/2000/svg"
			>
				<rect x={-quiet} y={-quiet} width={viewSize} height={viewSize} fill="#ffffff" />
				<path d={qr.path} fill="#111111" />
			</svg>
		</div>
	);
}

export function RemoteAccessPanel() {
	const { t, locale } = useT();
	const bridge = useChatStore((s) => s.bridge);
	const [state, setState] = useState<UiRemoteAccessState | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [copiedKey, setCopiedKey] = useState<string | null>(null);

	// Editable drafts
	const [labelDraft, setLabelDraft] = useState('');
	const [portDraft, setPortDraft] = useState('47910');
	const [tailscalePortDraft, setTailscalePortDraft] = useState('443');
	const [cfTokenDraft, setCfTokenDraft] = useState('');
	const [cfHostnameDraft, setCfHostnameDraft] = useState('');
	const seededRef = useRef(false);

	// Pairing state (ephemeral: raw code stays only in memory while panel is open)
	const [pairRole, setPairRole] = useState<RemoteAccessRole>('full');
	const [pairEndpoint, setPairEndpoint] = useState('');
	const [pairDeviceLabel, setPairDeviceLabel] = useState('');
	const [createdPairing, setCreatedPairing] = useState<RemotePairingCreated | null>(null);

	useEffect(() => {
		const active = bridge;
		if (!active?.getRemoteAccessState) return;
		let cancelled = false;
		void active.getRemoteAccessState().then((next) => {
			if (!cancelled) setState(next);
		}).catch((err: unknown) => {
			if (!cancelled) setError(err instanceof Error ? err.message : String(err));
		});
		const unsubscribe = active.onRemoteAccessChanged?.((next) => {
			setState(next);
		});
		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	}, [bridge]);

	useEffect(() => {
		if (!state || seededRef.current) return;
		seededRef.current = true;
		setLabelDraft(state.config.machineLabel);
		setPortDraft(String(state.config.port));
		setTailscalePortDraft(String(state.config.tailscaleServePort));
		setCfHostnameDraft(state.config.cloudflarePublicHostname);
	}, [state]);

	useEffect(() => {
		if (!state?.endpoints.length) return;
		if (!pairEndpoint || !state.endpoints.some((e) => e.httpBaseUrl === pairEndpoint)) {
			const preferred =
				state.endpoints.find((e) => e.isDefault) ??
				state.endpoints.find((e) => e.kind !== 'loopback') ??
				state.endpoints[0];
			if (preferred) setPairEndpoint(preferred.httpBaseUrl);
		}
	}, [state?.endpoints, pairEndpoint]);

	const copyText = useCallback(async (key: string, text: string) => {
		try {
			await navigator.clipboard.writeText(text);
			setCopiedKey(key);
			setTimeout(() => setCopiedKey((curr) => (curr === key ? null : curr)), 1800);
		} catch {
			// clipboard unavailable
		}
	}, []);

	const saveConfig = useCallback(
		async (patch: Partial<UiRemoteAccessConfig>) => {
			if (!bridge?.setRemoteAccessConfig || busy) return;
			setBusy(true);
			setError(null);
			try {
				const next = await bridge.setRemoteAccessConfig(patch);
				setState(next);
				if (patch.cloudflareTunnelToken !== undefined) setCfTokenDraft('');
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(false);
			}
		},
		[bridge, busy],
	);

	const applyBasicSettings = useCallback(() => {
		const port = Number(portDraft);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			setError(t('settings.remote.invalidPort'));
			return;
		}
		void saveConfig({ machineLabel: labelDraft.trim(), port });
	}, [portDraft, labelDraft, saveConfig, t]);

	const applyCloudflareNamed = useCallback(() => {
		void saveConfig({
			cloudflareMode: 'named',
			...(cfTokenDraft.trim() ? { cloudflareTunnelToken: cfTokenDraft.trim() } : {}),
			cloudflarePublicHostname: cfHostnameDraft.trim(),
		});
	}, [cfTokenDraft, cfHostnameDraft, saveConfig]);

	const installCloudflared = useCallback(async () => {
		if (!bridge?.installCloudflared || busy) return;
		setBusy(true);
		setError(null);
		try {
			const next = await bridge.installCloudflared();
			setState(next);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, [bridge, busy]);

	const refreshNetwork = useCallback(async () => {
		if (!bridge?.refreshRemoteNetwork || busy) return;
		setBusy(true);
		setError(null);
		try {
			const next = await bridge.refreshRemoteNetwork();
			setState(next);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, [bridge, busy]);

	const createPairing = useCallback(async () => {
		if (!bridge?.createRemotePairing || busy) return;
		setBusy(true);
		setError(null);
		try {
			const created = await bridge.createRemotePairing({
				role: pairRole,
				...(pairEndpoint ? { endpointUrl: pairEndpoint } : {}),
				...(pairDeviceLabel.trim() ? { label: pairDeviceLabel.trim() } : {}),
			});
			setCreatedPairing(created);
			setPairDeviceLabel('');
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, [bridge, busy, pairRole, pairEndpoint, pairDeviceLabel]);

	const revokeGrant = useCallback(
		async (grantId: string) => {
			if (!bridge?.revokeRemotePairing || busy) return;
			setBusy(true);
			setError(null);
			try {
				const next = await bridge.revokeRemotePairing(grantId);
				setState(next);
				if (createdPairing?.grant.id === grantId) setCreatedPairing(null);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(false);
			}
		},
		[bridge, busy, createdPairing],
	);

	const revokeSession = useCallback(
		async (sessionId: string) => {
			if (!bridge?.revokeRemoteSession || busy) return;
			setBusy(true);
			setError(null);
			try {
				const next = await bridge.revokeRemoteSession(sessionId);
				setState(next);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(false);
			}
		},
		[bridge, busy],
	);

	const revokeAllSessions = useCallback(async () => {
		if (!bridge?.revokeAllRemoteSessions || busy) return;
		setBusy(true);
		setError(null);
		try {
			const next = await bridge.revokeAllRemoteSessions();
			setState(next);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, [bridge, busy]);

	const onlineCount = state?.sessions.filter((s) => s.connected).length ?? 0;
	const cf = state?.cloudflare;
	const ts = state?.tailscale;

	return (
		<div className="pd-remote-panel" data-setting="remote-access">
			<div className="pd-settings-section-head">
				<h2>{t('settings.remote.title')}</h2>
				<p>{t('settings.remote.description')}</p>
			</div>

			<SettingsGroup title={t('settings.remote.groupService')}>
				<div className="pd-remote-status-card">
					<div className="pd-remote-status-main">
						<span
							className={`pd-remote-dot${state?.running ? ' is-online' : state?.error ? ' is-error' : ''}`}
							aria-hidden="true"
						/>
						<div className="pd-remote-status-copy">
							<strong>
								{state?.running
									? t('settings.remote.statusRunning', { port: String(state.port ?? state.config.port) })
									: t('settings.remote.statusStopped')}
							</strong>
							<span>
								{state
									? t('settings.remote.statusMeta', {
											envId: state.environmentId.slice(0, 8),
											online: String(onlineCount),
											paired: String(state.sessions.length),
									  })
									: '…'}
							</span>
						</div>
					</div>
					<div className="pd-remote-inline-inputs">
						<button
							type="button"
							className="pd-btn"
							disabled={busy || !state}
							onClick={() => void refreshNetwork()}
						>
							<Icon name="refresh" width="14" height="14" />
							{t('settings.remote.refresh')}
						</button>
						<SettingsSwitch
							setting="remote-access-enabled"
							label={t('settings.remote.enable')}
							checked={state?.config.enabled ?? false}
							disabled={busy || !state}
							onChange={(enabled) => void saveConfig({ enabled })}
						/>
					</div>
				</div>

				<SettingsRow
					title={t('settings.remote.machineAndPort')}
					description={t('settings.remote.machineAndPortDesc')}
					stacked
				>
					<div className="pd-remote-inline-inputs">
						<input
							type="text"
							className="pd-remote-input is-wide"
							aria-label={t('settings.remote.machineLabel')}
							placeholder={t('settings.remote.machineLabelPlaceholder')}
							value={labelDraft}
							disabled={busy || !state}
							onChange={(e) => setLabelDraft(e.target.value)}
						/>
						<input
							type="number"
							min={1}
							max={65535}
							className="pd-remote-input is-port"
							aria-label={t('settings.remote.port')}
							value={portDraft}
							disabled={busy || !state}
							onChange={(e) => setPortDraft(e.target.value)}
						/>
						<button
							type="button"
							className="pd-btn"
							disabled={busy || !state}
							onClick={applyBasicSettings}
						>
							{t('settings.remote.apply')}
						</button>
					</div>
				</SettingsRow>

				<SettingsRow
					title={t('settings.remote.exposureMode')}
					description={t('settings.remote.exposureModeDesc')}
				>
					<div className="pd-remote-segment" role="group" aria-label={t('settings.remote.exposureMode')}>
						<button
							type="button"
							className={state?.config.exposureMode === 'lan' ? 'is-selected' : ''}
							disabled={busy || !state}
							onClick={() => void saveConfig({ exposureMode: 'lan' })}
						>
							{t('settings.remote.exposureLan')}
						</button>
						<button
							type="button"
							className={state?.config.exposureMode === 'local-only' ? 'is-selected' : ''}
							disabled={busy || !state}
							onClick={() => void saveConfig({ exposureMode: 'local-only' })}
						>
							{t('settings.remote.exposureLocal')}
						</button>
					</div>
				</SettingsRow>

				{state?.running && state.endpoints.length > 0 && (
					<SettingsRow title={t('settings.remote.endpoints')} stacked>
						<div className="pd-remote-endpoints-block">
							<div className="pd-remote-endpoints">
								{state.endpoints.map((ep) => (
									<div key={ep.id} className="pd-remote-endpoint-item">
										<div className="pd-remote-endpoint-info">
											<div className="pd-remote-endpoint-title">
												<span>{ep.label}</span>
												{ep.isHttps && <span className="pd-remote-badge is-https">HTTPS</span>}
												{!ep.isHttps && ep.kind !== 'loopback' && <span className="pd-remote-badge is-plaintext">{t('settings.remote.plaintextBadge')}</span>}
											</div>
											<span className="pd-remote-endpoint-url">{ep.httpBaseUrl}</span>
										</div>
										<button
											type="button"
											className="pd-btn"
											onClick={() => void copyText(ep.id, ep.httpBaseUrl)}
										>
											{copiedKey === ep.id ? t('settings.remote.copied') : t('settings.remote.copy')}
										</button>
									</div>
								))}
							</div>
							{state.endpoints.some((ep) => !ep.isHttps && ep.kind !== 'loopback') && (
								<p className="pd-remote-plaintext-note" role="note" data-role="plaintext-note">{t('settings.remote.plaintextNote')}</p>
							)}
						</div>
					</SettingsRow>
				)}
			</SettingsGroup>

			<SettingsGroup title={t('settings.remote.groupTunnels')} description={t('settings.remote.groupTunnelsDesc')}>
				<SettingsRow
					title={t('settings.remote.tailscaleTitle')}
					description={
						ts?.active && ts.url
							? t('settings.remote.tailscaleActive', { url: ts.url })
							: ts?.error
								? ts.error
								: ts?.available
									? t('settings.remote.tailscaleReady', { host: ts.magicDnsName ?? ts.tailnetIpv4 ?? 'tailnet' })
									: t('settings.remote.tailscaleMissing')
					}
				>
					<div className="pd-remote-inline-inputs">
						<input
							type="number"
							min={1}
							max={65535}
							className="pd-remote-input is-port"
							aria-label={t('settings.remote.tailscalePort')}
							value={tailscalePortDraft}
							disabled={busy || !state}
							onChange={(e) => setTailscalePortDraft(e.target.value)}
							onBlur={() => {
								const nextPort = Number(tailscalePortDraft);
								if (Number.isInteger(nextPort) && nextPort >= 1 && nextPort <= 65535 && nextPort !== state?.config.tailscaleServePort) {
									void saveConfig({ tailscaleServePort: nextPort });
								}
							}}
						/>
						<SettingsSwitch
							setting="remote-tailscale"
							label={t('settings.remote.tailscaleTitle')}
							checked={state?.config.tailscaleServeEnabled ?? false}
							disabled={busy || !state}
							onChange={(tailscaleServeEnabled) => void saveConfig({ tailscaleServeEnabled })}
						/>
					</div>
				</SettingsRow>

				<SettingsRow
					title={t('settings.remote.cloudflareTitle')}
					description={
						cf?.status === 'running' && cf.url
							? t('settings.remote.cloudflareRunning', { url: cf.url, protocol: cf.protocol ?? 'auto' })
							: cf?.status === 'installing'
								? t('settings.remote.cloudflareInstalling')
								: cf?.status === 'starting'
									? t('settings.remote.cloudflareStarting')
									: cf?.error
										? cf.error
										: cf?.binaryPath
											? t('settings.remote.cloudflareInstalled', { version: cf.version ?? 'ok' })
											: t('settings.remote.cloudflareMissing')
					}
					stacked
				>
					<div className="pd-remote-inline-inputs">
						<div className="pd-remote-segment" role="group" aria-label={t('settings.remote.cloudflareTitle')}>
							{(['off', 'quick', 'named'] as RemoteCloudflareMode[]).map((mode) => (
								<button
									key={mode}
									type="button"
									className={state?.config.cloudflareMode === mode ? 'is-selected' : ''}
									disabled={busy || !state}
									onClick={() => void saveConfig({ cloudflareMode: mode })}
								>
									{t(
										mode === 'off'
											? 'settings.remote.cfOff'
											: mode === 'quick'
												? 'settings.remote.cfQuick'
												: 'settings.remote.cfNamed',
									)}
								</button>
							))}
						</div>
						{!cf?.binaryPath && (
							<button
								type="button"
								className="pd-btn"
								disabled={busy || cf?.status === 'installing'}
								onClick={() => void installCloudflared()}
							>
								{cf?.status === 'installing'
									? t('settings.remote.cloudflareInstalling')
									: t('settings.remote.cloudflareInstallBtn')}
							</button>
						)}
					</div>
				</SettingsRow>

				{state?.config.cloudflareMode === 'named' && (
					<SettingsRow
						title={t('settings.remote.cfNamedConfig')}
						description={t('settings.remote.cfNamedConfigDesc')}
						stacked
					>
						<div className="pd-remote-inline-inputs">
							<input
								type="password"
								autoComplete="new-password"
								className="pd-remote-input is-wide"
								placeholder={
									state.config.hasCloudflareTunnelToken
										? t('settings.remote.cfTokenSavedPlaceholder')
										: t('settings.remote.cfTokenPlaceholder')
								}
								value={cfTokenDraft}
								disabled={busy}
								onChange={(e) => setCfTokenDraft(e.target.value)}
							/>
							<input
								type="text"
								className="pd-remote-input is-wide"
								placeholder={t('settings.remote.cfHostnamePlaceholder')}
								value={cfHostnameDraft}
								disabled={busy}
								onChange={(e) => setCfHostnameDraft(e.target.value)}
							/>
							<button
								type="button"
								className="pd-btn is-primary"
								disabled={busy}
								onClick={applyCloudflareNamed}
							>
								{t('settings.remote.apply')}
							</button>
						</div>
					</SettingsRow>
				)}
			</SettingsGroup>

			<SettingsGroup title={t('settings.remote.groupPairing')} description={t('settings.remote.groupPairingDesc')}>
				<SettingsRow title={t('settings.remote.createPairing')} stacked>
					<div className="pd-remote-inline-inputs">
						<select
							className="pd-settings-select"
							aria-label={t('settings.remote.pairRole')}
							value={pairRole}
							disabled={busy || !state?.running}
							onChange={(e) => setPairRole(e.target.value === 'read-only' ? 'read-only' : 'full')}
						>
							<option value="full">{t('settings.remote.roleFull')}</option>
							<option value="read-only">{t('settings.remote.roleReadOnly')}</option>
						</select>
						{state && state.endpoints.length > 0 && (
							<select
								className="pd-settings-select"
								aria-label={t('settings.remote.pairEndpoint')}
								value={pairEndpoint}
								disabled={busy || !state.running}
								onChange={(e) => setPairEndpoint(e.target.value)}
							>
								{state.endpoints.map((ep) => (
									<option key={ep.id} value={ep.httpBaseUrl}>
										{ep.label} · {ep.httpBaseUrl}
									</option>
								))}
							</select>
						)}
						<input
							type="text"
							className="pd-remote-input is-wide"
							placeholder={t('settings.remote.pairLabelPlaceholder')}
							value={pairDeviceLabel}
							disabled={busy || !state?.running}
							onChange={(e) => setPairDeviceLabel(e.target.value)}
						/>
						<button
							type="button"
							data-action="create-remote-pairing"
							className="pd-btn is-primary"
							disabled={busy || !state?.running}
							onClick={() => void createPairing()}
						>
							{t('settings.remote.generateQr')}
						</button>
					</div>
				</SettingsRow>

				{createdPairing && (
					<div className="pd-settings-group-pad">
						<div className="pd-remote-qr-box" data-testid="remote-pairing-qr">
							<QrCodeSvg value={createdPairing.pairingUrl} label={t('settings.remote.qrAlt')} />
							<div className="pd-remote-qr-details">
								<strong>{t('settings.remote.scanPrompt')}</strong>
								<p>{t('settings.remote.oneTimeHint')}</p>
								<div className="pd-remote-code-box">{createdPairing.pairingUrl}</div>
								<div className="pd-remote-qr-actions">
									<button
										type="button"
										className="pd-btn is-primary"
										onClick={() => void copyText('pairing-url', createdPairing.pairingUrl)}
									>
										{copiedKey === 'pairing-url'
											? t('settings.remote.copied')
											: t('settings.remote.copyPairingUrl')}
									</button>
									<button
										type="button"
										className="pd-btn"
										onClick={() => void copyText('pairing-code', createdPairing.code)}
									>
										{copiedKey === 'pairing-code'
											? t('settings.remote.copied')
											: t('settings.remote.copyCode')}
									</button>
									<button
										type="button"
										className="pd-btn"
										onClick={() => setCreatedPairing(null)}
									>
										{t('settings.remote.hideQr')}
									</button>
								</div>
							</div>
						</div>
					</div>
				)}

				{state && state.pairingGrants.length > 0 && (
					<div className="pd-remote-list">
						{state.pairingGrants.map((grant) => (
							<div key={grant.id} className="pd-remote-list-row">
								<div className="pd-remote-list-copy">
									<div className="pd-remote-list-title">
										<span>{grant.label}</span>
										<span className={`pd-remote-badge${grant.role === 'read-only' ? ' is-readonly' : ''}`}>
											{t(grant.role === 'read-only' ? 'settings.remote.roleReadOnly' : 'settings.remote.roleFull')}
										</span>
									</div>
									<span className="pd-remote-list-meta">
										{t('settings.remote.expiresAt', {
											time: formatDate(grant.expiresAt, locale, { time: true }) || grant.expiresAt,
										})}
									</span>
								</div>
								<button
									type="button"
									className="pd-btn"
									disabled={busy}
									onClick={() => void revokeGrant(grant.id)}
								>
									{t('settings.remote.revoke')}
								</button>
							</div>
						))}
					</div>
				)}
			</SettingsGroup>

			<SettingsGroup title={t('settings.remote.groupDevices')} description={t('settings.remote.groupDevicesDesc')}>
				{state && state.sessions.length > 0 ? (
					<>
						<div className="pd-remote-list">
							{state.sessions.map((session) => (
								<div key={session.sessionId} className="pd-remote-list-row">
									<div className="pd-remote-list-copy">
										<div className="pd-remote-list-title">
											<span
												className={`pd-remote-dot${session.connected ? ' is-online' : ''}`}
												aria-hidden="true"
											/>
											<span>{session.label}</span>
											{session.connected && (
												<span className="pd-remote-badge is-online">{t('settings.remote.online')}</span>
											)}
											<span className={`pd-remote-badge${session.role === 'read-only' ? ' is-readonly' : ''}`}>
												{t(session.role === 'read-only' ? 'settings.remote.roleReadOnly' : 'settings.remote.roleFull')}
											</span>
										</div>
										<span className="pd-remote-list-meta">
											{session.os !== 'unknown' ? `${session.os} · ` : ''}
											{session.remoteAddress ? `${session.remoteAddress} · ` : ''}
											{t('settings.remote.lastSeen', {
												time: formatDate(session.lastSeenAt, locale, { time: true }) || session.lastSeenAt,
											})}
										</span>
									</div>
									<button
										type="button"
										className="pd-btn"
										disabled={busy}
										onClick={() => void revokeSession(session.sessionId)}
									>
										{t('settings.remote.revokeDisconnect')}
									</button>
								</div>
							))}
						</div>
						<div className="pd-settings-group-pad">
							<button
								type="button"
								className="pd-btn"
								disabled={busy}
								onClick={() => void revokeAllSessions()}
							>
								{t('settings.remote.revokeAll')}
							</button>
						</div>
					</>
				) : (
					<div className="pd-remote-empty">{t('settings.remote.noDevices')}</div>
				)}
			</SettingsGroup>

			{(error || state?.error) && (
				<p className="pd-remote-feedback is-error" role="alert">
					{error ?? state?.error}
				</p>
			)}
		</div>
	);
}
