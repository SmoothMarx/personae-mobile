/**
 * Settings persistence: load/save, with the key kept in its own secure-store slot.
 */

import { LAST_SEEN_STORE_KEY, SECRET_STORE_KEY, SETTINGS_STORE_KEY, type Settings, type StoredSettings } from './settings';
import { storeDelete, storeGet, storeSet } from './storage';

export async function loadSettings(): Promise<Settings> {
  const [blob, apiKey] = await Promise.all([storeGet(SETTINGS_STORE_KEY), storeGet(SECRET_STORE_KEY)]);
  let parsed: Partial<StoredSettings> = {};
  if (blob) {
    try {
      const value = JSON.parse(blob);
      if (value && typeof value === 'object') parsed = value as Partial<StoredSettings>;
    } catch {
      parsed = {};
    }
  }
  return {
    baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
    profiles: Array.isArray(parsed.profiles) ? parsed.profiles.filter((p) => typeof p === 'string') : [],
    model: typeof parsed.model === 'string' ? parsed.model : '',
    apiKey: apiKey || '',
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  const stored: StoredSettings = {
    baseUrl: settings.baseUrl,
    profiles: settings.profiles,
    model: settings.model,
  };
  await storeSet(SETTINGS_STORE_KEY, JSON.stringify(stored));
  if (settings.apiKey) {
    await storeSet(SECRET_STORE_KEY, settings.apiKey);
  } else {
    await storeDelete(SECRET_STORE_KEY);
  }
}

export type LastSeenMap = Record<string, number>;

export async function loadLastSeen(): Promise<LastSeenMap> {
  const blob = await storeGet(LAST_SEEN_STORE_KEY);
  if (!blob) return {};
  try {
    const value = JSON.parse(blob);
    return value && typeof value === 'object' ? (value as LastSeenMap) : {};
  } catch {
    return {};
  }
}

export async function saveLastSeen(map: LastSeenMap): Promise<void> {
  await storeSet(LAST_SEEN_STORE_KEY, JSON.stringify(map));
}
