/**
 * The one-line connectivity banner.
 *
 * Why it exists: "wrong port", "never logged in to Tailscale" and "no network at all" all used to
 * look like the same empty list. This says which one it is, in plain language, and never
 * self-dismisses — the notice stays until the state actually changes.
 */

import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Diagnostic } from './ConnectivityContext';
import { t } from './i18n';
import { colors, font, radius, space } from './theme';

export function ConnectivityBanner(props: {
  diagnostic: Diagnostic;
  busy: boolean;
  onRecheck: () => void;
  onOpenSettings: () => void;
}) {
  const { diagnostic, busy } = props;

  if (diagnostic.stage === 'connecting' || busy) {
    return (
      <View style={[styles.banner, styles.info]}>
        <ActivityIndicator color={colors.accent} size="small" />
        <Text style={styles.text} numberOfLines={2}>
          {t.connectivity.tunnelProbing}
        </Text>
      </View>
    );
  }

  if (diagnostic.message) {
    return (
      <View style={[styles.banner, styles.warn]}>
        <View style={styles.body}>
          <Text style={styles.text}>{diagnostic.message}</Text>
          {diagnostic.chosenRoute ? (
            <Text style={styles.detail} numberOfLines={1}>
              {diagnostic.chosenRoute.url}
            </Text>
          ) : null}
        </View>
        <Pressable onPress={props.onRecheck} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
          <Text style={styles.buttonText}>{t.connectivity.recheck}</Text>
        </Pressable>
        <Pressable onPress={props.onOpenSettings} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
          <Text style={styles.buttonText}>{t.roster.openSettings}</Text>
        </Pressable>
      </View>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    marginBottom: space.sm,
  },
  info: { borderColor: colors.border, backgroundColor: colors.panel },
  warn: { borderColor: colors.red, backgroundColor: colors.panel },
  body: { flex: 1, gap: 2 },
  text: { color: colors.text, fontSize: font.small, flexShrink: 1 },
  detail: { color: colors.faint, fontSize: 11 },
  button: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
  },
  buttonText: { color: colors.accent, fontSize: font.small, fontWeight: '600' },
  pressed: { opacity: 0.8 },
});
