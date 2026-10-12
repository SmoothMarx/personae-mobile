/**
 * Settings persistence: load/save, with the key kept in its own secure-store slot.
 *
 * Migration note (deliberate, see DECISIONS D5): `routes[]` is ADDED to the existing JSON blob, and
 * `baseUrl` is still written on every save. An older build — which knows only
 * `baseUrl`/`profiles`/`model` — therefore still reads this blob correctly, and a newer build
 * derives the route list from `baseUrl` when `routes` is absent or empty. No old read is broken, so
 * no destructive migration is needed. `baseUrl` is written as the highest-priority route so the two
 * fields can never disagree.
 */

import {
  DEFAULT_SETTINGS,
  healSurface,
  LAST_SEEN_STORE_KEY,
  normalizeNotify,
  normalizeSessionTypes,
  SECRET_STORE_KEY,
  SETTINGS_STORE_KEY,
  type Settings,
  type StoredSettings,
} from './settings';
import { DEFAULT_LANGUAGE, getLanguage, isLanguage, setLanguage } from './i18n';
import { normalizeRouteUrl, normalizeRoutes, orderRoutes, routesFromBaseUrl } from './routes';
import { storeDelete, storeGet, storeSet } from './storage';

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export async function loadSettings(): Promise<Settings> {
  const [blob, apiKey] = await Promise.all([storeGet(SETTINGS_STORE_KEY), storeGet(SECRET_STORE_KEY)]);
  let parsed: Partial<StoredSettings> = {};
  /** True when an earlier build saved a settings object here (i.e. not a fresh install). */
  let existing = false;
  if (blob) {
    try {
      const value = JSON.parse(blob);
      if (value && typeof value === 'object') {
        parsed = value as Partial<StoredSettings>;
        existing = true;
      }
    } catch {
      parsed = {};
    }
  }
  const baseUrl = asString(parsed.baseUrl, '');
  const storedRoutes = normalizeRoutes(parsed.routes);
  const routes = storedRoutes.length ? storedRoutes : routesFromBaseUrl(baseUrl);

  // `surface` is ADDITIVE: an older blob simply has no value and lands on the default, so an
  // existing install keeps working and a newer build reads the old shape unchanged.
  // `language` is ADDITIVE too, with one twist: a blob saved before the field existed came from the
  // Portuguese-only build, so that install keeps Portuguese. Only a fresh install gets the default.
  const language = isLanguage(parsed.language) ? parsed.language : existing ? 'pt' : DEFAULT_LANGUAGE;

  const surface = parsed.surface === 'gateway' ? 'gateway' : parsed.surface === 'dashboard' ? 'dashboard' : 'dashboard';

  const loaded: Settings = {
    baseUrl: baseUrl || (routes.length ? routes[0].url : ''),
    surface,
    profiles: Array.isArray(parsed.profiles) ? parsed.profiles.filter((p) => typeof p === 'string') : [],
    model: asString(parsed.model, ''),
    routes,
    preferredRouteRole:
      typeof parsed.preferredRouteRole === 'string' && parsed.preferredRouteRole.trim()
        ? parsed.preferredRouteRole.trim()
        : null,
    language,
    autoConnect: asBoolean(parsed.autoConnect, DEFAULT_SETTINGS.autoConnect),
    tailscalePackage: asString(parsed.tailscalePackage, 'com.tailscale.ipn').trim() || 'com.tailscale.ipn',
    connectDeadlineMs: asNumber(parsed.connectDeadlineMs, 20_000, 1_000, 120_000),
    probeTimeoutMs: asNumber(parsed.probeTimeoutMs, 1_500, 100, 10_000),
    openTailscaleOnFailure: asBoolean(parsed.openTailscaleOnFailure, DEFAULT_SETTINGS.openTailscaleOnFailure),
    insecureRouteAck: asBoolean(parsed.insecureRouteAck, false),
    // 0.8.0 D. ADDITIVE, and the interesting case is the ABSENT one: a `personae.settings.v1` blob
    // written by 0.7.0 has no `sessionTypes` key at all, and it must load as "conversations on, runs
    // off" — never as `undefined`, which would make `types[name]` throw at the first filter. Only a
    // real boolean is trusted, per bucket, so a half-written key cannot take the other down with it.
    sessionTypes: normalizeSessionTypes(parsed.sessionTypes),
    // 0.8.0 H: same ADDITIVE rule — a blob without `notifications` loads with the master switch OFF.
    notifications: normalizeNotify(parsed.notifications),
    everReachedGateway: asBoolean(parsed.everReachedGateway, false),
    lastTriggerResult: asString(parsed.lastTriggerResult, ''),
    lastErrorKind: asString(parsed.lastErrorKind, ''),
    deviceId: asString(parsed.deviceId, ''),
    deviceLabel: asString(parsed.deviceLabel, ''),
    healNote: asString(parsed.healNote, ''),
    apiKey: apiKey || '',
  };
  // 0.6.0: an incoherent surface/port pair is healed on load, and the screen shows why (once).
  // The note is written in the user's language; the switch is scoped to this one call.
  const previous = getLanguage();
  setLanguage(loaded.language);
  const healed = healSurface(loaded);
  setLanguage(previous);
  if (healed.note) {
    const next = { ...healed.settings, healNote: healed.note };
    await saveSettings(next).catch(() => undefined);
    return next;
  }
  return loaded;
}

export async function saveSettings(settings: Settings): Promise<void> {
  // `baseUrl` mirrors the highest-priority route, so a build that only knows `baseUrl` still
  // behaves, and the two fields can never drift apart.
  const ordered = orderRoutes(settings.routes);
  const baseUrl = ordered.length ? normalizeRouteUrl(ordered[0].url) : settings.baseUrl;

  const stored: StoredSettings = {
    baseUrl,
    surface: settings.surface,
    profiles: settings.profiles,
    model: settings.model,
    routes: settings.routes,
    preferredRouteRole: settings.preferredRouteRole,
    language: settings.language,
    autoConnect: settings.autoConnect,
    tailscalePackage: settings.tailscalePackage,
    connectDeadlineMs: settings.connectDeadlineMs,
    probeTimeoutMs: settings.probeTimeoutMs,
    openTailscaleOnFailure: settings.openTailscaleOnFailure,
    insecureRouteAck: settings.insecureRouteAck,
    sessionTypes: settings.sessionTypes,
    notifications: settings.notifications,
    everReachedGateway: settings.everReachedGateway,
    lastTriggerResult: settings.lastTriggerResult,
    lastErrorKind: settings.lastErrorKind,
    deviceId: settings.deviceId,
    deviceLabel: settings.deviceLabel,
    healNote: settings.healNote,
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
