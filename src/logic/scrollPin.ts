/**
 * 0.14.0 W3 — THE SCROLL INTENT, as a pure rule.
 *
 * `onContentSizeChange` used to scroll to the end UNCONDITIONALLY, so every content-size change moved
 * the reader — including a layout change INSIDE one item, which is exactly what expanding a long
 * AI-generated block (a tool call) is: the box grows, the list's content height changes, and the reader
 * is dragged off whatever they were reading, back to the bottom. The list also had no notion of where
 * the reader WAS, so no rule about their position could be honoured; this module is that notion.
 *
 * Two facts, and they are separate on purpose:
 *
 *   * the reader's POSITION — `isPinned`, i.e. within `PIN_THRESHOLD_PX` of the end;
 *   * the INTENT — `scrollIntentFor` answers `'end'` only when a turn this screen just appended meets a
 *     reader who is pinned. A layout change appends nothing, so it can never produce `'end'`, whatever
 *     the pin state is. That is the whole fix: the scroll becomes a decision with two inputs, and only
 *     one of them ever comes from a layout change.
 *
 * Pure, so the rule is testable without a device; the screen wires it and decides nothing.
 */

/** How close to the end counts as "the reader is at the end". */
export const PIN_THRESHOLD_PX = 48;

/** What one content-size change should do. */
export type ScrollIntent = 'end' | 'none';

/** The reader's distance from the end, in px. Never negative; a metric that is not finite is "far". */
export function distanceFromEnd(input: { contentHeight: number; offsetY: number; layoutHeight: number }): number {
  const { contentHeight, offsetY, layoutHeight } = input;
  if (![contentHeight, offsetY, layoutHeight].every((value) => Number.isFinite(value))) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, contentHeight - (offsetY + layoutHeight));
}

/**
 * Is the reader at the end? Both bounds count as pinned: a list exactly as tall as its viewport is at
 * its end, and a reader sitting on the last pixel of a scrolled list is too.
 */
export function isPinned(input: { contentHeight: number; offsetY: number; layoutHeight: number }): boolean {
  return distanceFromEnd(input) <= PIN_THRESHOLD_PX;
}

/**
 * The intent for ONE content-size change. `appended` means "a turn this screen just appended arrived
 * with this change" — it is set where the turn is appended (the send/stream path, and the load), and
 * cleared after one scroll, so a change that appended nothing asks for nothing.
 */
export function scrollIntentFor(state: { pinned: boolean; appended: boolean }): ScrollIntent {
  return state.pinned && state.appended ? 'end' : 'none';
}
