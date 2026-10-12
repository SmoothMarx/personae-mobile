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

// ───────────────────────────────── 0.9.0 F (landscape): a short viewport ──

/**
 * The sheet's cap, as a fraction of the viewport, for a viewport of this height.
 *
 * 0.8.0's `maxHeight: '80%'` is right in portrait and wrong in landscape, because 80% is a fraction
 * of a *short* height: 80% of 360 dp is 288 dp of sheet, of which the title and the two prompt
 * buttons take a fixed ~120 — leaving almost nothing for the entries. A short viewport therefore gets
 * MORE of itself (92%), which is the difference between a list you can scroll and a list you cannot.
 *
 * The failure mode this avoids is the interesting one: "usable at a short height" is not the same ask
 * as "usable at a tall height, scaled", and a rule written as one number cannot express both.
 */
export const SHEET_FRACTION = { tall: 0.8, short: 0.92 } as const;

export function sheetHeightFraction(viewportHeight: unknown): number {
  const short =
    typeof viewportHeight === 'number' && Number.isFinite(viewportHeight) && viewportHeight > 0 && viewportHeight < 480;
  return short ? SHEET_FRACTION.short : SHEET_FRACTION.tall;
}

/**
 * The `maxHeight` string the sheet style wants. `undefined`/NaN falls back to the tall fraction.
 * The return type is React Native's own percentage template, so the style block stays type-checked
 * instead of needing a cast at the call site.
 */
export function sheetMaxHeight(viewportHeight: unknown): `${number}%` {
  return `${Math.round(sheetHeightFraction(viewportHeight) * 100)}%`;
}
