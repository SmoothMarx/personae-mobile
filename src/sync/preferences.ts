/**
 * Portable-preference sync (0.9.0 Phase I) — the phone's half.
 *
 * THE DESIGN POINT THAT DECIDES EVERYTHING (goal §5, "Sync scope"):
 *
 *   * **portable**  session types shown, notification preferences, display/ordering — these go
 *     through the document Phase A built, so the desktop and the phone agree;
 *   * **device-local**  the gateway URL + bearer, the routes, pairing state, device identity, the OS
 *     notification permission, the push token, the language — these NEVER go, because pushing one
 *     client's value over the other's breaks it. The desktop dials `localhost:9119`; the phone dials
 *     the tailnet address; syncing "Gateway Settings" is how you lose a working desktop.
 *
 * The split is not a convention here, it is an ALLOWLIST: `readPortable` reads only the keys named in
 * `PORTABLE_KEYS`, and `applyPortable` writes only those back. A `Settings` field that nobody listed
 * cannot leak, because there is no code path that would carry it.
 *
 * No tombstones and no membership: the user chose real server-side verbs (Phase A), so what exists and
 * what is archived is the SERVER's answer, identical for both clients. Only preferences need merging,
 * and that is per-key last-write-wins with a monotonic revision.
 */

import type { PreferenceDocument } from '../api/dashboard';
import type { Settings } from '../settings';
import { DEFAULT_NOTIFY, DEFAULT_SESSION_TYPES, normalizeNotify, normalizeSessionTypes } from '../settings';
import type { SectionsModel } from '../logic/sections';
import { normalizeSections } from '../logic/sections';

/**
 * The portable keys, by the names the SERVER accepts (the same three the state plugin publishes at
 * `GET /preferences/keys`). Anything not in this list is device-local BY OMISSION.
 */
export const PORTABLE_KEYS = ['session-types', 'notifications', 'display-order'] as const;
export type PortableKey = (typeof PORTABLE_KEYS)[number];

/** The per-key revision this client last saw, so a patch can declare what it read. */
export type PreferenceRevision = number;

export type PortablePayload = Partial<Record<PortableKey, unknown>>;

/** Read the portable half out of the local settings + roster prefs. */
export function readPortable(
  settings: Pick<Settings, 'sessionTypes' | 'notifications'>,
  sections: SectionsModel,
): Record<PortableKey, unknown> {
  return {
    'session-types': settings.sessionTypes,
    notifications: settings.notifications,
    // The roster's own ordering: the sort modes, which are display, not reachability.
    'display-order': { sort: sections.sort },
  };
}

/**
 * Apply the portable half of a server document. Anything missing or malformed falls back to the
 * DEFAULT for that key — the same rule every local load uses, so a half-written document from another
 * client cannot take the rest of the settings down with it.
 */
export function applyPortable(
  settings: Settings,
  sections: SectionsModel,
  document: PreferenceDocument | null,
): { settings: Settings; sections: SectionsModel; applied: PortableKey[] } {
  const preferences = (document?.preferences ?? {}) as Record<string, unknown>;
  const applied: PortableKey[] = [];
  let nextSettings = settings;
  let nextSections = sections;
  if ('session-types' in preferences) {
    nextSettings = { ...nextSettings, sessionTypes: normalizeSessionTypes(preferences['session-types']) };
    applied.push('session-types');
  }
  if ('notifications' in preferences) {
    nextSettings = { ...nextSettings, notifications: normalizeNotify(preferences.notifications) };
    applied.push('notifications');
  }
  if ('display-order' in preferences) {
    const order = preferences['display-order'];
    const sort = order && typeof order === 'object' ? (order as { sort?: unknown }).sort : undefined;
    nextSections = normalizeSections({ ...sections, sort: sort ?? sections.sort });
    applied.push('display-order');
  }
  return { settings: nextSettings, sections: nextSections, applied };
}

/**
 * The patch to send for a key that just changed locally. `revision` is the one this client last SAW,
 * which is what lets the server tell a fresh edit from a stale one — and why this function takes it
 * rather than inventing one.
 */
export function patchFor(
  key: PortableKey,
  value: unknown,
  revision: PreferenceRevision,
): { revision: number; preferences: Record<string, unknown> } {
  return { revision, preferences: { [key]: value } };
}

/**
 * Which portable keys differ between two local snapshots — the diff `useRoster`/`SettingsContext`
 * use to decide what to push, so an unchanged preference never causes a write (and therefore never
 * a revision bump, and therefore never churn against the desktop).
 */
export function changedKeys(
  before: Record<PortableKey, unknown>,
  after: Record<PortableKey, unknown>,
): PortableKey[] {
  return PORTABLE_KEYS.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

/** The device-local half, NAMED — the disclosure the Settings page shows, and what a test pins. */
export const DEVICE_LOCAL_KEYS = [
  'baseUrl',
  'apiKey',
  'surface',
  'routes',
  'preferredRouteRole',
  'deviceId',
  'deviceLabel',
  'language',
  'autoConnect',
  'tailscalePackage',
  'connectDeadlineMs',
  'probeTimeoutMs',
  'openTailscaleOnFailure',
  'insecureRouteAck',
  'everReachedGateway',
  'lastTriggerResult',
  'lastErrorKind',
  'healNote',
  'model',
  'profiles',
] as const;

/** Is this settings field ever carried to the other client? The allowlist, as a question. */
export function isPortableSetting(field: string): boolean {
  return (
    field === 'sessionTypes' ||
    field === 'notifications' ||
    // `display-order` is the ROSTER's sort, which lives in `rosterPrefs`, not in `Settings`.
    field === 'sort'
  );
}

/** The defaults, re-exported so a caller can say what "nothing was synced" means. */
export const PORTABLE_DEFAULTS = {
  sessionTypes: DEFAULT_SESSION_TYPES,
  notifications: DEFAULT_NOTIFY,
} as const;
