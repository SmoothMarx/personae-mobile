/**
 * Named groups ("sections") — the plugin's own shape, ported.
 *
 * The reference of record is `hermes-desktop-plugins/personae/plugin.js`:
 *
 *   `EMPTY_SECTIONS = { collapsed: [], members: {}, order: {}, sections: [], sort: {} }`
 *   `SECTIONS_KEY  = 'messenger-sections-v1'`
 *   `normalizeSections()` :1240-1307 — the orphans/dedupe/unknown-mode rules
 *   `deleteSection()`     :1600-1615 — drops members, NEVER a session
 *   `moveToSection()`     :1617-1630 — ungrouped is the ABSENCE of a membership
 *
 * The same keys are kept verbatim so the later gateway-side store (PLAN-UI.md §6, "S1") can map
 * 1:1 without a translation layer — that is the whole reason this file is pure and shape-faithful.
 *
 * Three rules worth stating, because they are the ones a careless port gets wrong:
 *  1. a member of a section that no longer exists is an **orphan** — it falls back to ungrouped
 *     instead of resurrecting a deleted group;
 *  2. an unknown sort mode is **dropped**, never trusted, so a stale blob falls back to the default
 *     rather than to a mode that does nothing;
 *  3. deleting a group touches `sections`, `members` and `collapsed` and nothing else. Sessions are
 *     not this model's business at all, which is what makes "an honest delete" structural rather
 *     than a promise.
 */

export type Section = { id: string; name: string };

export const SORT_MODES = ['activity', 'name', 'sessions', 'manual'] as const;
export type SortMode = (typeof SORT_MODES)[number];

export type SectionsModel = {
  sections: Section[];
  /** profile name -> section id. An absent key IS "ungrouped" (never a sentinel id). */
  members: Record<string, string>;
  /** Section ids (plus the `UNASSIGNED` scope key) rendered collapsed. */
  collapsed: string[];
  /** scope id -> ordered profile names (the manual order the user dragged into place). */
  order: Record<string, string[]>;
  /** scope id -> sort mode. */
  sort: Record<string, SortMode>;
};

/** The scope key that stands for "the profiles that are in no group". Not a section id. */
export const UNASSIGNED = '__unassigned__';

export const EMPTY_SECTIONS: SectionsModel = {
  collapsed: [],
  members: {},
  order: {},
  sections: [],
  sort: {},
};

export const SECTIONS_STORE_KEY = 'personae.sections.v1';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Normalise whatever came out of storage into the model above.
 *
 * Faithful to `plugin.js:1240-1307`: unknown/duplicate/blank sections drop, orphan members drop,
 * orders for unknown scopes drop, and a bad sort mode drops rather than being carried.
 */
export function normalizeSections(value: unknown): SectionsModel {
  const source = asRecord(value);
  const seen = new Set<string>();
  const sections: Section[] = [];

  for (const entry of Array.isArray(source.sections) ? source.sections : []) {
    const record = asRecord(entry);
    const id = String(record.id ?? '').trim();
    const name = String(record.name ?? '').trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    sections.push({ id, name });
  }

  const members: Record<string, string> = {};
  const rawMembers = asRecord(source.members);
  for (const [profile, sectionId] of Object.entries(rawMembers)) {
    // Orphan rule: only a member of a section that is still here survives.
    if (seen.has(String(sectionId))) members[String(profile)] = String(sectionId);
  }

  const collapsed = (Array.isArray(source.collapsed) ? source.collapsed : [])
    .map(String)
    .filter((id) => id === UNASSIGNED || seen.has(id));

  const order: Record<string, string[]> = {};
  const rawOrder = asRecord(source.order);
  for (const [scope, list] of Object.entries(rawOrder)) {
    const key = String(scope);
    if (key !== UNASSIGNED && key !== 'all' && !seen.has(key)) continue;
    const names = (Array.isArray(list) ? list : []).map(String).filter(Boolean);
    if (names.length) order[key] = names;
  }

  const sort: Record<string, SortMode> = {};
  const rawSort = asRecord(source.sort);
  for (const [scope, mode] of Object.entries(rawSort)) {
    const key = String(scope);
    if ((key === UNASSIGNED || key === 'all' || seen.has(key)) && (SORT_MODES as readonly string[]).includes(String(mode))) {
      sort[key] = mode as SortMode;
    }
  }

  return { collapsed, members, order, sections, sort };
}

/** A stable, collision-free id derived from the name plus a counter — no randomness needed. */
export function newSectionId(name: string, existing: Section[] = []): string {
  const base =
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'grupo';
  const taken = new Set(existing.map((section) => section.id));
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

export function addSection(model: SectionsModel, name: string): SectionsModel {
  const clean = name.trim();
  if (!clean) return model;
  const id = newSectionId(clean, model.sections);
  return { ...model, sections: [...model.sections, { id, name: clean }] };
}

export function renameSection(model: SectionsModel, id: string, name: string): SectionsModel {
  const clean = name.trim();
  if (!clean) return model;
  return { ...model, sections: model.sections.map((section) => (section.id === id ? { ...section, name: clean } : section)) };
}

/**
 * Delete a group. Its members become ungrouped; nothing else moves.
 *
 * Sessions are not reachable from this model, so "deleting a group never deletes sessions" is a
 * property of the shape, not a behaviour someone has to remember to implement (plugin.js:1600).
 */
export function deleteSection(model: SectionsModel, id: string): SectionsModel {
  const members: Record<string, string> = {};
  for (const [profile, sectionId] of Object.entries(model.members)) {
    if (sectionId !== id) members[profile] = sectionId;
  }
  return {
    ...model,
    collapsed: model.collapsed.filter((key) => key !== id),
    members,
    sections: model.sections.filter((section) => section.id !== id),
  };
}

/** File profiles into a section, or back to ungrouped when `sectionId` is null. */
export function assignProfiles(model: SectionsModel, profiles: string[], sectionId: string | null): SectionsModel {
  const members = { ...model.members };
  for (const profile of profiles) {
    if (!sectionId) delete members[profile];
    else members[profile] = sectionId;
  }
  return { ...model, members };
}

export function toggleCollapsed(model: SectionsModel, id: string): SectionsModel {
  const collapsed = model.collapsed.includes(id)
    ? model.collapsed.filter((key) => key !== id)
    : [...model.collapsed, id];
  return { ...model, collapsed };
}

export function isCollapsed(model: SectionsModel, id: string): boolean {
  return model.collapsed.includes(id);
}

/** The section a profile belongs to, or `UNASSIGNED` when it is in none. */
export function sectionOf(model: SectionsModel, profile: string): string {
  const id = model.members[profile];
  if (!id) return UNASSIGNED;
  return model.sections.some((section) => section.id === id) ? id : UNASSIGNED;
}

export type RosterGroup<T> = { id: string; name: string; implicit: boolean; rows: T[] };

/**
 * The sections, in their declared order, followed by the implicit ungrouped section — and the
 * implicit one is only emitted when it actually holds something, so an empty roster never shows a
 * phantom heading. (An *empty declared* group is kept: it explains how to fill it, which is the
 * plugin's own rule.)
 */
export function groupsFor<T>(model: SectionsModel, rows: T[], nameOf: (row: T) => string, ungroupedLabel: string): RosterGroup<T>[] {
  const buckets = new Map<string, T[]>();
  for (const section of model.sections) buckets.set(section.id, []);
  const ungrouped: T[] = [];
  for (const row of rows) {
    const id = sectionOf(model, nameOf(row));
    const bucket = id === UNASSIGNED ? null : buckets.get(id);
    if (bucket) bucket.push(row);
    else ungrouped.push(row);
  }
  const groups: RosterGroup<T>[] = [];
  if (ungrouped.length) groups.push({ id: UNASSIGNED, name: ungroupedLabel, implicit: true, rows: ungrouped });
  for (const section of model.sections) {
    groups.push({ id: section.id, name: section.name, implicit: false, rows: buckets.get(section.id) ?? [] });
  }
  return groups;
}
