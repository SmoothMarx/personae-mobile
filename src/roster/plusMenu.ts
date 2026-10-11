/**
 * The single "+" at the top of the roster (0.7.0) — three ways to create something.
 *
 * 0.6.1 scattered creation: a folder icon in the header made a group, `new-session` lived in each
 * profile's long-press menu, and a profile could not be created from the phone at all. 0.7.0 puts ONE
 * control at the top with three entries:
 *
 *   New group    → the existing group-name prompt
 *   New profile  → POST /api/profiles (dashboard only), then a roster refresh
 *   New session  → a modal listing every profile, then the existing title prompt
 *
 * Reference note, deliberately not followed: Telegram's own compose action is a bottom-right FAB
 * (Figma `59:1953`, 53 × 53). the user asked for the top. That departure is the requirement.
 *
 * Why the entries are DATA: `app/index.tsx` cannot be rendered on this host, so "the + has exactly
 * these three entries", "the picker lists every profile" and "the profile entry is disabled WITH the
 * reason when creation is refused" would otherwise be unverifiable claims about JSX. Here they are
 * functions the suite can call. Labels are keys, resolved by the screen's one resolver (`menuLabel`),
 * exactly like `src/roster/menus.ts`.
 */

import { t } from '../i18n';
import type { Surface } from '../settings';

export type PlusKey = 'new-group' | 'new-profile' | 'new-session';

export const PLUS_KEYS: readonly PlusKey[] = ['new-group', 'new-profile', 'new-session'];

export type PlusEntry = {
  key: PlusKey;
  /** A key into the string table, resolved by the screen (`menuLabel`). */
  label: string;
  icon: string;
  /** Rendered, not hidden: the user sees the verb and why it cannot be used. */
  disabled?: boolean;
  /** Present exactly when `disabled` is: always a full sentence, never a code. */
  reason?: string;
};

export type PlusState = {
  surface: Surface;
  /** The last refusal from `POST /api/profiles`, if any. */
  refusal: { status: number; message: string } | null;
};

/**
 * The three entries, in order, with the profile entry disabled and EXPLAINED when it cannot work:
 *   * on the legacy `:9222` surface there is no profile route at all;
 *   * and after a real refusal (401/403/400) the reason the server gave is shown, so a phone whose
 *     credential may not create profiles never looks like a button that silently does nothing.
 */
export function plusMenuEntries(state: PlusState): PlusEntry[] {
  const entries: PlusEntry[] = [
    { key: 'new-group', label: 'newGroup', icon: 'folder-outline' },
    { key: 'new-profile', label: 'newProfile', icon: 'person-add-outline' },
    { key: 'new-session', label: 'newSession', icon: 'chatbubble-ellipses-outline' },
  ];
  return entries.map((entry) => {
    if (entry.key !== 'new-profile') return entry;
    if (state.surface !== 'dashboard') {
      return { ...entry, disabled: true, reason: t.plus.createUnavailable };
    }
    if (state.refusal) {
      return { ...entry, disabled: true, reason: t.plus.createRefused(state.refusal.message) };
    }
    return entry;
  });
}

/**
 * Every profile, as picker rows — the "New session" modal's whole content. The label is the display
 * label (falling back to the name), and the name is appended when the two differ, because a session
 * is filed under the NAME and the user should see which one they are choosing.
 */
export function profilePickerEntries(profiles: { name: string; label: string }[]) {
  return profiles.map((profile) => {
    const label = profile.label || profile.name;
    return {
      key: `profile:${profile.name}`,
      label: label === profile.name ? profile.name : `${label} · ${profile.name}`,
      icon: 'person-outline',
    };
  });
}

/** The profile a picker row refers to. '' when the key is not a profile row. */
export function profileFromPickerKey(key: string): string {
  return key.startsWith('profile:') ? key.slice('profile:'.length) : '';
}

/**
 * A profile name the dashboard will accept: lower-case, `-` for spaces, nothing exotic. The
 * dashboard validates the name itself, so this is not a substitute for that check — it just avoids
 * asking for something that was never going to work. `null` = unusable, and the screen says so.
 */
export function profileSlug(raw: string): string | null {
  const slug = (raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug || null;
}
