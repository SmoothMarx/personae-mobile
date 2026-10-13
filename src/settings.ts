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

import { t } from './i18n';
import type { RouteCandidate } from './routes';

/**
 * Which HTTP surface this connection speaks.
 *   'dashboard' — `hermes dashboard` (0.0.0.0:9119): profiles, the batched rail, the WS event
 *                 channel. This is the app's target from 0.4.0 (PLAN-UI.md §0.2).
 *   'gateway'   — the legacy `:9222` api_server surface, kept so an existing setup keeps working.
 */
export type Surface = 'dashboard' | 'gateway';

/**
 * 0.8.0 D — which session types the default list shows.
 *
 * Two buckets, decided by ONE classifier (`sessionTypeOf` in `src/logic/rosterFeed.ts`, which is the
 * only place that reads `NON_CONVERSATION_SOURCES`): a conversation, or a job run. The roster list
 * and the checkpoint notifications both ask that classifier, so they can never disagree about what
 * is hidden.
 *
 * BOTH OFF IS A LEGAL STATE. The list then shows an empty state that says why, rather than a blank
 * screen or a silently-filtered list.
 */
export type SessionTypes = {
  /** Conversations: anything whose `source` is not a job-run source. Default ON. */
  sessions: boolean;
  /** Job runs (`cron`, `cron_output`, `webhook`). Default OFF. */
  automatic: boolean;
};

export const DEFAULT_SESSION_TYPES: SessionTypes = { sessions: true, automatic: false };

/**
 * 0.8.0 H — checkpoint notifications. DEVICE-SIDE local notifications, not push: they can only fire
 * while the app is running, because the only thing that knows about a checkpoint is this phone's own
 * poll (see `src/logic/checkpoints.ts`).
 *
 * The master switch is OFF by default and the permission is NOT requested at cold start: it is asked
 * for exactly once, when the user turns the master switch on. Nothing polls before that.
 */
export type NotifySettings = {
  /** The master switch. Off until the user asks. */
  enabled: boolean;
  /** "Waiting on me" — a session blocked on the user. */
  waiting: boolean;
  /** "Finished" — a turn that ended. */
  finished: boolean;
};

export const DEFAULT_NOTIFY: NotifySettings = { enabled: false, waiting: true, finished: true };

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
  // 0.9.1 S4.1: a `language: Language` field lived here. the user, 2026-10-13: *"remove language and
  // English is default."* The interface language is `DEFAULT_LANGUAGE` ('en') ALWAYS — nothing in the
  // app can change it, so a stored blob from an older build that still carries `{language: 'pt'}`
  // decides nothing. `src/settingsStore.ts` no longer reads the key, and `src/i18n.ts` keeps the PT
  // table in place, unreachable.
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

  // ── which session types the list shows (0.8.0 D) ─────────────────────────────
  /**
   * The two checkboxes in Settings' "Session types" section. Defaults: conversations ON, job runs
   * OFF — the operator's "make the default view only actual sessions show up in the session list,
   * no cron jobs".
   */
  sessionTypes: SessionTypes;

  // ── checkpoint notifications (0.8.0 H) ──────────────────────────────────────
  notifications: NotifySettings;

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
  // 0.9.1 S4.1: `language: 'en'` lived here. There is no language setting any more — the app speaks
  // `DEFAULT_LANGUAGE` (English) and nothing can change it.
  // Tailscale auto-start is opt-in: route probing runs regardless, these only gate the broadcast
  // trigger and opening the Tailscale app on failure. Stored values on an existing install win.
  autoConnect: false,
  tailscalePackage: 'com.tailscale.ipn',
  connectDeadlineMs: 20_000,
  probeTimeoutMs: 1_500,
  openTailscaleOnFailure: false,
  insecureRouteAck: false,
  // 0.8.0 D: conversations are the default view; cron/webhook runs are off until asked for.
  sessionTypes: DEFAULT_SESSION_TYPES,
  // 0.8.0 H: off until the user asks — nothing polls and no permission is requested until then.
  notifications: DEFAULT_NOTIFY,
  everReachedGateway: false,
  lastTriggerResult: '',
  lastErrorKind: '',
  deviceId: '',
  deviceLabel: '',
  healNote: '',
};

export type StoredSettings = Omit<Settings, 'apiKey'>;

/**
 * Coerce a stored `sessionTypes` into the two-boolean shape. Anything missing or malformed falls
 * back to the DEFAULT for that bucket, which is what makes a 0.7.0 blob (no such key at all) load
 * as "conversations on, runs off" without a migration write.
 */
export function normalizeSessionTypes(value: unknown): SessionTypes {
  const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    sessions: typeof row.sessions === 'boolean' ? row.sessions : DEFAULT_SESSION_TYPES.sessions,
    automatic: typeof row.automatic === 'boolean' ? row.automatic : DEFAULT_SESSION_TYPES.automatic,
  };
}

/**
 * Coerce a stored `notifications` object. Same rule as `sessionTypes`: per-field, default on a
 * missing or malformed value, so a 0.7.0 blob (no such key) loads as "off, both kinds armed" and a
 * half-written key cannot take the other fields down with it.
 */
export function normalizeNotify(value: unknown): NotifySettings {
  const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const bool = (key: keyof NotifySettings): boolean =>
    typeof row[key] === 'boolean' ? (row[key] as boolean) : DEFAULT_NOTIFY[key];
  return { enabled: bool('enabled'), waiting: bool('waiting'), finished: bool('finished') };
}

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
