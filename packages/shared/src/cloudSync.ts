/**
 * @pidesktop/shared — cloud backup contract for the model-provider database.
 *
 * Mirrors cc-switch's cloud-sync capability: test the connection, save the
 * configuration, upload the provider database to WebDAV / S3 / Cloudflare R2,
 * and download it back (the remote upload time is reported in the local time
 * zone). When auto-sync is enabled, every provider-database change uploads a
 * fresh backup automatically.
 */

export const CLOUD_SYNC_FEATURE_CHANNELS = {
  getState: 'cloud-sync:get-state',
  saveConfig: 'cloud-sync:save-config',
  testConnection: 'cloud-sync:test-connection',
  upload: 'cloud-sync:upload',
  inspect: 'cloud-sync:inspect',
  restore: 'cloud-sync:restore',
  changed: 'cloud-sync:changed',
} as const;

export type UiCloudSyncKind = 'webdav' | 's3' | 'r2';

export interface UiCloudSyncWebdavConfig {
  /** Server root URL, e.g. https://dav.example.com/backup/pi */
  url: string;
  username: string;
  /** Omitted to keep the stored password; never returned to the renderer. */
  password?: string;
  hasPassword: boolean;
}

export interface UiCloudSyncS3Config {
  /** Empty uses the AWS endpoint derived from the region. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  /** Omitted to keep the stored secret; never returned to the renderer. */
  secretAccessKey?: string;
  hasSecret: boolean;
}

export interface UiCloudSyncR2Config {
  /** Cloudflare account id; the endpoint is https://<accountId>.r2.cloudflarestorage.com */
  accountId: string;
  bucket: string;
  accessKeyId: string;
  /** Omitted to keep the stored secret; never returned to the renderer. */
  secretAccessKey?: string;
  hasSecret: boolean;
}

export interface UiCloudSyncConfig {
  kind: UiCloudSyncKind;
  /** Upload after every provider-database change once saved. */
  autoSync: boolean;
  /** Remote file name under the configured service; default providers-backup.json. */
  remotePath: string;
  webdav?: UiCloudSyncWebdavConfig;
  s3?: UiCloudSyncS3Config;
  r2?: UiCloudSyncR2Config;
}

/** Result of a connection test; includes the remote backup's upload time when present. */
export interface UiCloudSyncTestResult {
  ok: boolean;
  message: string;
  remote: UiCloudSyncBackupInfo | null;
}

/** Summary of the backup currently stored in the cloud. */
export interface UiCloudSyncBackupInfo {
  /** ISO-8601 upload timestamp reported by the cloud copy; null when unknown. */
  uploadedAt: string | null;
  /** Remote file size in bytes; null when unknown. */
  size: number | null;
  providers: number | null;
  models: number | null;
  credentials: number | null;
  appVersion: string | null;
}

export interface UiCloudSyncUploadResult {
  uploadedAt: string;
  bytes: number;
  providers: number;
  models: number;
  credentials: number;
}

export interface UiCloudSyncRestoreResult {
  providers: number;
  models: number;
  credentials: number;
  /** Upload timestamp of the backup that was restored (ISO-8601). */
  uploadedAt: string | null;
}

export interface UiCloudSyncStatus {
  lastUploadAt: string | null;
  lastAutoSyncAt: string | null;
  lastError: string | null;
  pending: boolean;
}

export interface UiCloudSyncState {
  /** A config exists and its required fields (including secrets) are present. */
  configured: boolean;
  config: UiCloudSyncConfig | null;
  status: UiCloudSyncStatus;
}

export interface CloudSyncFeaturesBridge {
  getCloudSyncState(): Promise<UiCloudSyncState>;
  /** Persists the configuration; secret fields are omitted to keep stored values. */
  saveCloudSyncConfig(config: UiCloudSyncConfig): Promise<UiCloudSyncState>;
  /** Tests the draft (or stored, when identical) configuration without saving. */
  testCloudSyncConnection(config: UiCloudSyncConfig): Promise<UiCloudSyncTestResult>;
  /** Builds a fresh backup from the local provider database and uploads it. */
  uploadCloudSyncBackup(): Promise<UiCloudSyncUploadResult>;
  /** Reads the remote backup summary for the download confirmation dialog. */
  inspectCloudSyncBackup(): Promise<UiCloudSyncBackupInfo>;
  /** Downloads and applies the remote backup; requires all sessions to be idle. */
  restoreCloudSyncBackup(): Promise<UiCloudSyncRestoreResult>;
  /** Pushes state updates (auto-sync progress, status changes) to renderers. */
  onCloudSyncChanged(listener: (state: UiCloudSyncState) => void): () => void;
}
