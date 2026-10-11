/**
 * Settings context: one loaded copy of the settings, shared by every screen.
 *
 * Saving is field-level (pedro-app-defaults: single-field settings save themselves, no Save
 * button). The context exposes the *saved* values plus a `dirty` flag so a screen can show what is
 * in effect versus what is being typed.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_SETTINGS, type Settings } from './settings';
import { loadSettings, saveSettings } from './settingsStore';

type SettingsContextValue = {
  settings: Settings;
  ready: boolean;
  /** Timestamp of the last successful write to storage (null before the first one). */
  savedAt: number | null;
  /** Merge + persist in one call. Pass `{persist:false}` to stage a value without writing. */
  update: (patch: Partial<Settings>, options?: { persist?: boolean }) => void;
  reload: () => Promise<void>;
};

const SettingsContext = createContext<SettingsContextValue>({
  settings: DEFAULT_SETTINGS,
  ready: false,
  savedAt: null,
  update: () => undefined,
  reload: async () => undefined,
});

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const latest = useRef(settings);

  useEffect(() => {
    let mounted = true;
    loadSettings().then((loaded) => {
      if (!mounted) return;
      latest.current = loaded;
      setSettings(loaded);
      setReady(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const update = useCallback((patch: Partial<Settings>, options?: { persist?: boolean }) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setSettings(next);
    if (options?.persist === false) return;
    void saveSettings(next).then(() => setSavedAt(Date.now()));
  }, []);

  const reload = useCallback(async () => {
    const loaded = await loadSettings();
    latest.current = loaded;
    setSettings(loaded);
    setSavedAt(Date.now());
  }, []);

  const value = useMemo(
    () => ({ settings, ready, savedAt, update, reload }),
    [settings, ready, savedAt, update, reload],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  return useContext(SettingsContext);
}
