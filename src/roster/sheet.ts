/**
 * The bottom sheet's geometry (0.8.0 F) — the arithmetic, away from the StyleSheet.
 *
 * The bug the operator reported: *"when clicking the + button on top, it opens the drawer at the
 * bottom, the items are cut off at the bottom."* The cause is in the code, not in the layout engine:
 * the sheet padded itself with `space.md` and never accounted for the phone's bottom inset, so on a
 * gesture-navigation device the last entry sat under the navigation bar.
 *
 * It lives in its own module for one reason: `src/roster/components.tsx` cannot be imported by the
 * test suite (it pulls React Native), so a number buried in its StyleSheet would be untestable — and
 * "the last entry is reachable" is exactly the kind of claim this repo insists on measuring.
 */

import { space } from '../theme';

/** The padding the sheet has always had, plus whatever the device reserves below it. */
export function sheetPadding(insets: { bottom?: number | null } | null | undefined): number {
  const bottom =
    typeof insets?.bottom === 'number' && Number.isFinite(insets.bottom) && insets.bottom > 0 ? insets.bottom : 0;
  return space.md + bottom;
}

/** A gesture-nav phone's bar, kept here so the tests and the story agree on one number. */
export const TYPICAL_GESTURE_INSET = 24;

/** The three-line Android navigation bar. */
export const TYPICAL_BUTTON_INSET = 48;
