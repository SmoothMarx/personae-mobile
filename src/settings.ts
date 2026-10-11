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

import { t, type Language } from './i18n';
import type { RouteCandidate } from './routes';

/**
 * Which HTTP surface this connection speaks.
 *   'dashboard' — `hermes dashboard` (0.0.0.0:9119): profiles, the batched rail, the WS event
 *                 channel. This is the app's target from 0.4.0 (PLAN-UI.md §0.2).
 *   'gateway'   — the legacy `:9222` api_server surface, kept so an existing setup keeps working.
 */
export type Surface = 'dashboard' | 'gateway';

export type Settings = {
  /** Origin of the chosen surface, e.g. http://10.0.0.15:9119 . Empty = not configured. */
  baseUrl: string;
  /** Which surface `baseUrl` speaks. */
  surface: Surface;
  /** Bearer token (API_SERVER_KEY). Empty = not configured. NEVER logged or persisted in plain files. */
  apiKey: string;
  /** Extra profiles served under /p/<name>/ (multiplex_profiles). */
  profiles: string[];
  /** Optional per-request model override; empty = gateway default. */
  model: string;

  // ── remote access: one server, several routes ────────────────────────────────
  /**
   * Ordered candidate list for this one logical server. Empty on a fresh install (derived from
   * `baseUrl`), which is what keeps the legacy single-URL shape working.
   */
  routes: RouteCandidate[];
  /** Optional manual pin, e.g. 'tailscale'. null = Auto (strict priority order). */
  preferredRouteRole: string | null;
  /**
   * Interface language. A fresh install starts in English; an install that saved settings before
   * this field existed keeps Portuguese (the language it was built in) — see loadSettings.
   */
  language: Language;
  /** Master switch for the launch/foreground tunnel trigger. Off by default (opt-in). */
  autoConnect: boolean;
  /** Broadcast target for the tunnel trigger; lets a fork swap in without a rebuild. */
  tailscalePackage: string;
  /** Wait budget before declaring "setup incomplete". */
  connectDeadlineMs: number;
  /** Per-attempt probe timeout. */
  probeTimeoutMs: number;
  /** Fallback when the one-time setup is still missing. Off by default (opt-in). */
  openTailscaleOnFailure: boolean;
  /** Explicit opt-in before using a plain-http non-loopback route. */
  insecureRouteAck: boolean;

  // ── diagnostics (persisted; read-only on screen) ─────────────────────────────
  /** Has the whole chain (tunnel + route + gateway) ever worked on this phone? */
  everReachedGateway: boolean;
  /** What the last trigger actually did. */
  lastTriggerResult: string;
  /** The last failure class seen, e.g. `transient · HTTP 0`. */
  lastErrorKind: string;

  // ── pairing (0.6.0) ───────────────────────────────────────────────────────────
  /** Server-side id of THIS phone's paired credential ('' = a pasted/static key). Not a secret. */
  deviceId: string;
  /** The label the dashboard shows for this phone. */
  deviceLabel: string;
  /** One visible line explaining an automatic correction made on load ('' = nothing to say). */
  healNote: string;
};

export const SETTINGS_STORE_KEY = 'personae.settings.v1';
export const SECRET_STORE_KEY = 'personae.apiKey';
export const LAST_SEEN_STORE_KEY = 'personae.lastSeen.v1';

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: '',
  surface: 'dashboard',
  apiKey: '',
  profiles: [],
  model: '',
  routes: [],
  preferredRouteRole: null,
  language: 'en',
  // Tailscale auto-start is opt-in: route probing runs regardless, these only gate the broadcast
  // trigger and opening the Tailscale app on failure. Stored values on an existing install win.
  autoConnect: false,
  tailscalePackage: 'com.tailscale.ipn',
  connectDeadlineMs: 20_000,
  probeTimeoutMs: 1_500,
  openTailscaleOnFailure: false,
  insecureRouteAck: false,
  everReachedGateway: false,
  lastTriggerResult: '',
  lastErrorKind: '',
  deviceId: '',
  deviceLabel: '',
  healNote: '',
};

export type StoredSettings = Omit<Settings, 'apiKey'>;

/**
 * Settings as the API client needs them: the same object with `baseUrl` pointing at the route that
 * was actually chosen. The client keeps talking in terms of one origin, so route selection is
 * invisible to it — which is what keeps this change from reaching into every call site.
 */
export function settingsForRoute(settings: Settings, url: string): Settings {
  return url && url !== settings.baseUrl ? { ...settings, baseUrl: url } : settings;
}

/** Human label for a surface (interface language, shown next to the URL field). */
export function surfaceLabel(surface: Surface): string {
  return surface === 'gateway' ? t.settings.surfaceGateway : t.settings.surfaceDashboard;
}

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
  return `${key.slice(0, 3)}…${key.slice(-2)} (${t.settings.keyChars(key.length)})`;
}

/** The surface a URL's port implies: 9119 = dashboard, 9222 = gateway, anything else = no opinion. */
export function surfaceForUrl(raw: string): Surface | null {
  const checked = checkBaseUrl(raw);
  if (!checked.ok) return null;
  try {
    const port = new URL(checked.value).port;
    if (port === '9119') return 'dashboard';
    if (port === '9222') return 'gateway';
  } catch {
    return null;
  }
  return null;
}

/**
 * Heal an incoherent stored pair (0.6.0). Both cases point at the dashboard, because the dashboard
 * is the only surface that gives the roster its profiles:
 *  - surface 'dashboard' + a :9222 address (the user's phone at 0.5.0: 401s, then 404s forever) →
 *    move the address (and every route) to :9119;
 *  - surface 'gateway' + a :9119 address → the surface becomes 'dashboard'.
 * Returns the settings unchanged (and `note: ''`) when the pair is already coherent.
 */
export function healSurface(settings: Settings): { settings: Settings; note: string } {
  const implied = surfaceForUrl(settings.baseUrl);
  if (settings.surface === 'dashboard' && implied === 'gateway') {
    const fix = (url: string) => url.replace(/:9222(?=\/|$)/, ':9119');
    const to = fix(settings.baseUrl);
    return {
      settings: { ...settings, baseUrl: to, routes: settings.routes.map((r) => ({ ...r, url: fix(r.url) })) },
      note: t.connect.healed(settings.baseUrl, to),
    };
  }
  if (settings.surface === 'gateway' && implied === 'dashboard') {
    return { settings: { ...settings, surface: 'dashboard' }, note: t.connect.healedSurface };
  }
  return { settings, note: '' };
}
