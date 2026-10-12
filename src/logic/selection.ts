/**
 * Multiselect (0.9.0 Phase E) — the WhatsApp model, entered from the long press.
 *
 * the user, verbatim: *"The user can start long pressing on the row, it will show the options, but it
 * will also show the selection marks for multiselection."* So the held row ticks **immediately**, the
 * menu opens ON TOP of a live selection, and tapping further rows grows the set. The desktop's own
 * semantics are mirrored rather than re-derived (`plugin.js:3016-3110`):
 *
 *   * **selecting is a MODE, not a modifier key** (`:3022-3023`): while it is on, a row stops opening
 *     and starts ticking, and a bar appears whose verbs act on the whole set;
 *   * **emptying the set leaves the mode** (`:3035-3038`, quoting the user 2026-10-10: *"if the user
 *     unselects the last item and none are selected, stop the multiselect action"*) — a mode with
 *     nothing ticked has nothing to act on, and its bar would only read "0 selected";
 *   * **the batch resolves against what is ON SCREEN** (`:3091-3103`). The desktop had a real bug
 *     here: `profiles.list` carries no `sessions` array, so Select All, the counter and all five
 *     verbs silently did nothing. That is why nothing in this module knows about the roster — it is
 *     handed the keys of the RENDERED rows and can act on nothing else.
 *
 * A key is `profile|sessionId`, so a tick survives the roster reshuffling rows between polls.
 */

export type SelectionKey = string;

export type SelectionState = {
  /** The MODE. `false` = every row opens on tap, as before. */
  active: boolean;
  keys: SelectionKey[];
};

export const NO_SELECTION: SelectionState = { active: false, keys: [] };

/** `profile|sessionId` — the desktop's own key shape, so a message about a key reads the same. */
export function selectionKey(profile: string, sessionId: string): SelectionKey {
  return `${String(profile)}|${String(sessionId)}`;
}

export function parseSelectionKey(key: SelectionKey): { profile: string; sessionId: string } {
  const index = String(key).indexOf('|');
  return index < 0
    ? { profile: String(key), sessionId: '' }
    : { profile: String(key).slice(0, index), sessionId: String(key).slice(index + 1) };
}

/**
 * The held row ticks IMMEDIATELY and opens the mode — one call, because a menu that opens on top of a
 * selection that has not happened yet is the whole difference between the WhatsApp model and the
 * desktop's "enter the mode first, then right-click".
 */
export function beginSelection(state: SelectionState, key: SelectionKey): SelectionState {
  return { active: true, keys: state.keys.includes(key) ? state.keys : [...state.keys, key] };
}

/** Tick or untick. Unticking the LAST one leaves the mode (the desktop's rule, the user's own words). */
export function toggleKey(state: SelectionState, key: SelectionKey): SelectionState {
  const keys = state.keys.includes(key) ? state.keys.filter((entry) => entry !== key) : [...state.keys, key];
  return { active: keys.length > 0, keys };
}

/** Tap a row while the mode is on: it grows the set rather than opening a transcript. */
export function tapRow(state: SelectionState, key: SelectionKey): SelectionState {
  if (!state.active) return state;
  return toggleKey(state, key);
}

export function selectAll(keys: readonly SelectionKey[]): SelectionState {
  const unique = [...new Set(keys.map(String))];
  return { active: unique.length > 0, keys: unique };
}

/** Clear leaves the mode — "a mode with nothing ticked has nothing to act on". */
export function clearSelection(): SelectionState {
  return NO_SELECTION;
}

/**
 * The mode over a NEW set of rendered keys: a tick whose row is gone contributes nothing, so the
 * counter counts what the verbs will actually ACT on, not what was once ticked (the desktop's own
 * fix). When nothing survives, the mode ends.
 */
export function pruneSelection(state: SelectionState, visible: readonly SelectionKey[]): SelectionState {
  const live = new Set(visible.map(String));
  const keys = state.keys.filter((key) => live.has(key));
  return { active: state.active && keys.length > 0, keys };
}

/** What the bar counts, and what the batch verbs act on — the same number, from the same source. */
export function selectedKeys(state: SelectionState, visible: readonly SelectionKey[]): SelectionKey[] {
  const live = new Set(visible.map(String));
  return state.keys.filter((key) => live.has(key));
}

export function selectionCount(state: SelectionState, visible: readonly SelectionKey[]): number {
  return selectedKeys(state, visible).length;
}

/** Is a row ticked? A row that is not in the visible set can never look ticked. */
export function isTicked(state: SelectionState, key: SelectionKey, visible?: readonly SelectionKey[]): boolean {
  if (!state.active || !state.keys.includes(key)) return false;
  return visible ? visible.map(String).includes(String(key)) : true;
}

// ─────────────────────────────────────────────────────── the bar's verbs ──

export type BatchVerb = 'selectAll' | 'clear' | 'apropos' | 'close' | 'archive' | 'delete' | 'done';

/**
 * Every verb the desktop's bar carries, in its order (`SelectBar`, `plugin.js:6460-6508`).
 *
 * `apropos` is present and DISABLED with the reason, exactly as the session menu's Apropos entry is:
 * the dashboard publishes no `apropos.*` method, so a bar button that looked live would be the one
 * thing this repo forbids. `close` is `Session ▸ Close` (the session, not the bar) — the phone has no
 * `session.close` wiring yet, so it carries its reason too.
 */
export function barVerbs(): { key: BatchVerb; labelKey: string; icon: string; disabled?: boolean; reason?: string }[] {
  return [
    { key: 'selectAll', labelKey: 'selectAll', icon: 'checkmark-done-outline' },
    { key: 'clear', labelKey: 'clear', icon: 'close-circle-outline' },
    {
      key: 'apropos',
      labelKey: 'apropos',
      icon: 'sparkles-outline',
      disabled: true,
      reason: 'The gateway has no Apropos method; a topic group cannot be created from here.',
    },
    {
      key: 'close',
      labelKey: 'close',
      icon: 'log-out-outline',
      disabled: true,
      reason: 'Closing a session from the phone is not built yet.',
    },
    { key: 'archive', labelKey: 'archive', icon: 'archive-outline' },
    { key: 'delete', labelKey: 'delete', icon: 'trash-outline' },
    { key: 'done', labelKey: 'done', icon: 'checkmark-outline' },
  ];
}

/**
 * the user's inference, implemented as specified: **batch verbs once more than one row is ticked, the
 * single-object verbs when exactly one is.** Written as a function so the behaviour is a fact rather
 * than a reading of the JSX, and so a future change to it is visibly a change of KIND.
 */
export function verbScope(count: number): 'none' | 'single' | 'batch' {
  if (count <= 0) return 'none';
  return count === 1 ? 'single' : 'batch';
}

/**
 * The confirm sentence for a batch delete. Carries the COUNT, because a real delete burns message
 * history on the box and the user must be told how much.
 */
export function batchDeleteConfirm(count: number): string {
  return count === 1 ? '1 session' : `${count} sessions`;
}
