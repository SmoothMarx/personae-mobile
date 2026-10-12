import { Stack, usePathname, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useMemo } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SettingsProvider } from '../src/SettingsContext';
import { ConnectivityProvider } from '../src/ConnectivityContext';
import { ensureChannel, installHandler, onResponse } from '../src/notifications';
import { useCheckpoints } from '../src/useCheckpoints';
import { t, useLanguage } from '../src/i18n';
import { colors, font } from '../src/theme';

/**
 * 0.8.0 H — the checkpoint notifications' app-side wiring, mounted exactly once.
 *
 * Three things happen here and nowhere else:
 *  1. the presentation handler and the Android channel are created (no permission is asked for);
 *  2. tapping a notification opens that session — `router.push('/thread/<id>')`;
 *  3. the foreground-only watcher runs, via `useCheckpoints`, which reads the settings and the
 *     permission and decides for itself whether anything should poll at all.
 *
 * It sits INSIDE the providers because the watcher needs the settings and the active route, and it
 * renders nothing.
 */
function Checkpoints() {
  const router = useRouter();
  const pathname = usePathname();
  /** The thread on screen, so a checkpoint for it is never announced to the person reading it. */
  const openThreadId = useMemo(() => {
    const match = /^\/thread\/([^/?#]+)/.exec(pathname ?? '');
    return match ? decodeURIComponent(match[1]) : null;
  }, [pathname]);

  useCheckpoints({ openThreadId });

  useEffect(() => {
    installHandler();
    void ensureChannel();
    return onResponse((sessionId, profile) => {
      router.push({ pathname: '/thread/[id]', params: { id: sessionId, profile } });
    });
  }, [router]);

  return null;
}

export default function RootLayout() {
  // Re-render on a language switch so the header titles below follow it; screens re-render through
  // SettingsContext (its value carries the language) and their own useLanguage().
  useLanguage();
  return (
    <SafeAreaProvider>
      <SettingsProvider>
        <ConnectivityProvider>
          <StatusBar style="light" />
          <Checkpoints />
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: colors.panel },
              headerTitleStyle: { color: colors.text, fontSize: font.title },
              headerTintColor: colors.accent,
              contentStyle: { backgroundColor: colors.bg },
            }}
          >
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="thread/[id]" options={{ title: t.roster.sessions }} />
            <Stack.Screen name="settings" options={{ title: t.settings.title }} />
            <Stack.Screen name="connect" options={{ title: t.connect.title }} />
          </Stack>
        </ConnectivityProvider>
      </SettingsProvider>
    </SafeAreaProvider>
  );
}
