/**
 * The one hook the screens use to reach a server.
 *
 * It composes the settings with the route that connectivity picked (so a screen never deals with
 * routes at all — the lesson the 0.3.0 change already taught) and hands back the surface-agnostic
 * `Backend`. Memoised on `[settings, activeUrl]` on purpose: a fresh backend object every render
 * would restart every effect that depends on it.
 */

import { useMemo } from 'react';

import { createBackend, type Backend } from './api/backend';
import { useActiveUrl } from './ConnectivityContext';
import { settingsForRoute } from './settings';
import { useSettings } from './SettingsContext';

export function useBackend(): { backend: Backend; ready: boolean } {
  const { settings, ready } = useSettings();
  const activeUrl = useActiveUrl();

  const backend = useMemo(
    () => createBackend(settingsForRoute(settings, activeUrl)),
    [settings, activeUrl],
  );

  return { backend, ready };
}
