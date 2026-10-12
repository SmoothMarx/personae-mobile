/**
 * Roster row geometry — the numbers, in one place, so they are assertable.
 *
 * Measured from the reference file the user linked (Figma fileKey `bbuc1DU76urt0JmakirYAd`, page `0:1`;
 * that canvas is 360 wide, so 1 px = 1 dp):
 *
 *   chat row `8:4771`            360 × 70
 *   avatar slot `8:4775` → circle `8:4776`   58 × 58 → 54 × 54
 *   text column `8:4778`         x = 70
 *   title `8:4780` / preview `8:4786`        19 dp / 18 dp, 27 dp pitch
 *   divider `8:4806`             inset to x = 78
 *   unread counter `8:4804`      24 × 24
 *
 * ONE MEASURED INCONSISTENCY, resolved deliberately. The reference table writes the text column as
 * "70 = 16 inset + 54 avatar + 16 gap" — which does not add up (16 + 54 + 16 = 86). Two of the three
 * numbers are load-bearing for this release and are quoted as measured: the **54 dp avatar**, the
 * **16 dp avatar→text gap** (both named in GOAL-0.7.0 §3 Phase A) and the row's **70 dp** height.
 * `textX` is therefore DERIVED from them (16 + 54 + 16 = 86) rather than copied as a digit that
 * cannot follow from its own definition; the divider keeps the reference's OWN inset (78), which
 * still clears the avatar (78 > 16 + 54 = 70).
 *
 * `titleMaxWidth` is the width the title actually gets. It exists so "a long profile name does not
 * truncate at 54 dp" is a test rather than an eyeball: the avatar grew by 26 dp (28 → 54) and that
 * 26 dp comes out of the row's CHROME (the age column and its gaps), never out of the title.
 *
 * 0.8.0 A — MORE AIR BETWEEN PROFILE ROWS. The operator asked for "a little bit more space between
 * profile rows". The cell IS the space (the divider sits at the bottom of the cell), so the ask is
 * the cell's height: the vertical padding goes 8 → **11** per side and the cell renders **76 dp**
 * (was 70, +8.6%). Deliberately the middle of the road: a bigger jump starts reading as a layout
 * bug, a smaller one is invisible on a phone. The two lines keep their 27 dp pitch, and the divider
 * inset and the horizontal inset are untouched.
 *
 * 0.8.0 B — AVATARS 15% BIGGER. `AVATAR_SIZE` 54 → 62 (54 × 1.15 = 62.1, taken down to a whole
 * number so no face has a half-pixel edge). Everything downstream stays DERIVED: `textX` becomes
 * 16 + 62 + 16 = 94 and the divider inset is `max(78, inset + avatar)` = 78, which still clears the
 * face. This is a deliberate departure from the Telegram reference measured for 0.7.0 (54 dp) —
 * the operator asked for +15%, so do not "fix" it back.
 */

import { AVATAR_SIZE } from '../logic/avatars';
import { radius as themeRadius } from '../theme';

/** The reference canvas' width in dp; 1 px there is 1 dp here. */
export const ROW_WIDTH = 360;

/** Row chrome that is not the avatar or the title: the age stamp and the caret. */
export const ROW_CHROME = {
  /** "agora" / "12 min" / "ontem" / "há 3 dias" all fit here. */
  ageWidth: 56,
  /** The disclosure caret at the row's end. */
  chevron: 12,
  /** Title column → age column. */
  titleAgeGap: 6,
  /** Age column → caret. */
  ageChevronGap: 4,
  /** The row's outer horizontal inset (the same 16 the avatar starts at). */
  inset: 16,
} as const;

export type RosterRowGeometry = {
  /** Row width the geometry was derived for. */
  width: number;
  /** Row height: two 27 dp lines (title + preview) with 8 dp of padding either side. */
  height: number;
  avatar: number;
  inset: number;
  /** The gap the plan names: avatar → text column. */
  avatarGap: number;
  /** Derived: inset + avatar + avatarGap. */
  textX: number;
  /** The reference's own divider inset — must clear the avatar. */
  dividerInset: number;
  titleSize: number;
  previewSize: number;
  /** The 27 dp line pitch both lines share. */
  linePitch: number;
  paddingVertical: number;
  ageWidth: number;
  /** How much horizontal room a title has before it has to ellipsize. */
  titleMaxWidth: number;
};

/** The reference's own divider inset, kept as the FLOOR the derived value may not go below. */
export const DIVIDER_REFERENCE_INSET = 78;

export function rosterRowGeometry(width: number = ROW_WIDTH): RosterRowGeometry {
  const linePitch = 27;
  // 0.8.0 A: 8 → 11. "A little bit more space between profile rows" IS the cell's height, because
  // the divider sits at the bottom of the cell — so the air the operator asked for is this number.
  const paddingVertical = 11;
  const inset = ROW_CHROME.inset;
  const avatarGap = 16;
  const textX = inset + AVATAR_SIZE + avatarGap;
  const titleMaxWidth =
    width - textX - ROW_CHROME.titleAgeGap - ROW_CHROME.ageWidth - ROW_CHROME.ageChevronGap - ROW_CHROME.chevron;
  return {
    width,
    height: linePitch * 2 + paddingVertical * 2,
    avatar: AVATAR_SIZE,
    inset,
    avatarGap,
    textX,
    // 0.8.0 B: DERIVED, never a bare digit again — the divider has to clear whatever the face is.
    // At 62 dp the face ends at 78, which is exactly the reference inset, so the floor is what wins.
    dividerInset: Math.max(DIVIDER_REFERENCE_INSET, inset + AVATAR_SIZE),
    titleSize: 19,
    previewSize: 18,
    linePitch,
    paddingVertical,
    ageWidth: ROW_CHROME.ageWidth,
    titleMaxWidth,
  };
}

/**
 * A deliberately crude width estimate for a single line of the system sans, used ONLY to turn
 * "the title does not truncate" into an assertion: 0.5 em per character, rounded up. Real glyph
 * advances average a little under 0.5 em for mixed-case Latin text, so this errs on the pessimistic
 * side — a name that fits by this estimate fits on the device, not the other way round.
 */
export function estimatedTextWidth(text: string, fontSize: number): number {
  return Math.ceil(text.length * fontSize * 0.5);
}

// ───────────────────────────────────── the session row's own column (0.8.0 C) ──

/**
 * 0.8.0 C — "when showing session list, make it less indented", and "the status dot should sit
 * UNDER the profile picture, offset a bit to the left".
 *
 * Through 0.7.x a session row was padded to the profile row's TEXT column (86 dp then, 94 dp now
 * that the face is 62) — the sessions were pushed as far right as the profile's name, which is what
 * the operator is asking to undo. The row's left padding becomes the DOT COLUMN instead:
 *
 *   dotX      30   the dot column starts here, not at the text column
 *   column    14   the dot column's own width (unchanged from 0.7.0)
 *   centre    37   derived: 30 + 14 / 2 — the dot is centred in its column
 *   gap        8   the same `space.sm` the row already used
 *   textX     52   derived: 30 + 14 + 8 — 34 dp less indented than 0.7.0's 86, 42 dp less than the
 *                  profile text column is now
 *
 * Why 30: the face spans [16, 78] (centre 43) and the dot's centre is 37, so the dot sits **6 dp
 * left of the face's centre** — the operator's "offset a bit to the left". It is deliberately NOT
 * derived from AVATAR_SIZE: the ask is a position under the picture, and deriving it would drag the
 * whole list sideways whenever the face changes size.
 *
 * Automatic (cron/webhook) rows keep this exact column and swap the dot for a clock glyph, so both
 * row species stay aligned.
 */
export const SESSION_DOT_COLUMN = 14;

export type SessionRowGeometry = {
  /** The dot column's left edge — the session row's left padding. */
  dotX: number;
  dotColumn: number;
  /** Derived: the dot's centre, so "offset a bit to the left" is a number, not an eyeball. */
  dotCentre: number;
  gap: number;
  /** Derived: where the session's title text starts. */
  textX: number;
};

export function sessionRowGeometry(): SessionRowGeometry {
  const dotX = 30;
  const gap = 8;
  return {
    dotX,
    dotColumn: SESSION_DOT_COLUMN,
    dotCentre: dotX + SESSION_DOT_COLUMN / 2,
    gap,
    textX: dotX + SESSION_DOT_COLUMN + gap,
  };
}

/** The profile face's centre on the same axis — the dot's anchor of reference (43 at 62 dp). */
export function faceCentre(geometry: RosterRowGeometry = rosterRowGeometry()): number {
  return geometry.inset + geometry.avatar / 2;
}

// ───────────────────────────────────────── the header's icons (0.8.0 G) ──

/** The one constant the operator's "+10% on the top buttons" is applied from. */
/** Was 1.1 in 0.8.0 G; 1.25 for 0.9.0 F ("make the + and settings buttons bigger"). */
export const HEADER_ICON_SCALE = 1.25;

/** The floor every touch target on this screen has to meet, whatever the glyph's size. */
export const MIN_TOUCH_TARGET = 44;

export type HeaderMetrics = {
  scale: number;
  /** The "+" glyph: 20 → 22. */
  add: number;
  /** Expand/collapse: 16 → 18 (17.6, rounded up to a legible whole number). */
  expand: number;
  /** Settings: the same 18 — one size for the two 16 dp glyphs. */
  settings: number;
  /** The pressable's own box, scaled by the same factor as the glyphs (was 38 × 34). */
  boxWidth: number;
  boxHeight: number;
  /** How far the touch area is inflated so the real target meets MIN_TOUCH_TARGET. */
  hitSlop: number;
  /** The effective target once hitSlop is applied — what a thumb actually gets. */
  target: number;
};

/**
 * 0.9.0 F — "make the + and settings buttons bigger, but with a transparent background".
 *
 * SUPERSEDED IN PLACE, old value kept: 0.8.0 G shipped **1.1** ("make the top buttons 10% bigger")
 * and its two tests asserted 22 / 18 / 42 × 37. The operator asked for BIGGER again in 0.9.0, so the
 * constant moves to **1.25** and the knock-ons move with it — but the property 0.8.0 established is
 * exactly the one being kept: THREE glyphs, ONE constant, and the box scales with the glyphs.
 *
 * At 1.25: add 20 → 25, expand 16 → 20, settings → 20, box 38 × 34 → 48 × 43. Three 48 dp boxes plus
 * the 16 dp insets leave 200 dp of title on a 360 dp bar, which still fits the longest label on this
 * box (15 characters ≈ 165 dp at 22 dp). The GLYPH and the TOUCH TARGET stay separate numbers: the
 * boxes are 48 × 43, so `hitSlop` is `ceil((44 − 43) / 2)` = 1 and the effective target is 45 × 45.
 *
 * The *background* is a style change, not a number: `styles.headerIcon` loses
 * `backgroundColor: colors.panelAlt`, so the glyphs sit on the screen with nothing behind them.
 */
export function headerMetrics(): HeaderMetrics {
  const scale = HEADER_ICON_SCALE;
  const add = Math.round(20 * scale);
  const expand = Math.round(16 * scale);
  const boxWidth = Math.round(38 * scale);
  const boxHeight = Math.round(34 * scale);
  const shortest = Math.min(boxWidth, boxHeight);
  const hitSlop = Math.max(0, Math.ceil((MIN_TOUCH_TARGET - shortest) / 2));
  return {
    scale,
    add,
    expand,
    settings: expand,
    boxWidth,
    boxHeight,
    hitSlop,
    target: shortest + hitSlop * 2,
  };
}

/** Does this title fit the row's title column at the reference's title size? */
export function titleFits(name: string, geometry: RosterRowGeometry = rosterRowGeometry()): boolean {
  return estimatedTextWidth(name, geometry.titleSize) <= geometry.titleMaxWidth;
}

// ─────────────────────────────────────────── the search bar (0.9.0 F) ──

/**
 * 0.9.0 F — "make the search bar rounded at the side, and increase it's height by 25%."
 *
 * Both numbers are DERIVED from the two constants below, and the height is asserted as the
 * derivation rather than as a literal — the same rule 0.8.0 B applied to the avatar (``54 × 1.15 =
 * 62.1, taken to a whole number``). `base` is 0.8.0's shipped 38 dp, kept here as the recorded
 * starting point so the "+25%" is a visible multiplication rather than a magic 48.
 *
 * `Math.ceil` because 38 × 1.25 = 47.5 and a half-pixel box is a blurry box; 0.8.0's convention for a
 * fractional scale (``geometry.ts:33``) is to round UP to a whole number of dp.
 *
 * `radius` is the palette's own pill token, not a new number, so "rounded at the side" means *fully*
 * rounded (a stadium) rather than "a bit more rounded than the 6 dp it was".
 */
export const SEARCH_BAR = {
  /** 0.8.0's shipped height (was a literal 38 in `components.tsx`). */
  base: 38,
  /** The operator's "+25%". */
  scale: 1.25,
} as const;

export function searchBarMetrics(): { base: number; scale: number; height: number; radius: number } {
  return {
    base: SEARCH_BAR.base,
    scale: SEARCH_BAR.scale,
    height: Math.ceil(SEARCH_BAR.base * SEARCH_BAR.scale),
    radius: themeRadius.pill,
  };
}
