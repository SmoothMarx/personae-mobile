/**
 * Settings model + persistence.
 *
 * The API key goes to expo-secure-store (Keychain / Android Keystore backed) and never anywhere
 * else: not in the repo, not in the APK, not in a log. The non-secret settings live in the same
 * secure store under one JSON blob — it is the only storage the app needs, which keeps the
 * dependency surface small.
 *
 * Every field has a declared default and an explicit "empty means default" meaning, so the
 * Settings screen can always show the *effective* value that is actually in use
 * (pedro-app-defaults: "the effective value always displayed, never a different one").
 */

export type Settings = {
  /** Gateway origin, e.g. http://100.64.0.5:8642 . Empty = not configured. */
  baseUrl: string;
  /** Bearer token (API_SERVER_KEY). Empty = not configured. NEVER logged or persisted in plain files. */
  apiKey: string;
  /** Extra profiles served under /p/<name>/ (multiplex_profiles). */
  profiles: string[];
  /** Optional per-request model override; empty = gateway default. */
  model: string;
};

export const SETTINGS_STORE_KEY = 'personae.settings.v1';
export const SECRET_STORE_KEY = 'personae.apiKey';
export const LAST_SEEN_STORE_KEY = 'personae.lastSeen.v1';

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: '',
  apiKey: '',
  profiles: [],
  model: '',
};

export type StoredSettings = Omit<Settings, 'apiKey'>;

export function splitProfiles(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split(/[\n,]/)) {
    const name = line.trim().replace(/^\/+|\/+$/g, '');
    if (!name || name === 'p' || name === 'default') continue;
    if (!/^[A-Za-z0-9._-]+$/.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\s+/g, '');
}

/** Validate a gateway origin. Returns null when acceptable, else a reason key. */
export function checkBaseUrl(raw: string): { ok: true; value: string } | { ok: false; reason: 'empty' | 'bad' } {
  const value = normalizeBaseUrl(raw);
  if (!value) return { ok: false, reason: 'empty' };
  if (!/^https?:\/\//i.test(value)) return { ok: false, reason: 'bad' };
  try {
    const url = new URL(value);
    if (!url.hostname) return { ok: false, reason: 'bad' };
    return { ok: true, value: value.replace(/\/+$/, '') };
  } catch {
    return { ok: false, reason: 'bad' };
  }
}

/** Prefix a route for a profile. The gateway mounts every route at /p/<profile>/<path>. */
export function profilePrefix(profile: string): string {
  const name = (profile || '').trim();
  if (!name || name === 'default') return '';
  return `/p/${encodeURIComponent(name)}`;
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

export function redactKey(key: string): string {
  if (!key) return '';
  if (key.length <= 6) return '••••';
  return `${key.slice(0, 3)}…${key.slice(-2)} (${key.length} caracteres)`;
}
