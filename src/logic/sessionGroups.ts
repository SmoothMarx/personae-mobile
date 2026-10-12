/**
 * Session groups (0.9.0 Phase C) — the desktop pane's **Groups**, on the phone.
 *
 * This is 0.7.0's parked Phase D, and the shape is NOT invented here: it is `session-groups-v1` as
 * the desktop plug-in already stores and syncs it (`plugin.js` `normalizeSessionGroups` :702,
 * `profileSessionGroups` :767, `patchProfileGroups` :977), read out of that source rather than out of
 * its README. Profile → slice, and one slice is:
 *
 *   groups    [{ apropos: boolean, id, name, color: string | null }]   user-authored headings
 *   members   { "<sessionId>": "<groupId>" }                          arbitrary membership
 *   order     ["<groupId>", …]                                        the headings' order
 *   collapsed ["<groupId>", …]                                        which headings are shut
 *
 * THE THREE RULES a careless port gets wrong, all lifted from the desktop:
 *
 *  1. **A member of a group that no longer exists is an orphan** — it reads as ungrouped, and the
 *     normaliser DROPS the membership rather than resurrecting a dead heading.
 *  2. **`order` always ends up holding every group**, exactly once, so a group added by another
 *     client cannot become invisible; and a heading nobody counted still draws, at the end.
 *  3. **Deleting a group never deletes a session.** It touches `groups`, `order`, `collapsed` and the
 *     memberships that pointed at it, and nothing else — the sessions fall back into the flat list,
 *     where the user is looking. That is structural here, not a promise: this module has no access to
 *     a session and cannot delete one.
 *
 * This is a DIFFERENT noun from `src/logic/sections.ts`: sections are *profiles* filed into named
 * sections, groups are *sessions* filed into named groups, and neither may be collapsed into the
 * other. It is also not 0.8.0's type filter, which hides whole SOURCES.
 *
 * `apropos` and `color` are carried OPAQUELY. The phone does not render either; what it must not do
 * is drop them, because the same document is the desktop pane's, and a phone that writes back a
 * normalised slice without them silently deletes another client's data.
 */

export type SessionGroup = {
  id: string;
  name: string;
  /** Desktop-authored, carried opaquely (the phone renders no appropos affordance yet). */
  apropos: boolean;
  /** Desktop-authored, carried opaquely — a swatch string or null. */
  color: string | null;
};

export type SessionGroupSlice = {
  groups: SessionGroup[];
  members: Record<string, string>;
  order: string[];
  collapsed: string[];
};

/** The whole document: profile name → slice. */
export type SessionGroupsModel = Record<string, SessionGroupSlice>;

export const SESSION_GROUPS_STORE_KEY = 'personae.sessionGroups.v1';

/** The wire key the desktop and the phone share (its plugin-side name is `messenger-<this>`). */
export const SESSION_GROUPS_SYNC_KEY = 'session-groups-v1';

export function emptySlice(): SessionGroupSlice {
  return { groups: [], members: {}, order: [], collapsed: [] };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Coerce anything into a legal document. Malformed groups fall out; a membership pointing at a group
 * that is not here reads as ungrouped; `order` is completed with the groups it missed, so every group
 * is reachable.
 */
export function normalizeSessionGroups(value: unknown): SessionGroupsModel {
  const out: SessionGroupsModel = {};
  for (const [profile, raw] of Object.entries(asRecord(value))) {
    // Mirrors the desktop's own guard: a profile whose value is not an object is DROPPED, not
    // coerced into an empty slice (which would then be written back as real, empty state).
    if (!profile || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const source = asRecord(raw);
    const groups: SessionGroup[] = [];
    const seen = new Set<string>();
    for (const entry of Array.isArray(source.groups) ? source.groups : []) {
      const record = asRecord(entry);
      const id = String(record.id ?? '').trim();
      const name = String(record.name ?? '').trim();
      if (!id || !name || seen.has(id)) continue;
      seen.add(id);
      groups.push({
        id,
        name,
        // Opaque, but typed: anything that is not a string reads as absent.
        apropos: record.apropos === true,
        color: typeof record.color === 'string' && record.color.trim() ? String(record.color) : null,
      });
    }
    const members: Record<string, string> = {};
    for (const [session, groupId] of Object.entries(asRecord(source.members))) {
      if (seen.has(String(groupId))) members[String(session)] = String(groupId);
    }
    const order = (Array.isArray(source.order) ? source.order : [])
      .map(String)
      .filter((id) => seen.has(id))
      .filter((id, index, list) => list.indexOf(id) === index);
    for (const group of groups) if (!order.includes(group.id)) order.push(group.id);
    const collapsed = (Array.isArray(source.collapsed) ? source.collapsed : [])
      .map(String)
      .filter((id) => seen.has(id));
    out[profile] = { collapsed, groups, members, order };
  }
  return out;
}

/** One profile's slice, always a full shape — every reader gets arrays, never undefined. */
export function sliceFor(state: SessionGroupsModel | undefined, profile: string): SessionGroupSlice {
  const value = state?.[String(profile)];
  return value
    ? {
        groups: value.groups ?? [],
        members: value.members ?? {},
        order: value.order ?? [],
        collapsed: value.collapsed ?? [],
      }
    : emptySlice();
}

/**
 * Replace ONE profile's slice, leaving every other profile's alone.
 *
 * A no-op edit returns the SAME object. That is not a micro-optimisation: an identity-stable state is
 * what keeps a refused verb (filing into a group that does not exist, a blank rename, a move off the
 * end of the order) from producing a new `prefs` and therefore a needless shared-document write.
 */
export function patchSlice(
  state: SessionGroupsModel,
  profile: string,
  changes: Partial<SessionGroupSlice>,
): SessionGroupsModel {
  const key = String(profile);
  const merged = { ...sliceFor(state, key), ...changes };
  const next = normalizeSessionGroups({ ...state, [key]: merged });
  return JSON.stringify(sliceFor(next, key)) === JSON.stringify(sliceFor(state, key)) ? state : next;
}

/** `Group #1`, `Apropos #2`… — numbered past the highest of its own shape (the desktop's rule). */
export function numberedGroupName(names: readonly string[], prefix = 'Group #'): string {
  const used = names
    .map((name) => String(name ?? ''))
    .filter((name) => name.startsWith(prefix))
    .map((name) => Number(name.slice(prefix.length)))
    .filter((value) => Number.isFinite(value));
  return `${prefix}${used.length ? Math.max(...used) + 1 : 1}`;
}

/** A new heading, immediately named and immediately last (the desktop creates on click, no dialog). */
export function addGroup(state: SessionGroupsModel, profile: string, name?: string): { state: SessionGroupsModel; id: string; name: string } {
  const slice = sliceFor(state, profile);
  const id = `sg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const label = (name ?? '').trim() || numberedGroupName(slice.groups.map((group) => group.name));
  const next = patchSlice(state, profile, {
    groups: [...slice.groups, { id, name: label, apropos: false, color: null }],
    order: [...slice.order, id],
  });
  return { state: next, id, name: label };
}

export function renameGroup(state: SessionGroupsModel, profile: string, id: string, name: string): SessionGroupsModel {
  const label = (name ?? '').trim();
  if (!label) return state;
  const slice = sliceFor(state, profile);
  return patchSlice(state, profile, {
    groups: slice.groups.map((group) => (group.id === id ? { ...group, name: label } : group)),
  });
}

/**
 * Delete a heading. **Never a session**: the memberships that pointed at it are dropped, so those
 * sessions fall back into the flat list. `sessions` is not a parameter, which is what makes the rule
 * structural.
 */
export function deleteGroup(state: SessionGroupsModel, profile: string, id: string): SessionGroupsModel {
  const slice = sliceFor(state, profile);
  const members: Record<string, string> = {};
  for (const [session, groupId] of Object.entries(slice.members)) {
    if (groupId !== id) members[session] = groupId;
  }
  return patchSlice(state, profile, {
    groups: slice.groups.filter((group) => group.id !== id),
    order: slice.order.filter((entry) => entry !== id),
    collapsed: slice.collapsed.filter((entry) => entry !== id),
    members,
  });
}

/** File one session into one group, or out of every group (`groupId === null` = ungrouped). */
export function fileSession(
  state: SessionGroupsModel,
  profile: string,
  sessionId: string,
  groupId: string | null,
): SessionGroupsModel {
  const slice = sliceFor(state, profile);
  const members = { ...slice.members };
  if (groupId === null) delete members[sessionId];
  else if (slice.groups.some((group) => group.id === groupId)) members[sessionId] = groupId;
  return patchSlice(state, profile, { members });
}

/** File MANY sessions at once — one write, so a batch cannot half-apply. */
export function fileSessions(
  state: SessionGroupsModel,
  profile: string,
  sessionIds: readonly string[],
  groupId: string | null,
): SessionGroupsModel {
  const slice = sliceFor(state, profile);
  const members = { ...slice.members };
  for (const sessionId of sessionIds) {
    if (groupId === null) delete members[sessionId];
    else if (slice.groups.some((group) => group.id === groupId)) members[sessionId] = groupId;
  }
  return patchSlice(state, profile, { members });
}

export function toggleGroupCollapsed(state: SessionGroupsModel, profile: string, id: string): SessionGroupsModel {
  const slice = sliceFor(state, profile);
  const collapsed = slice.collapsed.includes(id)
    ? slice.collapsed.filter((entry) => entry !== id)
    : [...slice.collapsed, id];
  return patchSlice(state, profile, { collapsed });
}

export function isGroupCollapsed(state: SessionGroupsModel, profile: string, id: string): boolean {
  return sliceFor(state, profile).collapsed.includes(id);
}

/** Move a heading up or down in the user's own order (the desktop's Move up / Move down). */
export function moveGroup(state: SessionGroupsModel, profile: string, id: string, delta: number): SessionGroupsModel {
  const slice = sliceFor(state, profile);
  const order = [...slice.order];
  const index = order.indexOf(id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= order.length) return state;
  [order[index], order[target]] = [order[target], order[index]];
  return patchSlice(state, profile, { order });
}

/** Which group a session is in, or `null` (ungrouped — the ABSENCE of a membership). */
export function groupOf(state: SessionGroupsModel, profile: string, sessionId: string): string | null {
  return sliceFor(state, profile).members[sessionId] ?? null;
}

export type SessionGroupBlock = {
  /** The heading, or `null` for the anonymous block that holds everything unfiled. */
  group: SessionGroup | null;
  id: string;
  name: string;
  collapsed: boolean;
  /** Session ids, in the order they were handed over (recency, or the user's own order). */
  sessionIds: string[];
};

/**
 * The expanded list, grouped: each group in the user's order holding its sessions in the order they
 * arrived, then ONE anonymous block with everything unfiled.
 *
 * With no groups at all this is a single anonymous block — exactly the flat list it has always been,
 * so a profile nobody has filed anything into renders identically to 0.6.x. That property is what
 * makes this feature additive rather than a rewrite.
 */
export function sessionGroupBlocks(
  sessionIds: readonly string[],
  state: SessionGroupsModel | undefined,
  profile: string,
): SessionGroupBlock[] {
  const slice = sliceFor(state, profile);
  const ids = sessionIds.map(String).filter(Boolean);
  const blocks: SessionGroupBlock[] = [];
  const claimed = new Set<string>();
  for (const orderId of slice.order.length ? slice.order : slice.groups.map((group) => group.id)) {
    const group = slice.groups.find((entry) => entry.id === orderId);
    if (!group) continue;
    const mine = ids.filter((id) => slice.members[id] === group.id);
    mine.forEach((id) => claimed.add(id));
    blocks.push({
      group,
      id: group.id,
      name: group.name,
      collapsed: slice.collapsed.includes(group.id),
      sessionIds: mine,
    });
  }
  const loose = ids.filter((id) => !claimed.has(id));
  if (loose.length || blocks.length === 0) {
    blocks.push({ group: null, id: '__ungrouped__', name: '', collapsed: false, sessionIds: loose });
  }
  return blocks;
}
