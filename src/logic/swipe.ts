/**
 * The swipe on a session row (0.8.0 E) — as a state machine, not as a gesture handler.
 *
 * The operator asked for a row that slides left to reveal an archive button (blue) and a delete
 * button (red trash, "where the user can confirm delete"). Everything that is easy to get wrong
 * about that lives here, as pure data:
 *
 *   * **exactly one row is open**, and opening another closes the first;
 *   * the **claim predicate** — `|dx| > 8 && |dx| > 1.2 × |dy|` — so a vertical scroll is never
 *     eaten and a tap never opens a row. This is the one rule the whole feature hangs on: the list
 *     is a `FlatList` and the row is a `PanResponder`, and a claim that fires too eagerly turns
 *     scrolling into swiping. That is why the numbers are here and not inline in the component.
 *   * the **settle rule** on release (distance OR velocity, and direction matters: only a LEFT
 *     slide reveals anything);
 *   * the **two-step confirm**: the first tap arms the delete, the second performs it, arming never
 *     dismisses the row, and the armed state is always escapable.
 *
 * The component is a thin shell over this: `Animated.Value` for the pixels, `PanResponder` for the
 * events, and every decision delegated here — which is how this repo tests UI without a phone.
 */

import { t } from '../i18n';
import type { Surface } from '../settings';

/** The two revealed verbs. */
export type SwipeAction = 'archive' | 'delete';

/** The reveal's own measurements. */
export const SWIPE = {
  /** How far the row travels when open: two buttons of 76 dp. */
  revealWidth: 152,
  /** The gesture is only claimed past this much horizontal travel — a tap never opens a row. */
  claimDx: 8,
  /** …and only when it is clearly horizontal, so a vertical scroll is never eaten. */
  claimRatio: 1.2,
  /** Released past this fraction of the reveal, the row settles OPEN. */
  openThreshold: 0.35,
  /** Flicks count too, in either direction. */
  velocity: 0.3,
} as const;

/** Which row is open, and which one is armed for the two-step delete. */
export type SwipeState = {
  /** The ONE row currently revealed. `null` = nothing is open. */
  openId: string | null;
  /** The row whose delete button is armed for a confirm. Always an open row. */
  armedId: string | null;
};

export const CLOSED_SWIPE: SwipeState = { openId: null, armedId: null };

/**
 * Should this gesture be claimed by the row rather than the list? A claim needs BOTH: enough
 * horizontal travel to be a slide at all, and a direction that is clearly horizontal. `dy` is
 * signed and `dx` may be either sign — the predicate is symmetric, so a right-slide is claimed and
 * then simply animates back closed.
 */
export function shouldClaim(dx: number, dy: number): boolean {
  return Math.abs(dx) > SWIPE.claimDx && Math.abs(dx) > SWIPE.claimRatio * Math.abs(dy);
}

/** Clamp a live drag to the reveal: the row may open left only, and never past the buttons. */
export function clampDrag(dx: number): number {
  return Math.max(-SWIPE.revealWidth, Math.min(0, dx));
}

/**
 * Where a release lands. Distance first, then a flick in either direction — a fast flick left
 * opens, a fast flick right closes, and everything else is decided by how far it travelled.
 */
export function settle(translationX: number, velocityX = 0): 'open' | 'closed' {
  if (velocityX <= -SWIPE.velocity) return 'open';
  if (velocityX >= SWIPE.velocity) return 'closed';
  const travelled = Math.max(0, -translationX);
  return travelled >= SWIPE.revealWidth * SWIPE.openThreshold ? 'open' : 'closed';
}

/** The x the row rests at when it is (not) open — what the animation targets. */
export function restX(open: boolean): number {
  return open ? -SWIPE.revealWidth : 0;
}

// ─────────────────────────────────────────────────────────── the machine ──

/** Open a row, closing whatever was open. A newly opened row is never armed. */
export function openRow(state: SwipeState, id: string): SwipeState {
  return { openId: id, armedId: null };
}

/** Close everything (a scroll, a tap elsewhere, a completed verb). */
export function closeRow(): SwipeState {
  return CLOSED_SWIPE;
}

/** Closing only if THIS row is the open one — so a stale row cannot close a fresh one. */
export function closeIfOpen(state: SwipeState, id: string): SwipeState {
  return state.openId === id ? CLOSED_SWIPE : state;
}

/**
 * The first tap on the red button. It ARMS the delete — it does not perform it — and it must not
 * dismiss the swipe, so the confirm stays visible under the user's thumb.
 */
export function armDelete(state: SwipeState, id: string): SwipeState {
  return { openId: id, armedId: id };
}

/** Back out of a confirm without running anything (an escape hatch that always exists). */
export function disarm(state: SwipeState): SwipeState {
  return { openId: state.openId, armedId: null };
}

export function isArmed(state: SwipeState, id: string): boolean {
  return state.armedId === id;
}

export function isOpen(state: SwipeState, id: string): boolean {
  return state.openId === id;
}

/**
 * The second tap. True only when the row really was armed: the delete verb is irreversible, so a
 * confirm that runs on an un-armed state would be the one bug worth a whole test.
 */
export function confirmDelete(state: SwipeState, id: string): boolean {
  return state.openId === id && state.armedId === id;
}

// ─────────────────────────────────────────────────────── surface honesty ──

export type ActionAvailability = {
  enabled: boolean;
  /** Why it cannot work — empty when it can. Never a tap that does nothing. */
  reason: string;
};

/**
 * On the dashboard both verbs exist. On the legacy `:9222` gateway surface the backend answers
 * `501 archiveUnsupported` / `501 deleteUnsupported` (`src/api/backend.ts`), so the buttons render
 * DISABLED carrying that same sentence — exactly like 0.7.0's "+" menu. Same words the API would
 * have used, so nothing can drift between what the button says and what the call would answer.
 */
export function actionAvailability(surface: Surface, action: SwipeAction): ActionAvailability {
  if (surface !== 'gateway') return { enabled: true, reason: '' };
  return { enabled: false, reason: action === 'archive' ? t.errors.archiveUnsupported : t.errors.deleteUnsupported };
}

export function actionLabel(action: SwipeAction): string {
  return action === 'archive' ? t.roster.swipe.archive : t.roster.swipe.delete;
}

/** The armed delete's label, so the second tap obviously means "yes, really". */
export function confirmLabel(): string {
  return t.roster.swipe.confirm;
}

/**
 * The same two verbs as screen-reader actions on the row, so they are reachable WITHOUT a gesture
 * (the long-press menu is the other non-gesture path, and it stays). A disabled action is not
 * offered at all: `accessibilityActions` cannot carry a reason, and silently doing nothing is the
 * one outcome this repo forbids.
 */
export function rowAccessibilityActions(surface: Surface): { name: string; label: string }[] {
  return (['archive', 'delete'] as SwipeAction[])
    .filter((action) => actionAvailability(surface, action).enabled)
    .map((action) => ({ name: action, label: actionLabel(action) }));
}

/** The colour pair the revealed buttons paint with — pinned in a test so a palette change shows. */
export function actionColour(action: SwipeAction, palette: { red: string; archive: string }): string {
  return action === 'archive' ? palette.archive : palette.red;
}
