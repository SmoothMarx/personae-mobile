/**
 * Settings context: one loaded copy of the settings, shared by every screen.
 *
 * Saving is field-level (pedro-app-defaults: single-field settings save themselves, no Save
 * button). The context exposes the *saved* values plus a `dirty` flag so a screen can show what is
 * in effect versus what is being typed.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_LANGUAGE, useLanguage, type Language } from './i18n';
import { DEFAULT_SETTINGS, type Settings } from './settings';
import { loadSettings, saveSettings } from './settingsStore';

type SettingsContextValue = {
  settings: Settings;
  ready: boolean;
  /**
   * The interface language in effect — 0.9.1 S4.1: always `DEFAULT_LANGUAGE` (English). It is exposed
   * because consumers re-render on it; nothing in the app can change it any more (the language field
   * and its segment control are gone, and no production module calls `setLanguage`).
   */
  language: Language;
  /** Timestamp of the last successful write to storage (null before the first one). */
  savedAt: number | null;
  /** Merge + persist in one call. Pass `{persist:false}` to stage a value without writing. */
  update: (patch: Partial<Settings>, options?: { persist?: boolean }) => void;
  reload: () => Promise<void>;
};

const SettingsContext = createContext<SettingsContextValue>({
  settings: DEFAULT_SETTINGS,
  ready: false,
  language: DEFAULT_LANGUAGE,
  savedAt: null,
  update: () => undefined,
  reload: async () => undefined,
});

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const latest = useRef(settings);
  // Subscribing here makes the provider (and so every useSettings() consumer) re-render on a switch.
  const language = useLanguage();

  useEffect(() => {
    let mounted = true;
    loadSettings().then((loaded) => {
      if (!mounted) return;
      // 0.9.1 S4.1: no `setLanguage(loaded.language)` here any more. Nothing reads a stored language,
      // so the app stays on `DEFAULT_LANGUAGE` (English) for its whole life.
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
    () => ({ settings, ready, language, savedAt, update, reload }),
    [settings, ready, language, savedAt, update, reload],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  return useContext(SettingsContext);
}
