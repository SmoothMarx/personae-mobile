/**
 * Avatars (F1) — the cache, not the pixels.
 *
 * `profiles.get_asset` returns the avatar as a data URL (up to 2 MB), so the phone can render it
 * directly with no new route. What this module owns is the policy around fetching it:
 *
 *  * **once per profile per size per session** — a `Set` of in-flight/settled keys, so a re-render
 *    never re-fetches;
 *  * **memory first, then AsyncStorage**, keyed `profile + size`;
 *  * **never blocking the rail**: the caller paints the monogram and lets the avatar land later;
 *  * **the existence flag is advisory only.** The flag is `null` on the live dashboard for every
 *    profile even when the asset exists (measured 2026-10-11, `logs/p0.2-live-check.txt`), so
 *    `false` means "definitely none" and anything else means "unknown — try it".
 */

import { initialOf } from '../format';

export type AvatarStore = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

/**
 * 0.7.0: 28 → **54**, matching Telegram's own chat row (reference measured 2026-10-11: avatar slot
 * 58 × 58 holding a 54 × 54 circle, on a 360 × 70 row). `avatarKey()` carries the size, so this one
 * number also retires every 28 px blob sitting in AsyncStorage — no `AVATAR_VERSION` bump needed.
 * The row geometry that goes with it lives in `src/roster/geometry.ts`.
 */
export const AVATAR_SIZE = 54;
export const AVATAR_VERSION = 'v1';

/** Cache key: profile + size, versioned so a format change cannot serve a stale blob. */
export function avatarKey(profile: string, size: number = AVATAR_SIZE): string {
  return `personae.avatar.${AVATAR_VERSION}.${size}.${profile || 'default'}`;
}

/** The fallback the plan requires: the initial monogram, never a broken image. */
export function monogramFor(profile: string, label?: string): string {
  // Never an empty circle: an unnamed profile still gets a visible mark.
  return initialOf(label || profile) || '?';
}

/**
 * Should this profile's avatar be probed? `false` from `profiles.list` is a definite no; `null`
 * (what the REST route actually returns) and `undefined` are unknown, and unknown is worth one
 * background attempt.
 */
export function shouldProbeAvatar(hasAvatar: boolean | null | undefined): boolean {
  return hasAvatar !== false;
}

export type WrappedAvatar = { mime: string; base64: string } | null;

/**
 * RN's `<Image>` accepts a data URL directly, but it is worth validating before putting a
 * multi-megabyte string into component state: a malformed payload is treated as "no avatar".
 */
export function parseAvatarDataUrl(dataUrl: unknown): WrappedAvatar {
  if (typeof dataUrl !== 'string') return null;
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
  if (!match) return null;
  return { mime: match[1].toLowerCase(), base64: match[2].replace(/\s+/g, '') };
}

export function isImageDataUrl(value: unknown): value is string {
  return parseAvatarDataUrl(value) !== null;
}

export type AvatarCache = {
  /** Memory -> store; null when nothing is cached. */
  peek(profile: string, size?: number): string | null;
  /** Resolve from memory/store, then (once) from the network. Resolves to null when there is none. */
  load(profile: string, size: number, fetcher: () => Promise<string | null>): Promise<string | null>;
  /** AsyncStorage-backed warm-up; safe to call at mount. */
  warm(profile: string, size?: number): Promise<void>;
  /** Test/observability: how many network calls this cache has made. */
  readonly fetches: number;
};

export type AvatarCacheOptions = {
  store?: AvatarStore | null;
  /** Anything that is not a valid image data URL is discarded rather than rendered. */
  validate?: (dataUrl: string) => boolean;
};

export function createAvatarCache(options: AvatarCacheOptions = {}): AvatarCache {
  const memory = new Map<string, string>();
  const settled = new Set<string>();
  const inflight = new Map<string, Promise<string | null>>();
  const store = options.store ?? null;
  const validate = options.validate ?? isImageDataUrl;
  let fetches = 0;

  const peek = (profile: string, size = AVATAR_SIZE): string | null => memory.get(avatarKey(profile, size)) ?? null;

  const remember = (key: string, value: string): void => {
    memory.set(key, value);
    if (store) void store.setItem(key, value).catch(() => undefined);
  };

  async function warm(profile: string, size = AVATAR_SIZE): Promise<void> {
    const key = avatarKey(profile, size);
    if (!store || memory.has(key)) return;
    try {
      const cached = await store.getItem(key);
      if (cached && validate(cached)) memory.set(key, cached);
    } catch {
      /* a broken store must never break the roster */
    }
  }

  async function load(profile: string, size: number, fetcher: () => Promise<string | null>): Promise<string | null> {
    const key = avatarKey(profile, size);
    const cached = memory.get(key);
    if (cached) return cached;

    if (!settled.has(key)) {
      const existing = inflight.get(key);
      if (existing) return existing;
      const pending = (async () => {
        fetches += 1;
        try {
          const dataUrl = await fetcher();
          if (dataUrl && validate(dataUrl)) {
            remember(key, dataUrl);
            return dataUrl;
          }
          return null;
        } catch {
          return null;
        } finally {
          settled.add(key);
          inflight.delete(key);
        }
      })();
      inflight.set(key, pending);
      return pending;
    }

    // Settled but not in memory: the store may still have it (a previous session).
    await warm(profile, size);
    return memory.get(key) ?? null;
  }

  return {
    peek,
    load,
    warm,
    get fetches() {
      return fetches;
    },
  };
}

/** AsyncStorage-backed store; imported lazily so the logic stays testable without native modules. */
export function asyncStorageAvatarStore(storage: { getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void> }): AvatarStore {
  return {
    getItem: (key) => storage.getItem(key).catch(() => null),
    setItem: (key, value) => storage.setItem(key, value).catch(() => undefined),
  };
}
