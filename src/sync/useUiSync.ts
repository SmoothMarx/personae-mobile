/**
 * React glue for the options-sync client (src/sync/uiSync.ts): one instance per (address, key),
 * started once the roster prefs are loaded. The sync never blocks the roster: every failure leaves
 * the phone exactly where 0.5.0 was — local-only.
 */
import { useEffect, useRef, useState } from 'react';
import type { RosterPrefs } from '../rosterPrefs';
import { normalizeSections } from '../logic/sections';
import { normalizeColours } from '../rosterPrefs';
import { storeGet, storeSet } from '../storage';
import { createUiSync, httpRemote, type Obj, type SyncKey, type SyncMeta, type SyncStatus, type UiSync } from './uiSync';

export const SYNC_META_STORE_KEY = 'personae.sync.meta.v1';

/** The two shared keys the phone renders, read out of the roster prefs. */
export function sharedFromPrefs(prefs: RosterPrefs): Record<SyncKey, Obj> {
  return { 'sections-v1': prefs.sections as unknown as Obj, 'session-colors-v1': prefs.colours.sessions as Obj };
}

/** Apply a server value to the prefs, through the same normalisers a local load uses. */
export function applyShared(prefs: RosterPrefs, key: SyncKey, value: Obj): RosterPrefs {
  if (key === 'sections-v1') return { ...prefs, sections: normalizeSections(value) };
  const colours = normalizeColours({ ...prefs.colours, sessions: value });
  return { ...prefs, colours: { ...prefs.colours, sessions: colours.sessions } };
}

export function useUiSync(opts: {
  enabled: boolean;
  baseUrl: string;
  token: string;
  prefsReady: boolean;
  prefs: RosterPrefs;
  onRemote: (key: SyncKey, value: Obj) => void;
}): { sync: React.MutableRefObject<UiSync | null>; status: SyncStatus } {
  const sync = useRef<UiSync | null>(null);
  const [status, setStatus] = useState<SyncStatus>('idle');
  const prefsRef = useRef(opts.prefs);
  prefsRef.current = opts.prefs;
  const onRemoteRef = useRef(opts.onRemote);
  onRemoteRef.current = opts.onRemote;

  useEffect(() => {
    if (!opts.enabled || !opts.prefsReady || !opts.baseUrl || !opts.token) return;
    const instance = createUiSync({
      remote: httpRemote(opts.baseUrl, opts.token),
      loadMeta: async () => {
        const raw = await storeGet(SYNC_META_STORE_KEY);
        try {
          return raw ? (JSON.parse(raw) as SyncMeta) : null;
        } catch {
          return null;
        }
      },
      saveMeta: (meta) => storeSet(SYNC_META_STORE_KEY, JSON.stringify(meta)),
      onRemote: (key, value) => onRemoteRef.current(key, value),
    });
    sync.current = instance;
    void instance.start(sharedFromPrefs(prefsRef.current)).then(setStatus).catch(() => setStatus('offline'));
    return () => {
      instance.dispose();
      if (sync.current === instance) sync.current = null;
    };
  }, [opts.enabled, opts.prefsReady, opts.baseUrl, opts.token]);

  return { sync, status };
}
