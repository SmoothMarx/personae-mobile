/**
 * Avatars (F1) — one cache, one component, one hook.
 *
 * The fetch itself lives in `src/logic/avatars.ts` (pure, unit-tested). This file is the React
 * half: a process-wide cache bound to AsyncStorage, a `<Avatar>` that renders 28 px circular
 * pixels with an initial-monogram fallback, and a hook that never blocks a paint — cached values
 * appear at once, unknown ones land in the background.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

import { t } from './i18n';
import {
  AVATAR_SIZE,
  asyncStorageAvatarStore,
  createAvatarCache,
  monogramFor,
  shouldProbeAvatar,
} from './logic/avatars';
import { colors } from './theme';

/** Process-wide: one fetch per profile per size per session, memory + AsyncStorage behind it. */
const cache = createAvatarCache({ store: asyncStorageAvatarStore(AsyncStorage) });

export function resetAvatarCacheForTests(): void {
  // Kept for symmetry with the rest of the suite; the cache itself is module-scoped on device.
}

export type AvatarSubject = { name: string; label?: string; hasAvatar?: boolean | null };

/**
 * Resolve avatars for a list of profiles, in the background.
 *
 * Returns a plain map so a caller can render immediately: a missing entry is simply "not yet" and
 * the monogram stands in. Unknown-existence profiles are probed (`hasAvatar === false` is a
 * definite no — the live dashboard returns `null` for every profile even when the asset exists).
 */
export function useAvatars(
  profiles: AvatarSubject[],
  load: (profile: string) => Promise<string | null>,
): Record<string, string | null> {
  const [urls, setUrls] = useState<Record<string, string | null>>({});
  const key = profiles.map((profile) => profile.name).join('|');

  useEffect(() => {
    let alive = true;
    const run = async () => {
      for (const profile of profiles) {
        await cache.warm(profile.name, AVATAR_SIZE);
        const hit = cache.peek(profile.name);
        if (hit && alive) setUrls((prev) => ({ ...prev, [profile.name]: hit }));
      }
      for (const profile of profiles) {
        if (!shouldProbeAvatar(profile.hasAvatar)) continue;
        const value = await cache.load(profile.name, AVATAR_SIZE, () => load(profile.name));
        if (!alive || value === null) continue;
        setUrls((prev) => (prev[profile.name] === value ? prev : { ...prev, [profile.name]: value }));
      }
    };
    void run();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the list identity is the profile set
  }, [key, load]);

  return urls;
}

export type AvatarProps = {
  name: string;
  label?: string;
  source?: string | null;
  size?: number;
};

/** 28 px, circular, cached, never blocking the rail; the monogram is the fallback (F1). */
export function Avatar({ name, label, source, size = AVATAR_SIZE }: AvatarProps) {
  const monogram = monogramFor(name, label);
  const round = { width: size, height: size, borderRadius: size / 2 };
  return (
    <View
      style={[styles.wrap, round]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={t.a11y.avatar(label || name)}
    >
      {source ? (
        <Image source={{ uri: source }} style={round} accessibilityIgnoresInvertColors />
      ) : (
        <Text style={[styles.monogram, { fontSize: Math.max(10, Math.round(size * 0.42)) }]}>
          {monogram}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.panelAlt,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  monogram: { color: colors.muted, fontWeight: '700' },
});
