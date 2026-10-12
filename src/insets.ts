/**
 * Safe-area arithmetic, as data (0.9.0 Phase F — landscape).
 *
 * WHY. Through 0.8.0 every screen applied `paddingTop: insets.top` and NOTHING horizontal, which is
 * correct in portrait and wrong in landscape: the cutout moves to a SIDE, and left/right are the
 * insets that matter. `app/index.tsx:359`, `app/thread/[id].tsx` and `app/settings.tsx` all had the
 * same hole.
 *
 * It is a pure module because the screens cannot be rendered on this host: "the roster honours the
 * horizontal insets" is only checkable if the arithmetic is a function the suite can call.
 */

export type EdgeInsets = { top?: number | null; left?: number | null; right?: number | null } | null | undefined;

/** A finite, non-negative inset — `useSafeAreaInsets` can be missing, NaN, or briefly negative. */
function edge(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The padding a full-screen surface applies.
 *
 * The horizontal value is **max(left, right), applied to BOTH sides**. That is deliberate: a
 * symmetric inset keeps every row, divider and sheet aligned to one axis, and the larger of the two
 * (the cutout side in landscape, the punch-hole side in portrait) is the one that has to be cleared.
 * Using each edge's own value would make the list subtly asymmetric and would put the divider inset
 * and the row inset on different axes.
 */
export function screenInsets(insets: EdgeInsets): { paddingTop: number; paddingLeft: number; paddingRight: number } {
  const horizontal = Math.max(edge(insets?.left), edge(insets?.right));
  return { paddingTop: edge(insets?.top), paddingLeft: horizontal, paddingRight: horizontal };
}

/** Just the horizontal half, for a screen that manages its own top (the thread's stack header does). */
export function horizontalInset(insets: EdgeInsets): number {
  return Math.max(edge(insets?.left), edge(insets?.right));
}

/** Is this viewport SHORT — landscape on a phone, or portrait with a keyboard up? */
export const SHORT_VIEWPORT_DP = 480;

export function isShortViewport(height: unknown): boolean {
  return typeof height === 'number' && Number.isFinite(height) && height > 0 && height < SHORT_VIEWPORT_DP;
}
