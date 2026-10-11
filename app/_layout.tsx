import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SettingsProvider } from '../src/SettingsContext';
import { ConnectivityProvider } from '../src/ConnectivityContext';
import { t, useLanguage } from '../src/i18n';
import { colors, font } from '../src/theme';

export default function RootLayout() {
  // Re-render on a language switch so the header titles below follow it; screens re-render through
  // SettingsContext (its value carries the language) and their own useLanguage().
  useLanguage();
  return (
    <SafeAreaProvider>
      <SettingsProvider>
        <ConnectivityProvider>
          <StatusBar style="light" />
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
          </Stack>
        </ConnectivityProvider>
      </SettingsProvider>
    </SafeAreaProvider>
  );
}
