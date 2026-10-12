import { useCallback, useEffect, useRef, useState } from 'react';
import type { UiCloudSyncBackupInfo, UiCloudSyncConfig, UiCloudSyncKind, UiCloudSyncState } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT, type Locale } from '../i18n';
import './modelSettingsPanel.css';

const KINDS: { value: UiCloudSyncKind; labelKey: string }[] = [
	{ value: 'webdav', labelKey: 'settings.cloudSyncWebdav' },
	{ value: 's3', labelKey: 'settings.cloudSyncS3' },
	{ value: 'r2', labelKey: 'settings.cloudSyncR2' },
];
const DEFAULT_REMOTE_PATH = 'providers-backup.json';

function formatTime(iso: string, locale: Locale): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	// toLocaleString renders in the local time zone, matching cc-switch's
	// "uploaded at" behavior for remote backups.
	return date.toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatSize(bytes: number | null): string {
	if (bytes === null) return '—';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

const dash = (value: number | null): string => value === null ? '—' : String(value);

/**
 * Cloud backup for the provider database (models.json / auth.json /
 * model-prefs.json) to WebDAV, S3, or Cloudflare R2. Secrets never leave the
 * main process: blank password/secret fields keep the stored values, and the
 * flags hasPassword / hasSecret only tell the renderer whether one exists.
 */
export function CloudSyncPanel({ disabled }: { disabled: boolean }) {
	const { t, locale } = useT();
	const bridge = useChatStore((state) => state.bridge);
	const refreshProviders = useChatStore((state) => state.refreshModelProviders);
	const refreshModels = useChatStore((state) => state.refreshModels);
	const refreshAuth = useChatStore((state) => state.refreshProviderAuth);
	const [state, setState] = useState<UiCloudSyncState | null>(null);
	const [kind, setKind] = useState<UiCloudSyncKind>('webdav');
	const [autoSync, setAutoSync] = useState(true);
	const [remotePath, setRemotePath] = useState(DEFAULT_REMOTE_PATH);
	const [webdav, setWebdav] = useState({ url: '', username: '', password: '' });
	const [s3, setS3] = useState({ endpoint: '', region: 'us-east-1', bucket: '', accessKeyId: '', secret: '' });
	const [r2, setR2] = useState({ accountId: '', bucket: '', accessKeyId: '', secret: '' });
	const [busy, setBusy] = useState<'test' | 'save' | 'upload' | 'download' | 'restore' | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [feedback, setFeedback] = useState<string | null>(null);
	const [remote, setRemote] = useState<UiCloudSyncBackupInfo | null>(null);
	const applied = useRef(false);

	useEffect(() => {
		const active = bridge;
		if (!active) return;
		let cancelled = false;
		void active.getCloudSyncState().then((value) => { if (!cancelled) setState(value); }).catch(() => {});
		const unsubscribe = active.onCloudSyncChanged((value) => setState(value));
		return () => { cancelled = true; unsubscribe(); };
	}, [bridge]);

	// Seed the form from the stored configuration exactly once so typing is
	// never clobbered by background status broadcasts.
	useEffect(() => {
		if (applied.current || !state?.config) return;
		applied.current = true;
		const config = state.config;
		setKind(config.kind);
		setAutoSync(config.autoSync);
		setRemotePath(config.remotePath || DEFAULT_REMOTE_PATH);
		if (config.webdav) setWebdav({ url: config.webdav.url, username: config.webdav.username, password: '' });
		if (config.s3) setS3({ endpoint: config.s3.endpoint, region: config.s3.region, bucket: config.s3.bucket, accessKeyId: config.s3.accessKeyId, secret: '' });
		if (config.r2) setR2({ accountId: config.r2.accountId, bucket: config.r2.bucket, accessKeyId: config.r2.accessKeyId, secret: '' });
	}, [state]);

	const stored = state?.config ?? null;
	const secretSaved = (kind === 'webdav' ? stored?.webdav?.hasPassword : kind === 's3' ? stored?.s3?.hasSecret : stored?.r2?.hasSecret) ?? false;
	const buildConfig = useCallback((): UiCloudSyncConfig => ({
		kind,
		autoSync,
		remotePath: remotePath.trim() || DEFAULT_REMOTE_PATH,
		...(kind === 'webdav' ? { webdav: { url: webdav.url.trim(), username: webdav.username.trim(), ...(webdav.password ? { password: webdav.password } : {}), hasPassword: secretSaved } } : {}),
		...(kind === 's3' ? { s3: { endpoint: s3.endpoint.trim(), region: s3.region.trim() || 'us-east-1', bucket: s3.bucket.trim(), accessKeyId: s3.accessKeyId.trim(), ...(s3.secret ? { secretAccessKey: s3.secret } : {}), hasSecret: secretSaved } } : {}),
		...(kind === 'r2' ? { r2: { accountId: r2.accountId.trim(), bucket: r2.bucket.trim(), accessKeyId: r2.accessKeyId.trim(), ...(r2.secret ? { secretAccessKey: r2.secret } : {}), hasSecret: secretSaved } } : {}),
	}), [kind, autoSync, remotePath, webdav, s3, r2, secretSaved]);

	async function runAction(action: 'test' | 'save' | 'upload' | 'download' | 'restore', work: () => Promise<void>): Promise<void> {
		setBusy(action); setError(null); setFeedback(null);
		try { await work(); }
		catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
		finally { setBusy(null); }
	}

	const test = () => runAction('test', async () => {
		if (!bridge) return;
		const result = await bridge.testCloudSyncConnection(buildConfig());
		const suffix = result.remote?.uploadedAt ? ` · ${t('settings.cloudSyncRemoteAt', { time: formatTime(result.remote.uploadedAt, locale) })}` : '';
		if (result.ok) setFeedback(`${result.message}${suffix}`);
		else throw new Error(result.message);
	});

	const save = () => runAction('save', async () => {
		if (!bridge) return;
		const next = await bridge.saveCloudSyncConfig(buildConfig());
		setState(next); setRemote(null); setFeedback(t('settings.cloudSyncSaved'));
	});

	const upload = () => runAction('upload', async () => {
		if (!bridge) return;
		const result = await bridge.uploadCloudSyncBackup();
		setFeedback(t('settings.cloudSyncUploaded', { size: formatSize(result.bytes), providers: result.providers, models: result.models, credentials: result.credentials }));
	});

	const download = () => runAction('download', async () => {
		if (!bridge) return;
		const info = await bridge.inspectCloudSyncBackup();
		setRemote(info);
		if (info.uploadedAt === null) setFeedback(t('settings.cloudSyncNoBackup'));
	});

	const confirmRestore = () => runAction('restore', async () => {
		if (!bridge) return;
		const result = await bridge.restoreCloudSyncBackup();
		setRemote(null);
		setFeedback(t('settings.cloudSyncRestored', { providers: result.providers, models: result.models, credentials: result.credentials }));
		// The restored database replaces providers, credentials, and visibility.
		await Promise.allSettled([refreshProviders(), refreshModels(), refreshAuth()]);
	});

	const locked = disabled || !bridge || busy !== null;
	const inputProps = { disabled: locked, autoComplete: 'off' as const };
	const status = state?.status;
	const summaryMeta = state?.configured
		? `${t(KINDS.find((item) => item.value === (state.config?.kind ?? 'webdav'))?.labelKey ?? 'settings.cloudSyncWebdav')}${status?.lastUploadAt ? ` · ${formatTime(status.lastUploadAt, locale)}` : ''}`
		: '—';
	return <details className="pd-cloud-sync">
		<summary><span>{t('settings.cloudSyncTitle')}</span><span className="pd-cloud-sync-summary-meta">{summaryMeta}</span></summary>
		<div className="pd-cloud-sync-body">
			<p className="pd-settings-hint">{t('settings.cloudSyncHint')}</p>
			<div className="pd-cloud-sync-grid">
				<label className="pd-cloud-sync-field"><span>{t('settings.cloudSyncService')}</span>
					<div className="pd-cloud-sync-kinds" role="group" aria-label={t('settings.cloudSyncService')}>
						{KINDS.map((item) => <button key={item.value} type="button" data-kind={item.value} className={kind === item.value ? 'is-selected' : ''} aria-pressed={kind === item.value} disabled={locked} onClick={() => setKind(item.value)}>{t(item.labelKey)}</button>)}
					</div>
				</label>
				{kind === 'webdav' && <>
					<label className="pd-cloud-sync-field"><span>{t('settings.cloudSyncUrl')}</span><input type="url" value={webdav.url} placeholder="https://dav.example.com/backup/pi" onChange={(event) => setWebdav((draft) => ({ ...draft, url: event.target.value }))} {...inputProps} /></label>
					<label className="pd-cloud-sync-field"><span>{t('settings.cloudSyncUsername')}</span><input type="text" value={webdav.username} onChange={(event) => setWebdav((draft) => ({ ...draft, username: event.target.value }))} {...inputProps} /></label>
					<label className="pd-cloud-sync-field"><span>{t('settings.cloudSyncPassword')}</span><input type="password" autoComplete="new-password" value={webdav.password} placeholder={secretSaved ? t('settings.cloudSyncSecretKeep') : ''} onChange={(event) => setWebdav((draft) => ({ ...draft, password: event.target.value }))} disabled={locked} /></label>
				</>}
				{kind === 's3' && <>
					<label className="pd-cloud-sync-field pd-cloud-sync-field-wide"><span>{t('settings.cloudSyncEndpoint')}</span><input type="url" value={s3.endpoint} placeholder="https://s3.example.com" onChange={(event) => setS3((draft) => ({ ...draft, endpoint: event.target.value }))} {...inputProps} /><small className="pd-settings-hint">{t('settings.cloudSyncEndpointHint')}</small></label>
					<label className="pd-cloud-sync-field"><span>{t('settings.cloudSyncRegion')}</span><input type="text" value={s3.region} placeholder="us-east-1" onChange={(event) => setS3((draft) => ({ ...draft, region: event.target.value }))} {...inputProps} /></label>
					<label className="pd-cloud-sync-field"><span>{t('settings.cloudSyncBucket')}</span><input type="text" value={s3.bucket} onChange={(event) => setS3((draft) => ({ ...draft, bucket: event.target.value }))} {...inputProps} /></label>
					<label className="pd-cloud-sync-field"><span>{t('settings.cloudSyncAccessKeyId')}</span><input type="text" value={s3.accessKeyId} onChange={(event) => setS3((draft) => ({ ...draft, accessKeyId: event.target.value }))} {...inputProps} /></label>
					<label className="pd-cloud-sync-field"><span>{t('settings.cloudSyncSecretAccessKey')}</span><input type="password" autoComplete="new-password" value={s3.secret} placeholder={secretSaved ? t('settings.cloudSyncSecretKeep') : ''} onChange={(event) => setS3((draft) => ({ ...draft, secret: event.target.value }))} disabled={locked} /></label>
				</>}
				{kind === 'r2' && <>
					<label className="pd-cloud-sync-field"><span>{t('settings.cloudSyncR2AccountId')}</span><input type="text" value={r2.accountId} onChange={(event) => setR2((draft) => ({ ...draft, accountId: event.target.value }))} {...inputProps} /></label>
					<label className="pd-cloud-sync-field"><span>{t('settings.cloudSyncBucket')}</span><input type="text" value={r2.bucket} onChange={(event) => setR2((draft) => ({ ...draft, bucket: event.target.value }))} {...inputProps} /></label>
					<label className="pd-cloud-sync-field"><span>{t('settings.cloudSyncAccessKeyId')}</span><input type="text" value={r2.accessKeyId} onChange={(event) => setR2((draft) => ({ ...draft, accessKeyId: event.target.value }))} {...inputProps} /></label>
					<label className="pd-cloud-sync-field"><span>{t('settings.cloudSyncSecretAccessKey')}</span><input type="password" autoComplete="new-password" value={r2.secret} placeholder={secretSaved ? t('settings.cloudSyncSecretKeep') : ''} onChange={(event) => setR2((draft) => ({ ...draft, secret: event.target.value }))} disabled={locked} /></label>
				</>}
				<label className="pd-cloud-sync-field"><span>{t('settings.cloudSyncRemotePath')}</span><input type="text" value={remotePath} placeholder={DEFAULT_REMOTE_PATH} onChange={(event) => setRemotePath(event.target.value)} {...inputProps} /></label>
				<label className="pd-model-switch pd-cloud-sync-auto" title={t('settings.cloudSyncAutoSyncHint')}><input type="checkbox" role="switch" checked={autoSync} disabled={locked} aria-label={t('settings.cloudSyncAutoSync')} onChange={(event) => setAutoSync(event.target.checked)} /><span className="pd-model-switch-track" aria-hidden="true"><span className="pd-model-switch-thumb" /></span><span className="pd-cloud-sync-auto-copy"><strong>{t('settings.cloudSyncAutoSync')}</strong><small>{t('settings.cloudSyncAutoSyncHint')}</small></span></label>
			</div>
			<div className="pd-cloud-sync-actions">
				<button type="button" data-action="cloud-sync-test" className="pd-model-settings-button" disabled={locked} onClick={() => void test()}>{busy === 'test' ? t('settings.cloudSyncTesting') : t('settings.cloudSyncTest')}</button>
				<button type="button" data-action="cloud-sync-save" className="pd-settings-primary" disabled={locked} onClick={() => void save()}>{busy === 'save' ? t('personalization.saving') : t('settings.cloudSyncSave')}</button>
				<button type="button" data-action="cloud-sync-upload" className="pd-model-settings-button" disabled={locked || !state?.configured} onClick={() => void upload()}>{busy === 'upload' ? t('settings.cloudSyncUploading') : t('settings.cloudSyncUpload')}</button>
				<button type="button" data-action="cloud-sync-download" className="pd-model-settings-button" disabled={locked || !state?.configured} onClick={() => void download()}>{busy === 'download' ? t('settings.cloudSyncDownloading') : t('settings.cloudSyncDownload')}</button>
			</div>
			{remote && (remote.uploadedAt !== null
				? <div className="pd-cloud-sync-remote" role="region" aria-label={t('settings.cloudSyncDownload')}>
					<p className="pd-cloud-sync-remote-time">{t('settings.cloudSyncRemoteAt', { time: formatTime(remote.uploadedAt, locale) })}</p>
					<p className="pd-cloud-sync-remote-meta">{t('settings.cloudSyncCounts', { providers: dash(remote.providers), models: dash(remote.models), credentials: dash(remote.credentials) })}{remote.size !== null ? ` · ${formatSize(remote.size)}` : ''}{remote.appVersion ? ` · v${remote.appVersion}` : ''}</p>
					<p className="pd-settings-hint">{t('settings.cloudSyncRestoreConfirm')}</p>
					<p className="pd-settings-hint">{t('settings.cloudSyncRestoreHint')}</p>
					<div className="pd-model-settings-form-actions">
						<button type="button" className="pd-model-settings-button" disabled={locked} onClick={() => setRemote(null)}>{t('settings.modelSettingsCancel')}</button>
						<button type="button" data-action="cloud-sync-restore" className="pd-model-settings-button is-danger" disabled={locked} onClick={() => void confirmRestore()}>{busy === 'restore' ? t('settings.cloudSyncDownloading') : t('settings.cloudSyncConfirmRestore')}</button>
					</div>
				</div>
				: <p className="pd-model-settings-notice">{t('settings.cloudSyncNoBackup')}</p>)}
			{error && <div className="pd-settings-error pd-model-detail-feedback" role="alert">{error}</div>}
			{feedback && <p className="pd-model-settings-feedback pd-model-detail-feedback" role="status">{feedback}</p>}
			<ul className="pd-cloud-sync-status">
				{status?.lastUploadAt && <li>{t('settings.cloudSyncLastUpload', { time: formatTime(status.lastUploadAt, locale) })}</li>}
				{status?.lastAutoSyncAt && <li>{t('settings.cloudSyncLastAutoSync', { time: formatTime(status.lastAutoSyncAt, locale) })}</li>}
				{status?.pending && <li aria-busy="true">{t('settings.cloudSyncPending')}</li>}
				{status?.lastError && <li className="pd-cloud-sync-status-error">{t('settings.cloudSyncLastError', { error: status.lastError })}</li>}
				{!state?.configured && <li>{t('settings.cloudSyncNotConfigured')}</li>}
			</ul>
		</div>
	</details>;
}
