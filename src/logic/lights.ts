/**
 * Status lights — the plugin's semantics, on the fields the dashboard actually serves.
 *
 * Reference: `plugin.js:1781-1900` (`ROLLUP_DOT`, `ROLLUP_INK`, `dotStateFor`, `rosterRollups`) and
 * `PLAN-UI.md` §2.1. Three states, in priority order, and one count:
 *
 *   amber  `needs-input`  a session is blocked on you (a question pending) — the plugin's `waiting`
 *   emerald `unread`      activity you have not read — the row's `last_read_at` watermark
 *   neutral `idle`        nothing awaits you
 *
 * Two rules that are easy to get wrong, both the plugin's own:
 *
 *  1. **A profile's dot is the LOUDEST state among its sessions, not the state of its latest one.**
 *     Answering the newest session must not silence a row that still holds an older waiting one.
 *  2. **The badge counts `needs-input + unread` and is shown at 2 or more.** `working` (a turn
 *     merely running) is excluded from both the colour and the count: a session that is producing is
 *     not news about the profile, and a count that included it could not drop at the very moment the
 *     user had just answered it.
 *
 * Honesty about what this surface knows: the REST rows carry `last_read_at` but the RPC projection
 * drops `unread` (`plugin.js:47-52`), and a profile never read through has `last_read_at: null`.
 * Both cases resolve to *not unread* — the dot stays quiet rather than inventing a state.
 */

export type DotState = 'needs-input' | 'unread' | 'idle';

/** The subset of a session row the dot needs. Structural on purpose: extra fields are ignored. */
export type DotInput = {
  last_active?: number | null;
  started_at?: number | null;
  last_read_at?: number | null;
  waiting?: boolean | null;
  needs_input?: boolean | null;
  needsInput?: boolean | null;
  /** Live "a turn is running" hint. Deliberately NOT a dot state — see the header. */
  is_active?: boolean | null;
};

export type Rollup = {
  state: DotState;
  /** How many sessions are AWAITING the user — `needs-input` + `unread`. Never counts `working`. */
  count: number;
  counts: Record<DotState, number>;
  /** "new since my last visit" — the app's own watermark, deliberately NOT the dot. */
  fresh: number;
};

export const IDLE_ROLLUP: Rollup = { state: 'idle', count: 0, counts: { 'needs-input': 0, unread: 0, idle: 0 }, fresh: 0 };

/** Is this session blocked on the user? Tolerates the field being absent (then it is not). */
export function isWaiting(session: DotInput | null | undefined): boolean {
  if (!session) return false;
  return Boolean(session.waiting ?? session.needs_input ?? session.needsInput ?? false);
}

function toMs(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  // The dashboard emits epoch SECONDS; the same heuristic `src/format.ts` uses.
  return value > 10_000_000_000 ? value : Math.round(value * 1000);
}

/** Activity newer than the read watermark. A missing watermark is unknown, and unknown is quiet. */
export function isUnread(session: DotInput | null | undefined): boolean {
  if (!session) return false;
  const read = toMs(session.last_read_at);
  if (read === null) return false;
  const active = toMs(session.last_active ?? session.started_at);
  if (active === null) return false;
  return active > read;
}

/** The loudest state one session holds. `working` is not a state here — only the three above. */
export function dotStateFor(session: DotInput | null | undefined): DotState {
  if (isWaiting(session)) return 'needs-input';
  return isUnread(session) ? 'unread' : 'idle';
}

/**
 * The aggregate a profile row paints: loudest state, the awaiting count, the per-state split, and
 * how many sessions moved since `lastSeenMs` (the app's "new since my last visit" watermark).
 */
export function profileRollup(sessions: (DotInput | null | undefined)[], lastSeenMs = 0): Rollup {
  const counts: Record<DotState, number> = { 'needs-input': 0, unread: 0, idle: 0 };
  let fresh = 0;
  for (const session of sessions) {
    counts[dotStateFor(session)] += 1;
    const active = toMs(session?.last_active ?? session?.started_at ?? null);
    if (active !== null && lastSeenMs > 0 && active > lastSeenMs) fresh += 1;
  }
  const state: DotState = counts['needs-input'] > 0 ? 'needs-input' : counts.unread > 0 ? 'unread' : 'idle';
  return { state, count: counts['needs-input'] + counts.unread, counts, fresh };
}

/**
 * The badge is shown from TWO upwards, never for a lone one: one pending thing is already said by
 * the colour, and that is exactly why the number disappears the moment one of two is read while the
 * colour stays (README "Status lights").
 */
export function showBadge(rollup: Rollup): boolean {
  return rollup.count > 1;
}

/** Palette key for a dot state; the theme owns the actual colours. */
export function dotColorKey(state: DotState): 'amber' | 'green' | 'grey' {
  if (state === 'needs-input') return 'amber';
  if (state === 'unread') return 'green';
  return 'grey';
}
