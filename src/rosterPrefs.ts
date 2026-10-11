/**
 * Every roster preference, behind ONE module (§4).
 *
 * Groups, the expanded set, hidden profiles and colours are the pane's own local layout on the
 * desktop (`messenger-sections-v1`, `messenger-expanded-v1`, …): no network route owns them yet.
 * The gateway-side store that will eventually own them (PLAN-UI.md §6, "S1") is out of scope for
 * 0.5.0 — but the *backing* is not allowed to leak into the screens, so nothing outside this file
 * knows whether the data comes from secure-store, AsyncStorage or a server. Replacing the backing
 * means editing this module alone.
 *
 * Keys are deliberately one-per-concept and named after the plugin's own, so the future server
 * store maps 1:1 instead of needing a translation layer:
 *
 *   personae.sections.v1   ← messenger-sections-v1
 *   personae.expanded.v1   ← messenger-expanded-v1
 *   personae.hidden.v1     ← (the pane's hidden set; there it is core's `hidden` flag)
 *   personae.colours.v1    ← messenger-session-colors-v1 + the Bots store's profile colour
 */

import { SECTIONS_STORE_KEY, normalizeSections, type SectionsModel } from './logic/sections';
import { storeGet, storeSet } from './storage';
import type { ColourModel } from './logic/rosterFeed';

export const EXPANDED_STORE_KEY = 'personae.expanded.v1';
export const HIDDEN_STORE_KEY = 'personae.hidden.v1';
export const COLOURS_STORE_KEY = 'personae.colours.v1';

/**
 * The palette. A fixed set (never a free colour picker): the plugin validates against its own
 * swatch list, and a fixed set is what keeps a session's tint readable against the dark theme.
 * Eight hues plus "none" — "no fill is always an option: the status dot still carries the identity".
 */
export const SWATCHES = [
  '#4c8dff',
  '#3fb950',
  '#d29922',
  '#f85149',
  '#a371f7',
  '#39c5cf',
  '#db61a2',
  '#e3793a',
] as const;

export type RosterPrefs = {
  sections: SectionsModel;
  /** Only OPEN profiles are stored: closed is the default (plugin.js:301-316). */
  expanded: Record<string, true>;
  hidden: string[];
  colours: ColourModel;
};

export const EMPTY_PREFS: RosterPrefs = {
  sections: normalizeSections(null),
  expanded: {},
  hidden: [],
  colours: { profiles: {}, sessions: {}, groups: {} },
};

/**
 * Anything truthy opens the row (`{zulu: 'yes'}` is a yes); everything else is dropped, so a blob
 * that once held `false` for every profile the user ever tried does not grow without bound.
 */
export function normalizeExpanded(value: unknown): Record<string, true> {
  const out: Record<string, true> = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [name, open] of Object.entries(value as Record<string, unknown>)) {
      if (open) out[String(name)] = true;
    }
  }
  return out;
}

export function normalizeHidden(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const name = String(entry ?? '').trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Tolerates a missing/partial model: an unknown swatch becomes no colour rather than a raw string. */
export function normalizeColours(value: unknown): ColourModel {
  const out: ColourModel = { profiles: {}, sessions: {}, groups: {} };
  if (!value || typeof value !== 'object') return out;
  const source = value as Record<string, unknown>;
  const profiles = source.profiles;
  if (profiles && typeof profiles === 'object') {
    for (const [name, colour] of Object.entries(profiles as Record<string, unknown>)) {
      if (colour) out.profiles[String(name)] = String(colour);
    }
  }
  const sessions = source.sessions;
  if (sessions && typeof sessions === 'object') {
    for (const [name, map] of Object.entries(sessions as Record<string, unknown>)) {
      if (!map || typeof map !== 'object') continue;
      const inner: Record<string, string> = {};
      for (const [sessionId, colour] of Object.entries(map as Record<string, unknown>)) {
        if (colour) inner[String(sessionId)] = String(colour);
      }
      if (Object.keys(inner).length) out.sessions[String(name)] = inner;
    }
  }
  const groups = source.groups;
  if (groups && typeof groups === 'object') {
    for (const [id, colour] of Object.entries(groups as Record<string, unknown>)) {
      if (colour) out.groups![String(id)] = String(colour);
    }
  }
  return out;
}

function parse<T>(raw: string | null, fallback: T, read: (value: unknown) => T): T {
  if (!raw) return fallback;
  try {
    return read(JSON.parse(raw));
  } catch {
    return fallback;
  }
}

/** One read of every key. A corrupt blob degrades to the default rather than crashing the roster. */
export async function loadRosterPrefs(): Promise<RosterPrefs> {
  const [sectionsRaw, expandedRaw, hiddenRaw, coloursRaw] = await Promise.all([
    storeGet(SECTIONS_STORE_KEY),
    storeGet(EXPANDED_STORE_KEY),
    storeGet(HIDDEN_STORE_KEY),
    storeGet(COLOURS_STORE_KEY),
  ]);
  return {
    sections: parse(sectionsRaw, EMPTY_PREFS.sections, normalizeSections),
    expanded: parse(expandedRaw, {}, normalizeExpanded),
    hidden: parse(hiddenRaw, [], normalizeHidden),
    colours: parse(coloursRaw, EMPTY_PREFS.colours, normalizeColours),
  };
}

/** One write per key, only for the parts that changed. */
export async function saveRosterPrefs(prefs: RosterPrefs): Promise<void> {
  await Promise.all([
    storeSet(SECTIONS_STORE_KEY, JSON.stringify(prefs.sections)),
    storeSet(EXPANDED_STORE_KEY, JSON.stringify(prefs.expanded)),
    storeSet(HIDDEN_STORE_KEY, JSON.stringify(prefs.hidden)),
    storeSet(COLOURS_STORE_KEY, JSON.stringify(prefs.colours)),
  ]);
}

// ── expansion: a per-profile SET, several may be open at once (R2) ──

export function expandedNames(prefs: RosterPrefs): string[] {
  return Object.keys(prefs.expanded).filter((name) => prefs.expanded[name]);
}

export function isExpanded(prefs: RosterPrefs, profile: string): boolean {
  return Boolean(prefs.expanded[profile]);
}

export function toggleExpanded(prefs: RosterPrefs, profile: string): RosterPrefs {
  const expanded = { ...prefs.expanded };
  if (expanded[profile]) delete expanded[profile];
  else expanded[profile] = true;
  return { ...prefs, expanded };
}

/** Open these profiles without closing the others (what a search hit does). */
export function expandAll(prefs: RosterPrefs, profiles: string[]): RosterPrefs {
  if (!profiles.length) return prefs;
  const expanded = { ...prefs.expanded };
  for (const profile of profiles) expanded[profile] = true;
  return { ...prefs, expanded };
}

// ── hiding: a profile the user put away. Never touches its sessions. ──

export function toggleHidden(prefs: RosterPrefs, profile: string): RosterPrefs {
  const hidden = prefs.hidden.includes(profile)
    ? prefs.hidden.filter((name) => name !== profile)
    : [...prefs.hidden, profile];
  return { ...prefs, hidden };
}

export function isHidden(prefs: RosterPrefs, profile: string): boolean {
  return prefs.hidden.includes(profile);
}

// ── colours: a known swatch, or none. Nothing else is ever stored. ──

export function isSwatch(colour: string | null | undefined): boolean {
  return Boolean(colour) && (SWATCHES as readonly string[]).includes(String(colour));
}

export function setProfileColour(prefs: RosterPrefs, profile: string, colour: string | null): RosterPrefs {
  const profiles = { ...prefs.colours.profiles };
  if (isSwatch(colour)) profiles[profile] = String(colour);
  else delete profiles[profile];
  return { ...prefs, colours: { ...prefs.colours, profiles } };
}

export function setSessionColour(prefs: RosterPrefs, profile: string, sessionId: string, colour: string | null): RosterPrefs {
  const inner = { ...(prefs.colours.sessions[profile] ?? {}) };
  if (isSwatch(colour)) inner[sessionId] = String(colour);
  else delete inner[sessionId];
  const sessions = { ...prefs.colours.sessions };
  if (Object.keys(inner).length) sessions[profile] = inner;
  else delete sessions[profile];
  return { ...prefs, colours: { ...prefs.colours, sessions } };
}

export function setGroupColour(prefs: RosterPrefs, sectionId: string, colour: string | null): RosterPrefs {
  const groups = { ...(prefs.colours.groups ?? {}) };
  if (isSwatch(colour)) groups[sectionId] = String(colour);
  else delete groups[sectionId];
  return { ...prefs, colours: { ...prefs.colours, groups } };
}
