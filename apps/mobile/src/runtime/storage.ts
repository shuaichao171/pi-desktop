/**
 * Storage for saved desktop environments on iOS / Android:
 * - Access tokens live exclusively in iOS Keychain / Android Keystore (expo-secure-store).
 * - Non-secret environment metadata & routes live in app document storage (expo-file-system)
 *   to avoid SecureStore's 2 KiB per-item limit when hosts accumulate routes.
 * - All reads/writes are serialized through a single queue so concurrent saves can never
 *   resurrect a forgotten host or interleave one-time legacy migration.
 */

import * as FileSystem from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import type { SavedRemoteEnvironment } from '@pidesktop/shared/remoteClient';

const ENV_INDEX_KEY = 'pidesktop_remote_env_index_v1';
const META_FILE_NAME = 'pidesktop-remote-envs.json';
const tokenKey = (envId: string) => `pidesktop_remote_tok_${envId.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
const metaKey = (envId: string) => `pidesktop_remote_meta_${envId.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

type StoredEnvironmentMeta = Omit<SavedRemoteEnvironment, 'accessToken'>;

interface StoredEnvironmentsFile {
  version: 1;
  environments: StoredEnvironmentMeta[];
}

let storageQueue: Promise<unknown> = Promise.resolve();

function enqueueStorageOp<T>(work: () => Promise<T>): Promise<T> {
  const run = storageQueue.then(work, work);
  storageQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function metaFileUri(): string {
  if (!FileSystem.documentDirectory) {
    throw new Error('App document directory is unavailable');
  }
  return `${FileSystem.documentDirectory}${META_FILE_NAME}`;
}

function isStoredEnvironmentMeta(value: unknown): value is StoredEnvironmentMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.environmentId === 'string' && item.environmentId.length > 0 && Array.isArray(item.routes);
}

async function safeDeleteSecureItem(key: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    // ignore missing or already-deleted item
  }
}

async function writeMetadataList(items: readonly StoredEnvironmentMeta[]): Promise<void> {
  const payload: StoredEnvironmentsFile = {
    version: 1,
    environments: [...items],
  };
  await FileSystem.writeAsStringAsync(metaFileUri(), JSON.stringify(payload));
}

async function migrateLegacySecureStoreMetadata(): Promise<StoredEnvironmentMeta[]> {
  // Let unexpected SecureStore I/O errors propagate so we never silently treat them as empty.
  const rawIndex = await SecureStore.getItemAsync(ENV_INDEX_KEY);
  if (!rawIndex) return [];

  let ids: string[];
  try {
    const parsed = JSON.parse(rawIndex);
    ids = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }

  const migrated: StoredEnvironmentMeta[] = [];
  for (const id of ids) {
    const rawMeta = await SecureStore.getItemAsync(metaKey(id));
    if (!rawMeta) continue;
    try {
      const parsed = JSON.parse(rawMeta) as unknown;
      if (isStoredEnvironmentMeta(parsed)) {
        migrated.push(parsed);
      }
    } catch {
      // skip corrupt legacy record
    }
  }

  // Persist migrated file before cleaning up legacy SecureStore metadata entries.
  await writeMetadataList(migrated);
  await Promise.all([
    safeDeleteSecureItem(ENV_INDEX_KEY),
    ...ids.map((id) => safeDeleteSecureItem(metaKey(id))),
  ]);
  return migrated;
}

async function readMetadataList(): Promise<StoredEnvironmentMeta[]> {
  const uri = metaFileUri();
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) {
    return migrateLegacySecureStoreMetadata();
  }
  const raw = await FileSystem.readAsStringAsync(uri);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Saved environments metadata file is unreadable');
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { environments?: unknown }).environments)
      ? (parsed as { environments: unknown[] }).environments
      : null;
  if (!list) {
    throw new Error('Saved environments metadata file has an invalid format');
  }
  return list.filter(isStoredEnvironmentMeta);
}

async function hydrateEnvironments(
  metas: readonly StoredEnvironmentMeta[],
  knownTokens?: ReadonlyMap<string, string>,
): Promise<SavedRemoteEnvironment[]> {
  const results: SavedRemoteEnvironment[] = [];
  for (const meta of metas) {
    const known = knownTokens?.get(meta.environmentId);
    const accessToken = known !== undefined ? known : await SecureStore.getItemAsync(tokenKey(meta.environmentId));
    if (!accessToken) continue;
    results.push({ ...meta, accessToken });
  }
  return results;
}

export function loadSavedEnvironments(): Promise<SavedRemoteEnvironment[]> {
  return enqueueStorageOp(async () => {
    const metas = await readMetadataList();
    return hydrateEnvironments(metas);
  });
}

export function saveEnvironment(env: SavedRemoteEnvironment): Promise<SavedRemoteEnvironment[]> {
  return enqueueStorageOp(async () => {
    const existingMeta = await readMetadataList();
    const { accessToken, ...meta } = env;
    const nextMeta = [meta, ...existingMeta.filter((item) => item.environmentId !== env.environmentId)];
    await SecureStore.setItemAsync(tokenKey(env.environmentId), accessToken);
    await writeMetadataList(nextMeta);
    return hydrateEnvironments(nextMeta, new Map([[env.environmentId, accessToken]]));
  });
}

export function removeSavedEnvironment(environmentId: string): Promise<SavedRemoteEnvironment[]> {
  return enqueueStorageOp(async () => {
    const existingMeta = await readMetadataList();
    const nextMeta = existingMeta.filter((item) => item.environmentId !== environmentId);
    await writeMetadataList(nextMeta);
    await Promise.all([safeDeleteSecureItem(tokenKey(environmentId)), safeDeleteSecureItem(metaKey(environmentId))]);
    return hydrateEnvironments(nextMeta);
  });
}
