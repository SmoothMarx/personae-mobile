import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SettingsProvider } from '../src/SettingsContext';
import { ConnectivityProvider } from '../src/ConnectivityContext';
import { t } from '../src/i18n';
import { colors, font } from '../src/theme';

export default function RootLayout() {
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
