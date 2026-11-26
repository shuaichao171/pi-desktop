/**
 * Secure storage for saved desktop environments on iOS Keychain / Android Keystore.
 * Separates environment metadata from access tokens so each entry stays under
 * SecureStore's 2 KiB per-item recommendation on older Android devices.
 */

import * as SecureStore from 'expo-secure-store';
import type { SavedRemoteEnvironment } from '@pidesktop/shared/remoteClient';

const ENV_INDEX_KEY = 'pidesktop_remote_env_index_v1';
const tokenKey = (envId: string) => `pidesktop_remote_tok_${envId.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
const metaKey = (envId: string) => `pidesktop_remote_meta_${envId.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

type StoredEnvironmentMeta = Omit<SavedRemoteEnvironment, 'accessToken'>;

async function safeGet(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

async function safeSet(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value);
}

async function safeDelete(key: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    // ignore missing item
  }
}

export async function loadSavedEnvironments(): Promise<SavedRemoteEnvironment[]> {
  const rawIndex = await safeGet(ENV_INDEX_KEY);
  if (!rawIndex) return [];
  let ids: string[];
  try {
    const parsed = JSON.parse(rawIndex);
    ids = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
  const results: SavedRemoteEnvironment[] = [];
  for (const id of ids) {
    const [rawMeta, accessToken] = await Promise.all([safeGet(metaKey(id)), safeGet(tokenKey(id))]);
    if (!rawMeta || !accessToken) continue;
    try {
      const meta = JSON.parse(rawMeta) as StoredEnvironmentMeta;
      results.push({ ...meta, accessToken });
    } catch {
      // skip corrupt record
    }
  }
  return results;
}

export async function saveEnvironment(env: SavedRemoteEnvironment): Promise<SavedRemoteEnvironment[]> {
  const existing = await loadSavedEnvironments();
  const next = [env, ...existing.filter((item) => item.environmentId !== env.environmentId)];
  const { accessToken, ...meta } = env;
  await Promise.all([
    safeSet(metaKey(env.environmentId), JSON.stringify(meta)),
    safeSet(tokenKey(env.environmentId), accessToken),
    safeSet(ENV_INDEX_KEY, JSON.stringify(next.map((item) => item.environmentId))),
  ]);
  return next;
}

export async function removeSavedEnvironment(environmentId: string): Promise<SavedRemoteEnvironment[]> {
  const existing = await loadSavedEnvironments();
  const next = existing.filter((item) => item.environmentId !== environmentId);
  await Promise.all([
    safeDelete(metaKey(environmentId)),
    safeDelete(tokenKey(environmentId)),
    safeSet(ENV_INDEX_KEY, JSON.stringify(next.map((item) => item.environmentId))),
  ]);
  return next;
}
