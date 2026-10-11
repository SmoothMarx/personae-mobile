/**
 * The roster model — everything the main screen renders, as pure data.
 *
 * This is the piece that makes the 0.5.0 shape testable offline. `app/index.tsx` becomes a renderer
 * over the value this module returns, so "cron is not in the feed", "a failed profile list does not
 * invent a contact", "search reveals the matching sessions under their profile" and "expansion is
 * per-profile" are all assertable without a device, a renderer or a live box.
 *
 * Fidelity note: the reference of record is `hermes-desktop-plugins/personae/plugin.js` — the rail
 * (`SESSIONS_PER_PROFILE`, preview + age per face), `NON_CONVERSATION_SOURCES`:179, `searchInSessions`
 * :1996, and the auto-expand rule (a hit inside a profile is drawn under that profile, so the
 * profile opens).
 *
 * MEASURED CORRECTION (2026-10-11, `logs/roster-2026-10-11.txt`): the brief and the plugin's own
 * comment say the sidebar's `recents` slice carries no cron runs. On the live box it DOES — the
 * slice came back `{desktop: 22, cli: 6, cron: 6, api_server: 1, tui: 1}`. So the filter here is not
 * belt-and-braces: it is load-bearing, and it runs on the `recents` path exactly as it does on the
 * rail path. Never take the slice's name as a guarantee about its contents.
 */

import { formatAge, firstLine, initialOf, toMillis } from '../format';
import { t } from '../i18n';
import type { HermesSession } from '../api/client';
import type { ProfileInfo } from '../api/backend';
import type { DotState, Rollup } from './lights';
import { IDLE_ROLLUP, dotStateFor, profileRollup } from './lights';
import { sessionTitle, toRow, type SessionRow } from './roster';
import type { SectionsModel, SortMode } from './sections';
import { UNASSIGNED, sectionOf } from './sections';

/** A session as the roster sees it — the rail tags every row with the profile it came from. */
export type FeedSession = HermesSession & { profile?: string | null };

/**
 * Sources that are job runs, never conversations a human resumes. Verbatim from the plugin
 * (`NON_CONVERSATION_SOURCES`, plugin.js:179) — `cron_output` is a pane-side token, and the
 * backend's own listing deny-list covers `webhook` too, so this is belt-and-braces in both
 * directions. A scheduler run must never be drawn as if it were a chat.
 */
export const NON_CONVERSATION_SOURCES = new Set(['cron', 'cron_output', 'webhook']);

export function isAutomatic(session: HermesSession | null | undefined): boolean {
  return NON_CONVERSATION_SOURCES.has(String(session?.source ?? '').trim().toLowerCase());
}

/** The feed: conversations only. This is the function the "no cron in the roster" test pins. */
export function conversations(sessions: FeedSession[]): FeedSession[] {
  return sessions.filter((session) => !isAutomatic(session));
}

/** The runs: what the feed deliberately leaves out, kept reachable under their own profile. */
export function automaticRuns(sessions: FeedSession[]): FeedSession[] {
  return sessions.filter((session) => isAutomatic(session));
}

export function profileOf(session: FeedSession): string {
  const name = String(session.profile ?? '').trim();
  return name || 'default';
}

/** Newest first, by `last_active` then `started_at`. Undated rows keep their relative order. */
export function byActivity(a: HermesSession, b: HermesSession): number {
  const left = toMillis(a.last_active ?? a.started_at) ?? 0;
  const right = toMillis(b.last_active ?? b.started_at) ?? 0;
  return right - left;
}

/** Group the feed by the profile each session belongs to. */
export function groupByProfile(sessions: FeedSession[]): Record<string, FeedSession[]> {
  const out: Record<string, FeedSession[]> = {};
  for (const session of sessions) {
    const name = profileOf(session);
    (out[name] ??= []).push(session);
  }
  for (const list of Object.values(out)) list.sort(byActivity);
  return out;
}

// ────────────────────────────────────────────────────────── contacts (F7) ──

export type RosterContact = {
  name: string;
  label: string;
  isDefault: boolean;
  hasAvatar: boolean | null;
  model?: string | null;
  provider?: string | null;
  gatewayRunning?: boolean;
};

export type ContactsResult = {
  contacts: RosterContact[];
  /** Non-null when the surface HAS profiles but the list would not load — never swallowed. */
  error: unknown | null;
  /** True when the list came from the server; false when it is the declared fallback. */
  fromServer: boolean;
};

/**
 * The F7 rule, as a function.
 *
 *  * a surface WITH a profile route that answers: the server's own rows;
 *  * a surface WITH a profile route that FAILS: **no contacts at all** and the error handed back —
 *    the screen shows the connectivity banner and the real error. It must never fabricate a
 *    one-contact roster, because the user cannot then tell "no profiles" from "not connected".
 *  * a surface with NO profile route (the legacy `:9222` api_server): the user's own declared
 *    profiles are the honest answer, and they are labelled as declared, not discovered.
 */
export function rosterContacts(input: {
  hasProfiles: boolean;
  profiles: ProfileInfo[];
  declared: string[];
  error?: unknown | null;
}): ContactsResult {
  if (input.hasProfiles) {
    if (input.profiles.length) {
      return {
        contacts: input.profiles.map((row) => ({
          name: row.name,
          label: row.label || row.name,
          isDefault: row.isDefault,
          hasAvatar: row.hasAvatar ?? null,
          model: row.model,
          provider: row.provider,
          gatewayRunning: row.gatewayRunning,
        })),
        error: null,
        fromServer: true,
      };
    }
    return { contacts: [], error: input.error ?? null, fromServer: false };
  }
  return {
    contacts: input.declared.map((name) => ({
      name,
      label: name,
      isDefault: name === 'default',
      hasAvatar: null,
    })),
    error: null,
    fromServer: false,
  };
}

// ────────────────────────────────────────────────────────────── search ──

export type SearchHit = {
  profile: string;
  sessionId: string;
  snippet: string;
  source: 'metadata' | 'body';
};

export type SearchResult = {
  needle: string;
  /** Sessions that matched the local metadata sweep (title / preview / id). */
  hits: SearchHit[];
  /** Profiles revealed by a *body* hit on the server — the ones that must auto-expand. */
  bodyProfiles: string[];
  /** Every profile whose name matched the needle. */
  profileHits: string[];
  /** Profiles that must be expanded because a hit lives inside them (the plugin's rule). */
  autoExpand: string[];
  /** Body hits the server returned whose session is not in the loaded feed — say so, don't guess. */
  unplaced?: number;
};

export function normalizeNeedle(needle: string): string {
  return needle.trim().toLowerCase();
}

/** Does a session's *metadata* match? (The local sweep; bodies need the server, see below.) */
export function sessionMatches(session: FeedSession, needle: string): boolean {
  const q = normalizeNeedle(needle);
  if (!q) return false;
  const haystack = [session.title, session.preview, session.id].map((value) => String(value ?? '').toLowerCase());
  return haystack.some((value) => value.includes(q));
}

export function profileMatches(profile: { name: string; label: string }, needle: string): boolean {
  const q = normalizeNeedle(needle);
  if (!q) return false;
  return profile.name.toLowerCase().includes(q) || profile.label.toLowerCase().includes(q);
}

/**
 * The search plan: which requests one settled query makes.
 *
 * Measured on the live box (2026-10-11, `logs/roster-2026-10-11.txt`):
 *   `…/search?q=plugin&profile=all` → **404** `{"detail":"Profile 'all' does not exist."}`
 *   `…/search?q=plugin&profile=cody` → 200, results
 *   `…/search?q=plugin`              → 200, results — an OMITTED profile serves the whole box
 *
 * So the default plan is **ONE server-wide request**, whatever the number of profiles. That is the
 * answer to R5's "must not fire 22 requests per keystroke" — it is one request per *settled* query,
 * and the results are attributed to profiles locally by `attributeBodyHits`.
 *
 * `perProfile: true` keeps the other route available (one request per profile, for a caller that
 * wants the server to do the scoping). It is deduped and capped, so even that path cannot fan out
 * without bound.
 */
export function bodySearchPlan(
  profiles: string[],
  needle: string,
  options: { perProfile?: boolean; cap?: number } = {},
): string[] {
  const q = normalizeNeedle(needle);
  if (!q) return [];
  if (!options.perProfile) return [''];
  if (!profiles.length) return [];
  const cap = options.cap ?? 32;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const profile of profiles) {
    const name = String(profile || 'default');
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Attribute server body hits to the profile that owns the session.
 *
 * The response carries only `session_id`, so the profile comes from the feed the app already holds.
 * A hit whose session is not in the loaded feed cannot be placed under a face, and it is DROPPED
 * rather than guessed at — `unplaced` counts them so the screen can say so out loud.
 */
export function attributeBodyHits(
  sessions: (HermesSession & { profile?: string | null })[],
  hits: { session_id: string; snippet?: string; role?: string }[],
): { perProfile: Record<string, { session_id: string; snippet: string }[]>; unplaced: number } {
  const owner = new Map<string, string>();
  for (const session of sessions) owner.set(session.id, profileOf(session));
  const perProfile: Record<string, { session_id: string; snippet: string }[]> = {};
  let unplaced = 0;
  for (const hit of hits ?? []) {
    const id = String(hit?.session_id ?? '');
    if (!id) continue;
    const profile = owner.get(id);
    if (!profile) {
      unplaced += 1;
      continue;
    }
    (perProfile[profile] ??= []).push({ session_id: id, snippet: String(hit.snippet ?? '') });
  }
  return { perProfile, unplaced };
}

/** Fold server body hits into the sweep's result — the plugin's `mergeBodyHits`, kept as data. */
export function mergeBodyHits(
  result: SearchResult,
  perProfile: Record<string, { session_id?: string; snippet?: string }[]>,
  unplaced = 0,
): SearchResult {
  const hits = [...result.hits];
  const bodyProfiles = new Set(result.bodyProfiles);
  const known = new Set(hits.map((hit) => `${hit.profile}\u0000${hit.sessionId}`));
  for (const [profile, rows] of Object.entries(perProfile)) {
    for (const row of rows ?? []) {
      const sessionId = String(row?.session_id ?? '');
      if (!sessionId) continue;
      const key = `${profile}\u0000${sessionId}`;
      if (known.has(key)) continue;
      known.add(key);
      bodyProfiles.add(profile);
      hits.push({
        profile,
        sessionId,
        snippet: String(row.snippet ?? '').replace(/>>>|<<</g, ''),
        source: 'body',
      });
    }
  }
  const autoExpand = Array.from(new Set([...result.autoExpand, ...bodyProfiles, ...hits.map((hit) => hit.profile)]));
  return { ...result, hits, bodyProfiles: Array.from(bodyProfiles), autoExpand, unplaced: (result.unplaced ?? 0) + unplaced };
}

/**
 * The whole search: the metadata sweep over the loaded feed, the profile-name sweep, and the
 * auto-expand set. The body pass is merged in afterwards by `mergeBodyHits` once the server answers.
 */
export function searchRoster(input: {
  needle: string;
  profiles: { name: string; label: string }[];
  sessions: FeedSession[];
  sections?: SectionsModel;
}): SearchResult {
  const needle = normalizeNeedle(input.needle);
  if (!needle) return { needle: '', hits: [], bodyProfiles: [], profileHits: [], autoExpand: [] };

  const hits: SearchHit[] = [];
  for (const session of conversations(input.sessions)) {
    if (!sessionMatches(session, needle)) continue;
    hits.push({
      profile: profileOf(session),
      sessionId: session.id,
      snippet: firstLine(String(session.preview ?? session.title ?? '')),
      source: 'metadata',
    });
  }
  const profileHits = input.profiles.filter((row) => profileMatches(row, needle)).map((row) => row.name);
  // The plugin's rule, exactly: a hit inside a profile is shown under it, so the profile opens.
  const autoExpand = Array.from(new Set([...hits.map((hit) => hit.profile), ...profileHits]));
  return { needle, hits, bodyProfiles: [], profileHits, autoExpand };
}

// ───────────────────────────────────────────────────────────── roster ──

export type ColourModel = {
  /** profile -> swatch */
  profiles: Record<string, string>;
  /** profile -> session id -> swatch (a session colour beats its profile's) */
  sessions: Record<string, Record<string, string>>;
  /** section id -> swatch — the middle layer, kept for fidelity with the desktop pane. */
  groups?: Record<string, string>;
};

export const EMPTY_COLOURS: ColourModel = { profiles: {}, sessions: {}, groups: {} };

/**
 * The thin alias R6 asks for: whatever the surface ends up exposing, this is the one place that
 * knows how to read it. A missing model, a missing profile and a missing session all resolve to
 * `null` — never an invented hue, never a crash.
 *
 * Override order is the plugin's (README "Colour"): a session colour beats everything, a profile
 * colour beats the neutral default. The group layer is deliberately NOT consulted here — it is
 * keyed by section, not by profile, and the caller that knows the section passes the merged value.
 */
export function coloursFor(model: ColourModel | null | undefined, profile: string, sessionId?: string): string | null {
  if (!model) return null;
  if (sessionId) {
    const perSession = model.sessions?.[profile]?.[sessionId];
    if (perSession) return perSession;
  }
  return model.profiles?.[profile] ?? null;
}

export type RosterProfileRow = {
  name: string;
  label: string;
  isDefault: boolean;
  hasAvatar: boolean | null;
  model?: string | null;
  provider?: string | null;
  /** The swatch this row paints with (session colours are resolved per session row). */
  color: string | null;
  sectionId: string;
  expanded: boolean;
  /** Revealed by search although it would otherwise be hidden. */
  hidden: boolean;
  /** Latest conversation's preview, for the collapsed row. */
  preview: string;
  age: string;
  dot: Rollup;
  lastActiveMs: number | null;
  /** Conversations, newest first. Only the *expanded* set is rendered in full. */
  sessions: SearchHit[];
  /** Job runs (cron/webhook), shown under their own profile, marked automatic. */
  automatic: SearchHit[];
};

export type RosterModel = {
  rows: RosterProfileRow[];
  /** How many sessions the sweep found, for "n resultados". */
  matches: number;
  /** Profiles the search must open (empty when there is no query). */
  autoExpand: string[];
  /** True when the response carried at least one cron/webhook run, whatever we did with it. */
  automaticSeen: number;
};

function toHit(session: FeedSession, profile: string): SearchHit {
  const row = toRow(session, 0);
  return { profile, sessionId: session.id, snippet: row.preview || row.title, source: 'metadata' };
}

/**
 * Build the roster.
 *
 * `sessions` is whatever the surface handed over — the sidebar's `recents` slice, or a scoped page
 * per profile. Job runs are separated here rather than filtered at the call site, so every caller
 * gets the same guarantee.
 */
export function buildRoster(input: {
  contacts: RosterContact[];
  sessions: FeedSession[];
  expanded: Set<string> | string[];
  hidden?: Set<string> | string[];
  colours?: ColourModel | null;
  sections?: SectionsModel;
  sort?: Record<string, SortMode>;
  search?: SearchResult | null;
  lastSeen?: Record<string, number>;
  now?: number;
  /** How many sessions of a profile are drawn before the rest are left to the lazy page. */
  perProfile?: number;
  /** Sessions fetched per profile on demand (R9) — merged in when the user expands the row. */
  loaded?: Record<string, FeedSession[]>;
}): RosterModel {
  const now = input.now ?? Date.now();
  const expanded = input.expanded instanceof Set ? input.expanded : new Set(input.expanded ?? []);
  const hidden = input.hidden instanceof Set ? input.hidden : new Set(input.hidden ?? []);
  const sections = input.sections;
  const perProfile = input.perProfile ?? 10;
  const search = input.search ?? null;
  const needle = search?.needle ?? '';

  // The feed: conversations only, from the batched slice plus anything lazily loaded per profile.
  const merged: FeedSession[] = [...input.sessions];
  for (const list of Object.values(input.loaded ?? {})) merged.push(...list);
  const feed = conversations(merged);
  const runs = automaticRuns(merged);
  const byProfile = groupByProfile(feed);
  const runsByProfile = groupByProfile(runs);
  const hitIds = new Map<string, SearchHit>();
  for (const hit of search?.hits ?? []) hitIds.set(`${hit.profile}\u0000${hit.sessionId}`, hit);

  const rows: RosterProfileRow[] = [];
  let matches = 0;

  for (const contact of input.contacts) {
    const name = contact.name;
    const all = byProfile[name] ?? [];
    const searching = Boolean(needle);
    const profileHit = Boolean(search?.profileHits.includes(name));
    const sessionHits = all.filter((session) => hitIds.has(`${name}\u0000${session.id}`));
    const bodyHits = (search?.hits ?? []).filter((hit) => hit.profile === name && hit.source === 'body');

    if (searching && !profileHit && !sessionHits.length && !bodyHits.length) continue;

    matches += sessionHits.length + bodyHits.length;

    const latest = all[0];
    const alreadyOpen = expanded.has(name) || Boolean(search?.autoExpand.includes(name));
    const isHidden = hidden.has(name) && !searching;
    const rowsForProfile = alreadyOpen ? (searching && !profileHit ? all : all.slice(0, perProfile)) : [];
    const rowSessions: SearchHit[] = rowsForProfile.map((session) => {
      const hit = hitIds.get(`${name}\u0000${session.id}`);
      if (hit) return { ...hit, snippet: hit.snippet || firstLine(String(session.preview ?? '')) };
      return toHit(session, name);
    });
    // A body hit whose session is not in the loaded page still has to be visible: it is why the
    // profile opened at all.
    for (const hit of bodyHits) {
      if (!rowSessions.some((row) => row.sessionId === hit.sessionId)) rowSessions.push(hit);
    }

    rows.push({
      name,
      label: contact.label,
      isDefault: contact.isDefault,
      hasAvatar: contact.hasAvatar,
      model: contact.model,
      provider: contact.provider,
      color: coloursFor(input.colours ?? null, name),
      sectionId: sections ? sectionOf(sections, name) : UNASSIGNED,
      expanded: alreadyOpen,
      hidden: isHidden,
      preview: latest ? firstLine(String(latest.preview ?? latest.title ?? '')) : '',
      age: latest ? formatAge(toMillis(latest.last_active ?? latest.started_at), now) : '',
      dot: profileRollup(all, input.lastSeen?.[name] ?? 0),
      lastActiveMs: latest ? toMillis(latest.last_active ?? latest.started_at) : null,
      sessions: searching ? rowSessions : rowsForProfile.length ? rowSessions : [],
      automatic: (runsByProfile[name] ?? []).slice(0, perProfile).map((session) => ({ ...toHit(session, name), source: 'metadata' as const })),
    });
  }

  const sort = input.sort ?? {};
  const mode: SortMode = sort.all ?? 'activity';
  rows.sort((a, b) => {
    if (mode === 'name') return a.label.localeCompare(b.label, 'pt');
    if (mode === 'sessions') return b.sessions.length - a.sessions.length;
    return (b.lastActiveMs ?? 0) - (a.lastActiveMs ?? 0);
  });

  return { rows, matches, autoExpand: search?.autoExpand ?? [], automaticSeen: runs.length };
}

/** A session row's display model, with the colour that fills it and its own dot. */
export type SessionRowModel = SessionRow & {
  profile: string;
  state: DotState;
  color: string | null;
};

export function sessionRowModels(
  hits: SearchHit[],
  sessions: FeedSession[],
  colours: ColourModel | null | undefined,
  now = Date.now(),
): SessionRowModel[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  return hits.map((hit) => {
    const session = byId.get(hit.sessionId);
    const base = session
      ? toRow(session, 0, now)
      : {
          id: hit.sessionId,
          title: hit.snippet || hit.sessionId,
          preview: hit.snippet,
          initial: initialOf(hit.snippet || hit.sessionId),
          age: '',
          date: '',
          count: '',
          model: '',
          pinned: false,
          isNew: false,
        };
    return {
      ...base,
      profile: hit.profile,
      state: dotStateFor(session ?? null),
      color: coloursFor(colours, hit.profile, hit.sessionId),
    };
  });
}

export { IDLE_ROLLUP };
